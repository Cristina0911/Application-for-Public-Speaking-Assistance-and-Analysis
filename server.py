"""Server SpeakCoach: servește pagina și gestionează conturile (SQLite)."""
import hashlib
import hmac
import json
import os
import queue
import re
import secrets
import shutil
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs

import uvicorn
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field

import analysis
import analysis_video

BASE = Path(__file__).parent
DB_PATH = BASE / "speakcoach.db"
COOKIE = "sc_session"
SESSION_DAYS = 30
# Client ID de la Google: se citește din fișierul google_client_id.txt (lângă server.py)
# sau din variabila de mediu GOOGLE_CLIENT_ID.
_cid_file = BASE / "google_client_id.txt"
GOOGLE_CLIENT_ID = (
    os.environ.get("GOOGLE_CLIENT_ID")
    or (_cid_file.read_text(encoding="utf-8").strip() if _cid_file.exists() else "")
    or "PUNE_AICI_CLIENT_ID.apps.googleusercontent.com"
)
GOOGLE_ENABLED = GOOGLE_CLIENT_ID.endswith(".apps.googleusercontent.com") and not GOOGLE_CLIENT_ID.startswith("PUNE_AICI")
UPLOAD_DIR = BASE / "uploads"
MAX_SLIDES = 50 * 1024 * 1024
MAX_RECORDING = 500 * 1024 * 1024
VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".avi"}
SLIDE_EXT = {".pptx", ".ppt", ".pdf", ".docx", ".doc", ".txt", ".odp"}
REC_TYPES = {
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

app = FastAPI()


# ---------- baza de date ----------
@contextmanager
def conn():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init_db():
    with conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS presentations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                slides_name TEXT NOT NULL,
                slides_file TEXT NOT NULL,
                slides_size INTEGER NOT NULL,
                rec_name TEXT NOT NULL,
                rec_file TEXT NOT NULL,
                rec_size INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            );
            """
        )
        # coloană nouă pentru conturile Google (și pentru bazele de date create înainte)
        cols = [r["name"] for r in c.execute("PRAGMA table_info(users)")]
        if "google_sub" not in cols:
            c.execute("ALTER TABLE users ADD COLUMN google_sub TEXT")
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users(google_sub)")
        pcols = [r["name"] for r in c.execute("PRAGMA table_info(presentations)")]
        for col, ddl in (("language", "TEXT NOT NULL DEFAULT 'ro'"), ("status", "TEXT NOT NULL DEFAULT 'uploaded'"),
                         ("error", "TEXT"), ("result", "TEXT")):
            if col not in pcols:
                c.execute(f"ALTER TABLE presentations ADD COLUMN {col} {ddl}")
        # joburi rămase neterminate dacă serverul s-a oprit: le putem relua cu „Analizează"
        c.execute("UPDATE presentations SET status = 'uploaded' WHERE status IN ('queued', 'processing')")


init_db()


# ---------- parole ----------
def hash_password(password: str) -> str:
    salt = os.urandom(16)
    h = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return salt.hex() + "$" + h.hex()


def verify_password(password: str, stored: str) -> bool:
    salt_hex, hash_hex = stored.split("$")
    h = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1)
    return hmac.compare_digest(h.hex(), hash_hex)


DUMMY_HASH = hash_password("parola-falsa")  # ca să dureze la fel și când emailul nu există


# ---------- sesiuni ----------
def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def start_session(response: Response, user_id: int):
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    with conn() as c:
        c.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (token_hash(token), user_id, expires.isoformat()),
        )
    response.set_cookie(
        COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax"
    )


def current_user(request: Request):
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    with conn() as c:
        row = c.execute(
            """SELECT u.id, u.name, u.email, s.expires_at
               FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token_hash = ?""",
            (token_hash(token),),
        ).fetchone()
    if not row or datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc):
        return None
    return row


def public(row):
    return {"name": row["name"], "email": row["email"]}


# ---------- API ----------
class RegisterIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    email: str = Field(max_length=254)
    password: str = Field(min_length=6, max_length=128)


class LoginIn(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=128)


@app.post("/api/register", status_code=201)
def register(data: RegisterIn, response: Response):
    email = data.email.strip().lower()
    name = data.name.strip()
    if not name:
        raise HTTPException(400, "Scrie-ți numele.")
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Adresa de email nu este validă.")
    now = datetime.now(timezone.utc).isoformat()
    try:
        with conn() as c:
            cur = c.execute(
                "INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
                (name, email, hash_password(data.password), now),
            )
            user_id = cur.lastrowid
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Există deja un cont cu acest email.")
    start_session(response, user_id)
    return {"user": {"name": name, "email": email}}


@app.post("/api/login")
def login(data: LoginIn, response: Response):
    email = data.email.strip().lower()
    with conn() as c:
        row = c.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if row and "$" not in row["password_hash"]:
        raise HTTPException(401, "Acest cont folosește Google. Apasă pe butonul „Continuă cu Google”.")
    ok = verify_password(data.password, row["password_hash"] if row else DUMMY_HASH)
    if not row or not ok:
        raise HTTPException(401, "Email sau parolă greșite.")
    start_session(response, row["id"])
    return {"user": public(row)}


class GoogleIn(BaseModel):
    credential: str = Field(max_length=4096)


@app.get("/api/config")
def config():
    return {"google_client_id": GOOGLE_CLIENT_ID if GOOGLE_ENABLED else None}


def google_user(credential: str):
    """Verifică tokenul Google și întoarce utilizatorul din baza de date (îl creează dacă lipsește)."""
    if not GOOGLE_ENABLED:
        raise HTTPException(503, "Conectarea cu Google nu este configurată pe server.")
    try:
        info = google_id_token.verify_oauth2_token(
            credential, google_requests.Request(), GOOGLE_CLIENT_ID, clock_skew_in_seconds=10
        )
    except ValueError:
        raise HTTPException(401, "Nu am putut verifica contul Google. Încearcă din nou.")
    except Exception:
        raise HTTPException(503, "Serverul nu a putut contacta Google. Verifică conexiunea la internet.")
    if not info.get("email_verified"):
        raise HTTPException(401, "Adresa de email Google nu este verificată.")
    sub = info["sub"]
    email = info["email"].strip().lower()
    name = (info.get("name") or email.split("@")[0]).strip()[:80]
    now = datetime.now(timezone.utc).isoformat()
    with conn() as c:
        row = c.execute("SELECT * FROM users WHERE google_sub = ?", (sub,)).fetchone()
        if not row:
            row = c.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
            if row:  # există deja un cont cu acest email: îl legăm de Google
                c.execute("UPDATE users SET google_sub = ? WHERE id = ?", (sub, row["id"]))
            else:  # cont nou; parola "!" nu poate fi potrivită cu nicio parolă
                cur = c.execute(
                    "INSERT INTO users (name, email, password_hash, created_at, google_sub) VALUES (?, ?, ?, ?, ?)",
                    (name, email, "!", now, sub),
                )
                row = c.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    return row


@app.post("/api/google")
def google_login(data: GoogleIn, response: Response):
    row = google_user(data.credential)
    start_session(response, row["id"])
    return {"user": public(row)}


@app.post("/api/google-redirect")
async def google_redirect(request: Request):
    """Google trimite aici utilizatorul după autentificare (fără fereastră pop-up)."""
    form = parse_qs((await request.body()).decode("utf-8", "ignore"))
    credential = form.get("credential", [""])[0]
    csrf_body = form.get("g_csrf_token", [""])[0]
    csrf_cookie = request.cookies.get("g_csrf_token", "")
    if not csrf_cookie or not hmac.compare_digest(csrf_cookie, csrf_body):
        return RedirectResponse("/?google=eroare", status_code=303)
    try:
        row = google_user(credential)
    except HTTPException:
        return RedirectResponse("/?google=eroare", status_code=303)
    response = RedirectResponse("/", status_code=303)
    start_session(response, row["id"])
    return response


@app.post("/api/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        with conn() as c:
            c.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    user = current_user(request)
    return {"user": public(user) if user else None}


# ---------- analiza (rulează în fundal, câte o prezentare pe rând) ----------
JOBS: "queue.Queue[int]" = queue.Queue()
PROGRESS: dict = {}


def set_status(pid, status, error=None, result=None):
    with conn() as c:
        if result is not None:
            c.execute("UPDATE presentations SET status = ?, error = ?, result = ? WHERE id = ?",
                      (status, error, json.dumps(result, ensure_ascii=False), pid))
        else:
            c.execute("UPDATE presentations SET status = ?, error = ? WHERE id = ?", (status, error, pid))


def friendly_error(e: Exception) -> str:
    if isinstance(e, ImportError):
        return "Lipsește biblioteca faster-whisper. Rulează „pip install -r requirements.txt” și repornește serverul."
    if isinstance(e, FileNotFoundError):
        return "Fișierul înregistrării nu mai există."
    return "Analiza nu a reușit: " + (str(e)[:200] or e.__class__.__name__)


def video_error(e: Exception) -> str:
    if isinstance(e, ImportError):
        return "Lipsește biblioteca MediaPipe. Rulează „python -m pip install -r requirements.txt” și repornește serverul."
    return "Analiza video nu a reușit: " + (str(e)[:250] or e.__class__.__name__)


def run_analysis(pid: int):
    with conn() as c:
        row = c.execute("SELECT * FROM presentations WHERE id = ?", (pid,)).fetchone()
    if not row:
        return
    set_status(pid, "processing")
    PROGRESS[pid] = 0.0
    try:
        path = UPLOAD_DIR / str(row["user_id"]) / row["rec_file"]
        if not path.exists():
            raise FileNotFoundError(path)
        has_video = path.suffix.lower() in VIDEO_EXT
        scale = 0.75 if has_video else 1.0  # transcrierea = 75% din progres dacă urmează și analiza video
        words, segs, lang, duration = analysis.transcribe(
            path, row["language"], lambda p: PROGRESS.__setitem__(pid, p * scale)
        )
        result = analysis.compute(words, segs, lang, duration)
        if has_video:
            PROGRESS[pid] = 0.75
            try:  # dacă analiza video eșuează, raportul de vorbire rămâne valabil
                result["video"] = analysis_video.analyze(
                    path, lambda p: PROGRESS.__setitem__(pid, 0.75 + p * 0.25)
                )
            except Exception as e:
                print("Eroare la analiza video:", repr(e))
                result["video"] = {"available": False, "error": video_error(e)}
        else:
            result["video"] = {"available": False, "reason": "audio"}
        set_status(pid, "done", None, result)
    except Exception as e:  # orice eroare ajunge ca mesaj în pagină, nu doar în terminal
        print("Eroare la analiză:", repr(e))
        set_status(pid, "error", friendly_error(e))
    finally:
        PROGRESS.pop(pid, None)


def worker():
    while True:
        pid = JOBS.get()
        try:
            run_analysis(pid)
        except Exception as e:
            print("Eroare în worker:", repr(e))


threading.Thread(target=worker, daemon=True).start()


# ---------- prezentări (încărcare fișiere) ----------
def require_user(request: Request):
    user = current_user(request)
    if not user:
        raise HTTPException(401, "Trebuie să fii autentificată.")
    return user


def save_upload(f: UploadFile, folder: Path, allowed, limit: int, label: str):
    name = Path((f.filename or "").replace("\\", "/")).name[:150]
    ext = Path(name).suffix.lower()
    if ext not in allowed:
        raise HTTPException(400, f"{label}: format neacceptat ({ext or 'fără extensie'}).")
    if f.size is not None and f.size > limit:
        raise HTTPException(413, f"{label}: fișierul e prea mare (maxim {limit // 1024 // 1024} MB).")
    folder.mkdir(parents=True, exist_ok=True)
    stored = uuid.uuid4().hex + ext
    with open(folder / stored, "wb") as out:
        shutil.copyfileobj(f.file, out)
    size = (folder / stored).stat().st_size
    if size == 0:
        (folder / stored).unlink(missing_ok=True)
        raise HTTPException(400, f"{label}: fișierul este gol.")
    return name, stored, size


def pres_json(r):
    return {
        "id": r["id"], "title": r["title"], "created_at": r["created_at"],
        "slides_name": r["slides_name"], "slides_size": r["slides_size"],
        "rec_name": r["rec_name"], "rec_size": r["rec_size"],
        "language": r["language"], "status": r["status"], "error": r["error"],
        "progress": round(PROGRESS.get(r["id"], 0.0), 3),
        "rec_kind": "audio" if REC_TYPES.get(Path(r["rec_file"]).suffix, "").startswith("audio") else "video",
    }


def own_presentation(request: Request, pid: int):
    user = require_user(request)
    with conn() as c:
        row = c.execute("SELECT * FROM presentations WHERE id = ? AND user_id = ?", (pid, user["id"])).fetchone()
    if not row:
        raise HTTPException(404, "Prezentarea nu a fost găsită.")
    return user, row


@app.post("/api/presentations", status_code=201)
def create_presentation(
    request: Request,
    title: str = Form(""),
    language: str = Form("ro"),
    slides: UploadFile = File(...),
    recording: UploadFile = File(...),
):
    user = require_user(request)
    if language not in ("ro", "en", "auto"):
        raise HTTPException(400, "Limba aleasă nu este validă.")
    folder = UPLOAD_DIR / str(user["id"])
    saved = []
    try:
        s_name, s_file, s_size = save_upload(slides, folder, SLIDE_EXT, MAX_SLIDES, "Prezentarea")
        saved.append(folder / s_file)
        r_name, r_file, r_size = save_upload(recording, folder, set(REC_TYPES), MAX_RECORDING, "Înregistrarea")
        saved.append(folder / r_file)
        title = title.strip()[:120] or Path(s_name).stem[:120] or "Prezentare"
        now = datetime.now(timezone.utc).isoformat()
        with conn() as c:
            cur = c.execute(
                """INSERT INTO presentations (user_id, title, slides_name, slides_file, slides_size,
                   rec_name, rec_file, rec_size, created_at, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (user["id"], title, s_name, s_file, s_size, r_name, r_file, r_size, now, language),
            )
            row = c.execute("SELECT * FROM presentations WHERE id = ?", (cur.lastrowid,)).fetchone()
    except Exception:
        for p in saved:  # nu lăsăm fișiere orfane dacă ceva a eșuat
            p.unlink(missing_ok=True)
        raise
    return {"presentation": pres_json(row)}


