from __future__ import annotations

import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import psycopg
from fastapi import FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from jose import JWTError, jwt
from pwdlib import PasswordHash
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

ROOT_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT_DIR / "frontend"

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
JWT_SECRET = os.getenv("JWT_SECRET", "helpdesk-oneid-shared-secret-2026")
password_hash = PasswordHash.recommended()

app = FastAPI(title="ONEID HELPDESK", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def no_cache_static(request, call_next):
    response = await call_next(request)
    if request.url.path.endswith((".html", ".js", ".css")) or request.url.path == "/":
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


def get_connection():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not configured.")
    return psycopg.connect(
        DATABASE_URL,
        connect_timeout=10,
        row_factory=dict_row,
    )


def init_db() -> None:
    if not DATABASE_URL:
        return
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS oneid_support_tickets (
                    ticket_id SERIAL PRIMARY KEY,
                    user_id TEXT,
                    username TEXT NOT NULL,
                    username_normalized TEXT NOT NULL,
                    nickname TEXT NOT NULL,
                    category TEXT NOT NULL DEFAULT 'inquiry',
                    service_name TEXT NOT NULL DEFAULT 'ONEID',
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    lookup_pin_hash TEXT,
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'in_progress', 'resolved', 'rejected')),
                    admin_reply TEXT,
                    replied_by TEXT,
                    replied_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_support_tickets_username
                ON oneid_support_tickets (username_normalized)
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id
                ON oneid_support_tickets (user_id)
                """
            )


@app.on_event("startup")
def on_startup() -> None:
    try:
        init_db()
    except Exception as exc:
        print("DB init warning:", exc)


def hash_pin(pin: str) -> str:
    return hashlib.sha256(f"helpdesk-pin:{pin.strip()}".encode("utf-8")).hexdigest()


def verify_pin(pin: str, pin_hash: str | None) -> bool:
    if not pin_hash:
        return False
    return hmac.compare_digest(hash_pin(pin), pin_hash)


def issue_token(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": user_id,
            "iat": now,
            "exp": now + timedelta(hours=12),
            "iss": "oneid-helpdesk",
        },
        JWT_SECRET,
        algorithm="HS256",
    )


def serialize_user(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["user_id"],
        "username": row["username"],
        "nickname": row["nickname"],
        "role": row["role"],
        "is_admin": row["role"] == "admin",
        "global_suspended": bool(row.get("global_suspended")),
        "suspension_reason": row.get("suspension_reason"),
    }


def get_optional_user(authorization: str | None) -> dict[str, Any] | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        return None
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except JWTError:
        return None
    user_id = payload.get("sub")
    if not user_id:
        return None
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM oneid_users WHERE user_id = %s",
            (str(user_id),),
        ).fetchone()
    if not row:
        return None
    return serialize_user(row)


def require_user(authorization: str | None) -> dict[str, Any]:
    user = get_optional_user(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    return user


def require_admin(authorization: str | None) -> dict[str, Any]:
    user = require_user(authorization)
    if not user["is_admin"]:
        raise HTTPException(status_code=403, detail="총괄관리자 권한이 필요합니다.")
    return user


def serialize_ticket(row: dict[str, Any], include_admin_meta: bool = False) -> dict[str, Any]:
    item = {
        "ticket_id": row["ticket_id"],
        "user_id": row.get("user_id"),
        "username": row["username"],
        "nickname": row["nickname"],
        "category": row["category"],
        "service_name": row["service_name"],
        "title": row["title"],
        "content": row["content"],
        "status": row["status"],
        "admin_reply": row.get("admin_reply"),
        "replied_by": row.get("replied_by"),
        "replied_at": row["replied_at"].isoformat() if row.get("replied_at") else None,
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
        "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else None,
    }
    if include_admin_meta:
        item["account_exists"] = bool(row.get("account_user_id"))
        item["account_user_id"] = row.get("account_user_id")
        item["account_suspended"] = bool(row.get("account_suspended"))
        item["account_suspension_reason"] = row.get("account_suspension_reason")
        item["account_role"] = row.get("account_role")
    return item


class LoginInput(BaseModel):
    username: str = Field(min_length=2, max_length=32)
    password: str = Field(min_length=1, max_length=128)


class TicketCreateInput(BaseModel):
    category: Literal["appeal", "bug", "suggestion", "inquiry", "idea"] = "inquiry"
    service_name: str = Field(default="ONEID", min_length=1, max_length=40)
    title: str = Field(min_length=2, max_length=120)
    content: str = Field(min_length=5, max_length=4000)
    username: str | None = Field(default=None, max_length=32)
    nickname: str | None = Field(default=None, max_length=20)
    lookup_pin: str | None = Field(default=None, max_length=32)


class TicketLookupInput(BaseModel):
    username: str = Field(min_length=2, max_length=32)
    lookup_pin: str = Field(min_length=4, max_length=32)


class AdminReplyInput(BaseModel):
    status: Literal["pending", "in_progress", "resolved", "rejected"] = "resolved"
    admin_reply: str = Field(default="", max_length=4000)
    unsuspend_account: bool = False


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "oneid-helpdesk"}


@app.post("/api/auth/login")
def login(payload: LoginInput) -> dict[str, Any]:
    normalized = payload.username.strip().casefold()
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM oneid_users WHERE username_normalized = %s",
            (normalized,),
        ).fetchone()

    if not row or not password_hash.verify(payload.password, row["password_hash"]):
        raise HTTPException(
            status_code=401,
            detail="ONEID 사용자명 또는 비밀번호가 올바르지 않습니다.",
        )

    # Note: Suspended users are allowed to log into Helpdesk so they can
    # view their suspension reason and submit/check their appeal!
    user = serialize_user(row)
    return {
        "access_token": issue_token(row["user_id"]),
        "user": user,
    }


@app.get("/api/auth/me")
def me(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    return require_user(authorization)


@app.post("/api/tickets", status_code=status.HTTP_201_CREATED)
def create_ticket(
    payload: TicketCreateInput,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user = get_optional_user(authorization)
    title = payload.title.strip()
    content = payload.content.strip()
    service_name = payload.service_name.strip() or "ONEID"

    if len(title) < 2:
        raise HTTPException(status_code=422, detail="제목을 2자 이상 입력해 주세요.")
    if len(content) < 5:
        raise HTTPException(status_code=422, detail="문의 내용을 5자 이상 입력해 주세요.")

    pin_hash: str | None = None
    if payload.lookup_pin and payload.lookup_pin.strip():
        pin_clean = payload.lookup_pin.strip()
        if len(pin_clean) < 4:
            raise HTTPException(status_code=422, detail="조회 비밀번호는 4자 이상이어야 합니다.")
        pin_hash = hash_pin(pin_clean)

    if user:
        user_id = user["id"]
        username = user["username"]
        username_norm = username.casefold()
        nickname = user["nickname"]
    else:
        raw_username = (payload.username or "").strip()
        if len(raw_username) < 2:
            raise HTTPException(
                status_code=422,
                detail="비로그인 문의 시 ONEID 아이디(또는 문의자명)를 2자 이상 입력해 주세요.",
            )
        if not pin_hash:
            raise HTTPException(
                status_code=422,
                detail="비로그인 문의 시 답변 확인을 위한 조회 비밀번호(4자 이상)를 입력해 주세요.",
            )
        username = raw_username
        username_norm = raw_username.casefold()
        nickname = (payload.nickname or "").strip() or raw_username
        user_id = None

        # Link user_id automatically if the username matches an existing ONEID account
        with get_connection() as conn:
            found = conn.execute(
                "SELECT user_id, nickname FROM oneid_users WHERE username_normalized = %s",
                (username_norm,),
            ).fetchone()
            if found:
                user_id = found["user_id"]
                if not (payload.nickname or "").strip():
                    nickname = found["nickname"]

    with get_connection() as conn:
        row = conn.execute(
            """
            INSERT INTO oneid_support_tickets (
                user_id, username, username_normalized, nickname,
                category, service_name, title, content, lookup_pin_hash
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
            """,
            (
                user_id,
                username,
                username_norm,
                nickname,
                payload.category,
                service_name,
                title,
                content,
                pin_hash,
            ),
        ).fetchone()

    return {
        "message": f"문의가 정상적으로 접수되었습니다. (접수번호 #{row['ticket_id']})",
        "ticket": serialize_ticket(row),
    }


@app.get("/api/tickets/my")
def my_tickets(authorization: str | None = Header(default=None)) -> list[dict[str, Any]]:
    user = require_user(authorization)
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM oneid_support_tickets
            WHERE user_id = %s OR username_normalized = %s
            ORDER BY created_at DESC
            """,
            (user["id"], user["username"].casefold()),
        ).fetchall()
    return [serialize_ticket(r) for r in rows]


