"""Server SpeakCoach: servește pagina și gestionează conturile (SQLite)."""
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs

import uvicorn
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field

BASE = Path(__file__).parent
DB_PATH = BASE / "speakcoach.db"
COOKIE = "sc_session"
SESSION_DAYS = 30
# Client ID de la Google (vezi instrucțiunile). Poate fi pus și ca variabilă de mediu GOOGLE_CLIENT_ID.
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "547862249138-4lmlsbul3tnpvd6ro7kv3vb1l8vq66qb.apps.googleusercontent.com")
GOOGLE_ENABLED = GOOGLE_CLIENT_ID.endswith(".apps.googleusercontent.com") and not GOOGLE_CLIENT_ID.startswith("PUNE_AICI")
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


# ---------- pagina (doar aceste două fișiere sunt publice) ----------
@app.get("/")
def index():
    return FileResponse(BASE / "index.html")


@app.get("/style.css")
def style():
    return FileResponse(BASE / "style.css")


if __name__ == "__main__":
    print("Deschide în browser: http://localhost:8000")
    uvicorn.run(app, host="127.0.0.1", port=8000)