from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from datetime import datetime
from uuid import uuid4

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select

from .auth import (
    create_access_token,
    decode_access_token,
    ensure_secret_key_is_safe,
    hash_password,
    verify_password,
)
from .db import configure_engine, get_engine, get_session, init_db
from .models import ImportJob, Product, Recipe, RecipeIngredient, User, WeekPlan
from .schemas import (
    HealthOut,
    ImportJobOut,
    LoginIn,
    ProductIn,
    ProductOut,
    RecipeImportIn,
    RecipeIngredientOut,
    RecipeOut,
    RegisterIn,
    ShoppingListItemOut,
    ShoppingListOut,
    TokenOut,
    UserOut,
    WeekPlanIn,
    WeekPlanOut,
)
from .services import (
    aggregate_ingredients,
    build_ah_search_url,
    format_shopping_line,
    import_ah_product,
    match_product_to_ingredient,
    normalize_product_title,
    scrape_ah_recipe,
)


def get_cors_origins() -> list[str]:
    raw_origins = os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173",
    )
    return [origin.strip() for origin in raw_origins.split(",") if origin.strip()]


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_secret_key_is_safe()
    configure_engine()
    init_db()
    yield
    get_engine().dispose()


app = FastAPI(title="Boodchappen API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


def slugify_username(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "user"


def user_to_out(user: User) -> UserOut:
    return UserOut(id=user.id, username=user.username, email=user.email)


def product_to_out(product: Product) -> ProductOut:
    return ProductOut(
        id=product.id,
        ah_id=product.ah_id,
        source_url=product.source_url,
        title=product.title,
        image=product.image,
        price=product.price,
        unit=product.unit,
        description=product.description,
        created_at=product.created_at,
    )


def ingredient_to_out(ingredient: RecipeIngredient) -> RecipeIngredientOut:
    return RecipeIngredientOut(
        name=ingredient.name,
        normalized_name=ingredient.normalized_name,
        quantity=ingredient.quantity,
        unit=ingredient.unit,
        raw_text=ingredient.raw_text,
    )


def recipe_to_out(session: Session, recipe: Recipe) -> RecipeOut:
    ingredients = session.exec(
        select(RecipeIngredient).where(RecipeIngredient.recipe_id == recipe.id)
    ).all()
    return RecipeOut(
        id=recipe.id,
        source_url=recipe.source_url,
        external_id=recipe.external_id,
        name=recipe.name,
        description=recipe.description,
        image=recipe.image,
        instructions=recipe.instructions,
        base_persons=recipe.base_persons,
        ingredients=[ingredient_to_out(ingredient) for ingredient in ingredients],
        created_at=recipe.created_at,
    )


def import_job_to_out(job: ImportJob) -> ImportJobOut:
    return ImportJobOut(
        id=job.id,
        job_type=job.job_type,
        source_url=job.source_url,
        status=job.status,
        recipe_id=job.recipe_id,
        error=job.error,
        created_at=job.created_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
    )


def week_plan_to_out(session: Session, item: WeekPlan) -> WeekPlanOut:
    recipe = session.get(Recipe, item.recipe_id)
    return WeekPlanOut(
        id=item.id,
        day=item.day,
        recipe_id=item.recipe_id,
        recipe_name=recipe.name if recipe else "Onbekend recept",
        persons=item.persons,
        created_at=item.created_at,
    )


def require_bearer_token(authorization: str = Header(default="")) -> str:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    return token


def current_user(
    token: str = Depends(require_bearer_token),
    session: Session = Depends(get_session),
) -> User:
    try:
        payload = decode_access_token(token)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    subject = payload.get("sub")
    if subject is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    try:
        user_id = int(subject)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc

    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


def build_auth_response(user: User) -> TokenOut:
    return TokenOut(access_token=create_access_token(str(user.id)), user=user_to_out(user))


def ensure_owned_recipe(session: Session, user_id: int, recipe_id: int) -> Recipe:
    recipe = session.get(Recipe, recipe_id)
    if not recipe or recipe.owner_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recipe not found")
    return recipe


def pick_username(session: Session, email: str, requested_username: str | None) -> str:
    if requested_username:
        candidate = slugify_username(requested_username)
        if session.exec(select(User).where(User.username == candidate)).first():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username exists")
        return candidate

    base = slugify_username(email.split("@", 1)[0])
    candidate = base
    suffix = 1
    while session.exec(select(User).where(User.username == candidate)).first():
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def save_recipe_import(session: Session, owner_id: int, source_url: str, payload: dict) -> Recipe:
    recipe = session.exec(
        select(Recipe).where(Recipe.owner_id == owner_id).where(Recipe.source_url == source_url)
    ).first()

    if recipe is None:
        recipe = Recipe(
            owner_id=owner_id,
            source_url=source_url,
            external_id=payload.get("external_id"),
            name=payload["name"],
            normalized_name=payload["normalized_name"],
            description=payload.get("description"),
            image=payload.get("image"),
            instructions=payload["instructions"],
            base_persons=payload["base_persons"],
        )
        session.add(recipe)
        session.commit()
        session.refresh(recipe)
    else:
        recipe.external_id = payload.get("external_id")
        recipe.name = payload["name"]
        recipe.normalized_name = payload["normalized_name"]
        recipe.description = payload.get("description")
        recipe.image = payload.get("image")
        recipe.instructions = payload["instructions"]
        recipe.base_persons = payload["base_persons"]
        session.add(recipe)
        session.commit()
        session.refresh(recipe)

        existing_ingredients = session.exec(
            select(RecipeIngredient).where(RecipeIngredient.recipe_id == recipe.id)
        ).all()
        for ingredient in existing_ingredients:
            session.delete(ingredient)
        session.commit()

    for ingredient in payload["ingredients"]:
        session.add(
            RecipeIngredient(
                recipe_id=recipe.id,
                name=ingredient["name"],
                normalized_name=ingredient["normalized_name"],
                quantity=ingredient["quantity"],
                unit=ingredient["unit"],
                raw_text=ingredient["raw_text"],
            )
        )
    session.commit()
    session.refresh(recipe)
    return recipe


def build_shopping_list(session: Session, user: User) -> ShoppingListOut:
    plans = session.exec(
        select(WeekPlan).where(WeekPlan.owner_id == user.id).order_by(WeekPlan.day, WeekPlan.created_at)
    ).all()
    scaled_ingredients: list[dict] = []

    for plan in plans:
        recipe = session.get(Recipe, plan.recipe_id)
        if not recipe or recipe.owner_id != user.id:
            continue

        factor = plan.persons / max(recipe.base_persons, 1)
        recipe_ingredients = session.exec(
            select(RecipeIngredient).where(RecipeIngredient.recipe_id == recipe.id)
        ).all()
        for ingredient in recipe_ingredients:
            scaled_ingredients.append(
                {
                    "name": ingredient.name,
                    "normalized_name": ingredient.normalized_name,
                    "quantity": ingredient.quantity * factor,
                    "unit": ingredient.unit,
                }
            )

    aggregated = aggregate_ingredients(scaled_ingredients)
    products = session.exec(select(Product).where(Product.owner_id == user.id)).all()
    items: list[ShoppingListItemOut] = []
    export_lines: list[str] = []

    for item in aggregated:
        product = match_product_to_ingredient(item["normalized_name"], products)
        shopping_item = ShoppingListItemOut(
            name=item["name"],
            normalized_name=item["normalized_name"],
            quantity=item["quantity"],
            unit=item["unit"],
            product_id=product.id if product else None,
            product_title=product.title if product else None,
            product_url=product.source_url if product else None,
            search_url=None if product else build_ah_search_url(item["name"]),
        )
        items.append(shopping_item)
        export_lines.append(format_shopping_line(shopping_item.quantity, shopping_item.unit, shopping_item.name))

    return ShoppingListOut(items=items, export_lines=export_lines)


async def process_recipe_import_job(job_id: str) -> None:
    with Session(get_engine()) as session:
        job = session.get(ImportJob, job_id)
        if not job:
            return

        job.status = "running"
        job.started_at = datetime.utcnow()
        job.error = None
        session.add(job)
        session.commit()

        try:
            payload = await scrape_ah_recipe(job.source_url)
            recipe = save_recipe_import(session, job.owner_id, job.source_url, payload)
            job.status = "succeeded"
            job.recipe_id = recipe.id
            job.completed_at = datetime.utcnow()
            session.add(job)
            session.commit()
        except Exception as exc:
            job.status = "failed"
            job.error = str(exc)
            job.completed_at = datetime.utcnow()
            session.add(job)
            session.commit()


@app.get("/healthz", response_model=HealthOut)
def healthcheck(session: Session = Depends(get_session)):
    session.exec(select(User).limit(1)).first()
    return HealthOut(status="ok")


@app.post("/auth/register", response_model=TokenOut)
def register(payload: RegisterIn, session: Session = Depends(get_session)):
    email = payload.email.strip().lower()
    if session.exec(select(User).where(User.email == email)).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email exists")

    username = pick_username(session, email, payload.username)
    user = User(username=username, email=email, hashed_password=hash_password(payload.password))
    session.add(user)
    session.commit()
    session.refresh(user)
    return build_auth_response(user)


@app.post("/auth/login", response_model=TokenOut)
def login(payload: LoginIn, session: Session = Depends(get_session)):
    identifier = payload.login_identifier().lower()
    if not identifier:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing login identifier")

    user = session.exec(select(User).where(User.email == identifier)).first()
    if user is None:
        user = session.exec(select(User).where(User.username == identifier)).first()

    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bad credentials")

    return build_auth_response(user)


@app.get("/auth/me", response_model=UserOut)
def auth_me(user: User = Depends(current_user)):
    return user_to_out(user)


@app.get("/products", response_model=list[ProductOut])
def list_products(session: Session = Depends(get_session), user: User = Depends(current_user)):
    products = session.exec(
        select(Product).where(Product.owner_id == user.id).order_by(Product.created_at.desc())
    ).all()
    return [product_to_out(product) for product in products]


@app.post("/products/import", response_model=ProductOut)
async def import_product(
    payload: ProductIn,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    product_data = await import_ah_product(payload.ah_url)
    product = session.exec(
        select(Product)
        .where(Product.owner_id == user.id)
        .where(Product.ah_id == product_data["ah_id"])
    ).first()

    if product is None:
        product = Product(owner_id=user.id, **product_data)
    else:
        product.source_url = product_data["source_url"]
        product.title = product_data["title"]
        product.normalized_title = product_data["normalized_title"]
        product.image = product_data.get("image")
        product.price = product_data.get("price")
        product.unit = product_data.get("unit")
        product.description = product_data.get("description")

    session.add(product)
    session.commit()
    session.refresh(product)
    return product_to_out(product)


@app.get("/recipes", response_model=list[RecipeOut])
def list_recipes(session: Session = Depends(get_session), user: User = Depends(current_user)):
    recipes = session.exec(
        select(Recipe).where(Recipe.owner_id == user.id).order_by(Recipe.created_at.desc())
    ).all()
    return [recipe_to_out(session, recipe) for recipe in recipes]


@app.get("/recipes/{recipe_id}", response_model=RecipeOut)
def get_recipe(recipe_id: int, session: Session = Depends(get_session), user: User = Depends(current_user)):
    recipe = ensure_owned_recipe(session, user.id, recipe_id)
    return recipe_to_out(session, recipe)


@app.post("/recipes/import", response_model=RecipeOut)
async def import_recipe(
    payload: RecipeImportIn,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    recipe_payload = await scrape_ah_recipe(payload.url)
    recipe = save_recipe_import(session, user.id, payload.url, recipe_payload)
    return recipe_to_out(session, recipe)


@app.post("/recipes/import-jobs", response_model=ImportJobOut, status_code=status.HTTP_202_ACCEPTED)
def create_recipe_import_job(
    payload: RecipeImportIn,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    existing_job = session.exec(
        select(ImportJob)
        .where(ImportJob.owner_id == user.id)
        .where(ImportJob.source_url == payload.url)
        .where(ImportJob.status.in_(["queued", "running"]))
    ).first()
    if existing_job:
        return import_job_to_out(existing_job)

    job = ImportJob(
        id=str(uuid4()),
        owner_id=user.id,
        job_type="recipe_import",
        source_url=payload.url,
        status="queued",
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    background_tasks.add_task(process_recipe_import_job, job.id)
    return import_job_to_out(job)


@app.get("/import-jobs", response_model=list[ImportJobOut])
def list_import_jobs(session: Session = Depends(get_session), user: User = Depends(current_user)):
    jobs = session.exec(
        select(ImportJob).where(ImportJob.owner_id == user.id).order_by(ImportJob.created_at.desc())
    ).all()
    return [import_job_to_out(job) for job in jobs]


@app.get("/import-jobs/{job_id}", response_model=ImportJobOut)
def get_import_job(job_id: str, session: Session = Depends(get_session), user: User = Depends(current_user)):
    job = session.get(ImportJob, job_id)
    if not job or job.owner_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Import job not found")
    return import_job_to_out(job)


@app.get("/weekplan", response_model=list[WeekPlanOut])
def list_week_plan(session: Session = Depends(get_session), user: User = Depends(current_user)):
    plans = session.exec(
        select(WeekPlan).where(WeekPlan.owner_id == user.id).order_by(WeekPlan.day, WeekPlan.created_at)
    ).all()
    return [week_plan_to_out(session, item) for item in plans]


@app.post("/weekplan", response_model=WeekPlanOut)
def add_weekplan(
    payload: WeekPlanIn,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    ensure_owned_recipe(session, user.id, payload.recipe_id)
    item = WeekPlan(
        owner_id=user.id,
        day=payload.day,
        recipe_id=payload.recipe_id,
        persons=payload.persons,
    )
    session.add(item)
    session.commit()
    session.refresh(item)
    return week_plan_to_out(session, item)


@app.delete("/weekplan/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_weekplan(entry_id: int, session: Session = Depends(get_session), user: User = Depends(current_user)):
    item = session.get(WeekPlan, entry_id)
    if not item or item.owner_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Week plan entry not found")
    session.delete(item)
    session.commit()


@app.get("/shopping-list/export", response_model=ShoppingListOut)
def export_shopping_list(session: Session = Depends(get_session), user: User = Depends(current_user)):
    return build_shopping_list(session, user)


@app.get("/shopping-list", response_model=ShoppingListOut)
def shopping_list(session: Session = Depends(get_session), user: User = Depends(current_user)):
    return build_shopping_list(session, user)
