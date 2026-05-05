from fastapi import FastAPI, Depends, HTTPException, Header
from sqlmodel import Session, select
from jose import jwt, JWTError
from .db import init_db, get_session
from .models import User, Product, Recipe, RecipeIngredient, WeekPlan
from .schemas import *
from .auth import hash_password, verify_password, create_access_token, SECRET_KEY, ALGORITHM
from .services import scrape_ah_recipe, aggregate_ingredients
import re

app = FastAPI(title="Boodschappen Clone")

@app.on_event("startup")
def startup():
    init_db()

def current_user(authorization: str = Header(default=""), session: Session = Depends(get_session)) -> User:
    token = authorization.replace("Bearer ", "")
    try:
        data = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(401, "Invalid token")
    user = session.exec(select(User).where(User.email == data.get("sub"))).first()
    if not user:
        raise HTTPException(401, "User not found")
    return user

@app.post('/auth/register', response_model=TokenOut)
def register(payload: RegisterIn, session: Session = Depends(get_session)):
    if session.exec(select(User).where(User.email == payload.email)).first():
        raise HTTPException(400, "Email exists")
    user = User(email=payload.email, hashed_password=hash_password(payload.password))
    session.add(user); session.commit()
    return TokenOut(access_token=create_access_token(payload.email))

@app.post('/auth/login', response_model=TokenOut)
def login(payload: LoginIn, session: Session = Depends(get_session)):
    user = session.exec(select(User).where(User.email == payload.email)).first()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(401, "Bad credentials")
    return TokenOut(access_token=create_access_token(payload.email))

@app.post('/products/import', response_model=ProductOut)
def import_product(payload: ProductIn, session: Session = Depends(get_session), user: User = Depends(current_user)):
    m = re.search(r'/producten/(?:product/)?([\w-]+)', payload.ah_url)
    ah_id = m.group(1) if m else payload.ah_url
    existing = session.exec(select(Product).where(Product.ah_id == ah_id)).first()
    if existing: return existing
    product = Product(ah_id=ah_id, title=f"Product {ah_id}", image=None, price=None, unit=None)
    session.add(product); session.commit(); session.refresh(product)
    return product

@app.post('/recipes/import', response_model=RecipeOut)
async def import_recipe(payload: RecipeImportIn, session: Session = Depends(get_session), user: User = Depends(current_user)):
    data = await scrape_ah_recipe(payload.url)
    recipe = Recipe(owner_id=user.id, source_url=payload.url, name=data['name'], description=data['description'], image=data['image'], instructions=data['instructions'], base_persons=data['base_persons'])
    session.add(recipe); session.commit(); session.refresh(recipe)
    for ing in data['ingredients']:
        session.add(RecipeIngredient(recipe_id=recipe.id, name=ing['name'], quantity=ing['quantity'], unit=ing['unit']))
    session.commit()
    return RecipeOut(id=recipe.id,name=recipe.name,description=recipe.description,image=recipe.image,instructions=recipe.instructions,base_persons=recipe.base_persons,ingredients=[RecipeIngredientOut(**i) for i in data['ingredients']])

@app.get('/recipes', response_model=list[RecipeOut])
def list_recipes(session: Session = Depends(get_session), user: User = Depends(current_user)):
    recipes = session.exec(select(Recipe).where(Recipe.owner_id==user.id)).all()
    out=[]
    for r in recipes:
        ings = session.exec(select(RecipeIngredient).where(RecipeIngredient.recipe_id==r.id)).all()
        out.append(RecipeOut(id=r.id,name=r.name,description=r.description,image=r.image,instructions=r.instructions,base_persons=r.base_persons,ingredients=[RecipeIngredientOut(name=i.name,quantity=i.quantity,unit=i.unit) for i in ings]))
    return out

@app.post('/weekplan')
def add_weekplan(payload: WeekPlanIn, session: Session = Depends(get_session), user: User = Depends(current_user)):
    item = WeekPlan(owner_id=user.id, day=payload.day, recipe_id=payload.recipe_id, persons=payload.persons)
    session.add(item); session.commit(); return {"ok": True}

@app.get('/shopping-list')
def shopping_list(session: Session = Depends(get_session), user: User = Depends(current_user)):
    plans = session.exec(select(WeekPlan).where(WeekPlan.owner_id==user.id)).all()
    all_ingredients=[]
    for p in plans:
        r = session.get(Recipe, p.recipe_id)
        if not r: continue
        factor = p.persons / max(r.base_persons,1)
        ings = session.exec(select(RecipeIngredient).where(RecipeIngredient.recipe_id==r.id)).all()
        for i in ings:
            all_ingredients.append({"name":i.name,"unit":i.unit,"quantity":i.quantity*factor})
    return {"items": aggregate_ingredients(all_ingredients)}