@app.post("/api/tickets/lookup")
def lookup_tickets(payload: TicketLookupInput) -> list[dict[str, Any]]:
    username_norm = payload.username.strip().casefold()
    pin = payload.lookup_pin.strip()

    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM oneid_support_tickets
            WHERE username_normalized = %s
            ORDER BY created_at DESC
            """,
            (username_norm,),
        ).fetchall()

    matched = [
        serialize_ticket(r)
        for r in rows
        if verify_pin(pin, r.get("lookup_pin_hash"))
    ]
    if not matched:
        raise HTTPException(
            status_code=404,
            detail="일치하는 문의 내역이 없거나 조회 비밀번호가 올바르지 않습니다.",
        )
    return matched


@app.get("/api/admin/tickets")
def admin_list_tickets(
    authorization: str | None = Header(default=None),
) -> list[dict[str, Any]]:
    require_admin(authorization)
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT
                t.*,
                u.user_id AS account_user_id,
                u.global_suspended AS account_suspended,
                u.suspension_reason AS account_suspension_reason,
                u.role AS account_role
            FROM oneid_support_tickets t
            LEFT JOIN oneid_users u
              ON u.username_normalized = t.username_normalized
            ORDER BY
                CASE WHEN t.status = 'pending' THEN 0
                     WHEN t.status = 'in_progress' THEN 1
                     ELSE 2 END,
                t.created_at DESC
            """
        ).fetchall()
    return [serialize_ticket(r, include_admin_meta=True) for r in rows]


