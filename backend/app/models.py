from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True)
    email: str = Field(index=True, unique=True)
    hashed_password: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Product(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner_id: int = Field(foreign_key="user.id", index=True)
    ah_id: str = Field(index=True)
    source_url: str
    title: str
    normalized_title: str = Field(index=True)
    image: Optional[str] = None
    price: Optional[float] = None
    unit: Optional[str] = None
    description: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Recipe(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner_id: int = Field(foreign_key="user.id", index=True)
    source_url: str = Field(index=True)
    external_id: Optional[str] = Field(default=None, index=True)
    name: str
    normalized_name: str = Field(index=True)
    description: Optional[str] = None
    image: Optional[str] = None
    instructions: str
    base_persons: int = 4
    created_at: datetime = Field(default_factory=datetime.utcnow)


class RecipeIngredient(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    recipe_id: int = Field(foreign_key="recipe.id", index=True)
    name: str
    normalized_name: str = Field(index=True)
    quantity: float = 0.0
    unit: str = "stuk"
    raw_text: str
    product_id: Optional[int] = Field(default=None, foreign_key="product.id")


class WeekPlan(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner_id: int = Field(foreign_key="user.id", index=True)
    day: str
    recipe_id: int = Field(foreign_key="recipe.id")
    persons: int = 4
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ImportJob(SQLModel, table=True):
    id: str = Field(primary_key=True)
    owner_id: int = Field(foreign_key="user.id", index=True)
    job_type: str = Field(index=True)
    source_url: str
    status: str = Field(index=True)
    recipe_id: Optional[int] = Field(default=None, foreign_key="recipe.id")
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
