from pydantic import BaseModel
from typing import Optional, List

class RegisterIn(BaseModel):
    email: str
    password: str

class LoginIn(RegisterIn):
    pass

class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"

class ProductIn(BaseModel):
    ah_url: str

class ProductOut(BaseModel):
    id: int
    ah_id: str
    title: str
    image: Optional[str]
    price: Optional[float]
    unit: Optional[str]

class RecipeImportIn(BaseModel):
    url: str

class RecipeIngredientOut(BaseModel):
    name: str
    quantity: float
    unit: str

class RecipeOut(BaseModel):
    id: int
    name: str
    description: Optional[str]
    image: Optional[str]
    instructions: str
    base_persons: int
    ingredients: List[RecipeIngredientOut]

class WeekPlanIn(BaseModel):
    day: str
    recipe_id: int
    persons: int