@app.get("/api/presentations")
def list_presentations(request: Request):
    user = require_user(request)
    with conn() as c:
        rows = c.execute(
            "SELECT * FROM presentations WHERE user_id = ? ORDER BY id DESC", (user["id"],)
        ).fetchall()
    return {"presentations": [pres_json(r) for r in rows]}


@app.delete("/api/presentations/{pid}")
def delete_presentation(pid: int, request: Request):
    user, row = own_presentation(request, pid)
    folder = UPLOAD_DIR / str(user["id"])
    (folder / row["slides_file"]).unlink(missing_ok=True)
    (folder / row["rec_file"]).unlink(missing_ok=True)
    with conn() as c:
        c.execute("DELETE FROM presentations WHERE id = ?", (pid,))
    return {"ok": True}


@app.post("/api/presentations/{pid}/analyze")
def analyze_presentation(pid: int, request: Request):
    _, row = own_presentation(request, pid)
    if row["status"] in ("queued", "processing"):
        raise HTTPException(409, "Analiza este deja în curs.")
    set_status(pid, "queued")
    PROGRESS[pid] = 0.0
    JOBS.put(pid)
    with conn() as c:
        row = c.execute("SELECT * FROM presentations WHERE id = ?", (pid,)).fetchone()
    return {"presentation": pres_json(row)}