@app.patch("/api/admin/tickets/{ticket_id}")
def admin_reply_ticket(
    ticket_id: int,
    payload: AdminReplyInput,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    admin = require_admin(authorization)
    reply_text = payload.admin_reply.strip()
    now = datetime.now(timezone.utc)

    with get_connection() as conn:
        target = conn.execute(
            "SELECT * FROM oneid_support_tickets WHERE ticket_id = %s FOR UPDATE",
            (ticket_id,),
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="문의를 찾을 수 없습니다.")

        updated = conn.execute(
            """
            UPDATE oneid_support_tickets
            SET status = %s,
                admin_reply = %s,
                replied_by = %s,
                replied_at = %s,
                updated_at = %s
            WHERE ticket_id = %s
            RETURNING *
            """,
            (
                payload.status,
                reply_text if reply_text else None,
                admin["nickname"],
                now if reply_text else target.get("replied_at"),
                now,
                ticket_id,
            ),
        ).fetchone()

        if payload.unsuspend_account:
            conn.execute(
                """
                UPDATE oneid_users
                SET global_suspended = FALSE,
                    suspension_reason = NULL,
                    updated_at = NOW()
                WHERE username_normalized = %s
                """,
                (target["username_normalized"],),
            )

        enriched = conn.execute(
            """
            SELECT
                t.*,
                u.user_id AS account_user_id,
                u.global_suspended AS account_suspended,
                u.suspension_reason AS account_suspension_reason,
                u.role AS account_role
            FROM oneid_support_tickets t
            LEFT JOIN oneid_users u
              ON u.username_normalized = t.username_normalized
            WHERE t.ticket_id = %s
            """,
            (ticket_id,),
        ).fetchone()

    return {
        "message": "답변 및 상태가 저장되었습니다." + (" (계정 정지 해제 완료)" if payload.unsuspend_account else ""),
        "ticket": serialize_ticket(enriched or updated, include_admin_meta=True),
    }


@app.delete("/api/admin/tickets/{ticket_id}")
def admin_delete_ticket(
    ticket_id: int,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    require_admin(authorization)
    with get_connection() as conn:
        deleted = conn.execute(
            "DELETE FROM oneid_support_tickets WHERE ticket_id = %s RETURNING ticket_id",
            (ticket_id,),
        ).fetchone()
        if not deleted:
            raise HTTPException(status_code=404, detail="문의를 찾을 수 없습니다.")
    return {"deleted": True, "ticket_id": ticket_id}


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
