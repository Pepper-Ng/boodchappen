from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, EmailStr, Field, field_validator

from .services import validate_ah_url as validate_albert_heijn_url

WeekDay = Literal["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


class UserOut(BaseModel):
    id: int
    username: str
    email: str


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    username: Optional[str] = None


class LoginIn(BaseModel):
    password: str = Field(min_length=8)
    identifier: Optional[str] = None
    email: Optional[str] = None
    username: Optional[str] = None

    def login_identifier(self) -> str:
        return (self.identifier or self.email or self.username or "").strip()


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class ProductIn(BaseModel):
    ah_url: str

    @field_validator("ah_url")
    @classmethod
    def validate_ah_source_url(cls, value: str) -> str:
        return validate_albert_heijn_url(value)


class ProductOut(BaseModel):
    id: int
    ah_id: str
    source_url: str
    title: str
    image: Optional[str]
    price: Optional[float]
    unit: Optional[str]
    description: Optional[str]
    created_at: datetime


class RecipeImportIn(BaseModel):
    url: str

    @field_validator("url")
    @classmethod
    def validate_recipe_source_url(cls, value: str) -> str:
        return validate_albert_heijn_url(value)


class RecipeIngredientOut(BaseModel):
    id: int
    name: str
    normalized_name: str
    quantity: float
    unit: str
    raw_text: str
    product_id: Optional[int]
    product_title: Optional[str]
    product_url: Optional[str]


class RecipeOut(BaseModel):
    id: int
    source_url: str
    external_id: Optional[str]
    name: str
    description: Optional[str]
    image: Optional[str]
    instructions: str
    base_persons: int
    ingredients: list[RecipeIngredientOut]
    matched_ingredients: int
    total_ingredients: int
    is_fully_matched: bool
    created_at: datetime


class RecipeIngredientMatchIn(BaseModel):
    product_id: Optional[int] = None
    ah_url: Optional[str] = None

    @field_validator("ah_url")
    @classmethod
    def validate_optional_ah_url(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        if not value.strip():
            return None
        return validate_albert_heijn_url(value)


class ImportJobOut(BaseModel):
    id: str
    job_type: str
    source_url: str
    status: str
    recipe_id: Optional[int]
    error: Optional[str]
    created_at: datetime
    started_at: Optional[datetime]
    completed_at: Optional[datetime]


class WeekPlanIn(BaseModel):
    day: WeekDay
    recipe_id: int
    persons: int = Field(ge=1)

    @field_validator("day", mode="before")
    @classmethod
    def normalize_day(cls, value: str) -> str:
        if isinstance(value, str):
            return value.strip().lower()
        return value


class WeekPlanOut(BaseModel):
    id: int
    day: str
    recipe_id: int
    recipe_name: str
    persons: int
    created_at: datetime


class GroceryListCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Name cannot be empty")
        return trimmed


class GroceryListBuildIn(BaseModel):
    include_weekplan: bool = True
    recipe_ids: list[int] = Field(default_factory=list)


class GroceryListItemUpdateIn(BaseModel):
    quantity: Optional[float] = Field(default=None, ge=0)
    remove: bool = False


class GroceryListItemOut(BaseModel):
    id: int
    product_id: int
    product_title: str
    product_url: str
    quantity: float
    unit: str
    recipe_names: list[str]


class GroceryListSummaryOut(BaseModel):
    id: int
    name: str
    item_count: int
    updated_at: datetime


class GroceryListOut(BaseModel):
    id: int
    name: str
    items: list[GroceryListItemOut]
    created_at: datetime
    updated_at: datetime


class HealthOut(BaseModel):
    status: str