@app.get("/api/presentations/{pid}/analysis")
def get_analysis(pid: int, request: Request):
    _, row = own_presentation(request, pid)
    if row["status"] != "done" or not row["result"]:
        raise HTTPException(409, "Raportul nu este gata încă.")
    return {"title": row["title"], "result": json.loads(row["result"])}


@app.get("/api/presentations/{pid}/recording")
def get_recording(pid: int, request: Request):
    user, row = own_presentation(request, pid)
    path = UPLOAD_DIR / str(user["id"]) / row["rec_file"]
    if not path.exists():
        raise HTTPException(404, "Fișierul nu mai există.")
    return FileResponse(path, media_type=REC_TYPES.get(path.suffix, "application/octet-stream"),
                        headers={"X-Content-Type-Options": "nosniff"})


@app.get("/api/presentations/{pid}/slides")
def get_slides(pid: int, request: Request):
    user, row = own_presentation(request, pid)
    path = UPLOAD_DIR / str(user["id"]) / row["slides_file"]
    if not path.exists():
        raise HTTPException(404, "Fișierul nu mai există.")
    return FileResponse(path, filename=row["slides_name"], content_disposition_type="attachment",
                        headers={"X-Content-Type-Options": "nosniff"})


# ---------- pagina (doar aceste fișiere sunt publice) ----------
@app.get("/")
def index():
    return FileResponse(BASE / "index.html")


@app.get("/app.js")
def app_js():
    return FileResponse(BASE / "app.js")


@app.get("/live.js")
def live_js():
    return FileResponse(BASE / "live.js")


@app.get("/style.css")
def style():
    return FileResponse(BASE / "style.css")


if __name__ == "__main__":
    print("Deschide în browser: http://localhost:8000")
    uvicorn.run(app, host="127.0.0.1", port=8000)