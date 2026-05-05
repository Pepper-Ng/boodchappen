from __future__ import annotations
from sqlmodel import SQLModel, Field, Relationship
from typing import Optional, List
from datetime import datetime

class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    email: str = Field(index=True, unique=True)
    hashed_password: str
    recipes: List["Recipe"] = Relationship(back_populates="owner")

class Product(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    ah_id: str = Field(index=True, unique=True)
    title: str
    image: Optional[str] = None
    price: Optional[float] = None
    unit: Optional[str] = None

class Recipe(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner_id: int = Field(foreign_key="user.id")
    source_url: str
    name: str
    description: Optional[str] = None
    image: Optional[str] = None
    instructions: str
    base_persons: int = 4
    owner: Optional[User] = Relationship(back_populates="recipes")

class RecipeIngredient(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    recipe_id: int = Field(foreign_key="recipe.id")
    name: str
    quantity: float = 0
    unit: str = "stuk"
    product_id: Optional[int] = Field(default=None, foreign_key="product.id")

class WeekPlan(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner_id: int = Field(foreign_key="user.id")
    day: str
    recipe_id: int = Field(foreign_key="recipe.id")
    persons: int = 4
    created_at: datetime = Field(default_factory=datetime.utcnow)
