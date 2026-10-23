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

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

BASE = Path(__file__).parent
DB_PATH = BASE / "speakcoach.db"
COOKIE = "sc_session"
SESSION_DAYS = 30
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
    ok = verify_password(data.password, row["password_hash"] if row else DUMMY_HASH)
    if not row or not ok:
        raise HTTPException(401, "Email sau parolă greșite.")
    start_session(response, row["id"])
    return {"user": public(row)}


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