from __future__ import annotations

import os
from datetime import datetime, timedelta
from typing import Any

from jose import JWTError, jwt
from passlib.context import CryptContext

from .db import get_database_url

INSECURE_SECRET_KEYS = {"", "change-me", "change-me-test", "dev-secret"}
INSECURE_SECRET_KEY_ENV = "ALLOW_INSECURE_SECRET_KEY"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRES_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRES_MINUTES", "1440"))

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def get_secret_key() -> str:
    return os.getenv("SECRET_KEY", "dev-secret")


def allows_insecure_secret_key() -> bool:
    override = os.getenv(INSECURE_SECRET_KEY_ENV, "").strip().lower()
    if override in {"1", "true", "yes"}:
        return True
    if os.getenv("PYTEST_CURRENT_TEST"):
        return True
    environment = os.getenv("ENVIRONMENT", "").strip().lower()
    if environment in {"prod", "production"}:
        return False
    return get_database_url().startswith("sqlite")


def ensure_secret_key_is_safe(secret_key: str | None = None) -> str:
    candidate = (secret_key or get_secret_key()).strip()
    if candidate.lower() in INSECURE_SECRET_KEYS or len(candidate) < 32:
        if not allows_insecure_secret_key():
            raise RuntimeError(
                "SECRET_KEY must be set to a strong value with at least 32 characters. "
                "The built-in development defaults are only allowed for local SQLite development "
                f"or when {INSECURE_SECRET_KEY_ENV}=true is set explicitly."
            )
    return candidate


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(
    subject: str,
    *,
    expires_minutes: int | None = None,
    extra_claims: dict[str, Any] | None = None,
) -> str:
    expire = datetime.utcnow() + timedelta(minutes=expires_minutes or ACCESS_TOKEN_EXPIRES_MINUTES)
    payload: dict[str, Any] = {"sub": subject, "exp": expire}
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, ensure_secret_key_is_safe(), algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict[str, Any]:
    try:
        return jwt.decode(token, ensure_secret_key_is_safe(), algorithms=[ALGORITHM])
    except JWTError as exc:
        raise ValueError("Invalid token") from exc
