from __future__ import annotations

import os
from typing import Iterator

from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine

engine = None


def get_database_url() -> str:
    return os.getenv("DATABASE_URL", "sqlite:///./app.db")


def build_engine(database_url: str):
    connect_args: dict[str, object] = {}
    engine_kwargs: dict[str, object] = {"pool_pre_ping": True}

    if database_url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
        engine_kwargs.pop("pool_pre_ping", None)
        if database_url == "sqlite://":
            engine_kwargs["poolclass"] = StaticPool

    return create_engine(database_url, connect_args=connect_args, **engine_kwargs)


def configure_engine(database_url: str | None = None, *, force: bool = False):
    global engine

    if engine is not None and not force:
        return engine

    if engine is not None and force:
        engine.dispose()

    engine = build_engine(database_url or get_database_url())
    return engine


def get_engine():
    return configure_engine()


def init_db() -> None:
    from . import models  # noqa: F401

    SQLModel.metadata.create_all(get_engine())


def get_session() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session
