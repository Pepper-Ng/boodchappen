from __future__ import annotations

import os
from typing import Iterator

from sqlalchemy import inspect, text
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

    engine = get_engine()
    SQLModel.metadata.create_all(engine)

    inspector = inspect(engine)
    recipe_columns = {column["name"] for column in inspector.get_columns("recipe")}
    recipe_ingredient_columns = {column["name"] for column in inspector.get_columns("recipeingredient")}
    product_columns = {column["name"] for column in inspector.get_columns("product")}
    with engine.begin() as connection:
        if "native_recipe_id" not in recipe_columns:
            connection.execute(text("ALTER TABLE recipe ADD COLUMN native_recipe_id INTEGER"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_recipe_native_recipe_id ON recipe (native_recipe_id)"))
        if "native_ingredient_id" not in recipe_ingredient_columns:
            connection.execute(text("ALTER TABLE recipeingredient ADD COLUMN native_ingredient_id INTEGER"))
        if "native_optional" not in recipe_ingredient_columns:
            connection.execute(text("ALTER TABLE recipeingredient ADD COLUMN native_optional BOOLEAN"))
        if "availability_label" not in product_columns:
            connection.execute(text("ALTER TABLE product ADD COLUMN availability_label VARCHAR"))
        if "is_orderable" not in product_columns:
            connection.execute(text("ALTER TABLE product ADD COLUMN is_orderable BOOLEAN"))
        if "is_visible" not in product_columns:
            connection.execute(text("ALTER TABLE product ADD COLUMN is_visible BOOLEAN"))
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_recipeingredient_native_ingredient_id "
                "ON recipeingredient (native_ingredient_id)"
            )
        )


def get_session() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session
