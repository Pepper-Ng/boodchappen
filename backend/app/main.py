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
from .models import ImportJob, Product, Recipe, RecipeIngredient, ShoppingList, ShoppingListItem, User, WeekPlan
from .schemas import (
    HealthOut,
    GroceryListBuildIn,
    GroceryListCreateIn,
    GroceryListItemOut,
    GroceryListRecipeAddIn,
    GroceryListItemUpdateIn,
    GroceryListOut,
    GroceryListSummaryOut,
    ImportJobOut,
    LoginIn,
    ProductIn,
    ProductOut,
    RecipeImportIn,
    RecipeIngredientMatchIn,
    RecipeIngredientOut,
    RecipeIngredientSuggestionOut,
    RecipeProductSuggestionsOut,
    RecipeOut,
    RegisterIn,
    SuggestedProductOut,
    SuggestedProductSectionOut,
    TokenOut,
    UserOut,
    WeekPlanIn,
    WeekPlanOut,
)
from .services import (
    build_ah_product_url,
    build_product_data_from_suggested_product,
    choose_display_unit,
    convert_to_base_unit,
    fetch_ah_recipe_product_suggestions,
    find_ah_product_url,
    import_ah_product,
    is_better_product_match,
    is_pantry_ingredient,
    match_product_to_ingredient,
    normalize_ingredient_name,
    normalize_product_title,
    scrape_ah_recipe,
    should_skip_product_matching,
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
        availability_label=product.availability_label,
        is_orderable=product.is_orderable,
        is_visible=product.is_visible,
        created_at=product.created_at,
    )


def ingredient_to_out(session: Session, ingredient: RecipeIngredient) -> RecipeIngredientOut:
    product = session.get(Product, ingredient.product_id) if ingredient.product_id else None
    return RecipeIngredientOut(
        id=ingredient.id,
        name=ingredient.name,
        normalized_name=ingredient.normalized_name,
        quantity=ingredient.quantity,
        unit=ingredient.unit,
        raw_text=ingredient.raw_text,
        requires_product=ingredient_requires_product(ingredient),
        product_id=ingredient.product_id,
        product_title=product.title if product else None,
        product_url=product.source_url if product else None,
        product_availability_label=product.availability_label if product else None,
        product_is_orderable=product.is_orderable if product else None,
        product_is_visible=product.is_visible if product else None,
    )


def suggested_product_to_out(product: dict[str, object] | None) -> SuggestedProductOut | None:
    if not isinstance(product, dict):
        return None

    return SuggestedProductOut(
        ah_product_id=int(product["ah_product_id"]),
        ah_id=str(product["ah_id"]),
        title=str(product["title"]),
        source_url=str(product["source_url"]),
        quantity=int(product.get("quantity") or 1),
        image=str(product["image"]) if product.get("image") else None,
        price=float(product["price"]) if product.get("price") is not None else None,
        unit=str(product["unit"]) if product.get("unit") else None,
        availability_label=str(product["availability_label"]) if product.get("availability_label") else None,
        is_orderable=bool(product["is_orderable"]) if product.get("is_orderable") is not None else None,
        is_visible=bool(product["is_visible"]) if product.get("is_visible") is not None else None,
    )


def recipe_ingredient_suggestion_to_out(
    session: Session,
    ingredient: RecipeIngredient,
    suggestion: dict[str, object] | None,
) -> RecipeIngredientSuggestionOut:
    ingredient_out = ingredient_to_out(session, ingredient)
    alternative_sections: list[SuggestedProductSectionOut] = []
    if isinstance(suggestion, dict):
        for section in suggestion.get("alternative_sections") or []:
            if not isinstance(section, dict):
                continue
            products = [
                suggested_product_to_out(product)
                for product in section.get("products") or []
                if suggested_product_to_out(product) is not None
            ]
            if not products:
                continue
            alternative_sections.append(
                SuggestedProductSectionOut(
                    title=str(section["title"]) if section.get("title") else None,
                    description=str(section["description"]) if section.get("description") else None,
                    products=products,
                )
            )

    return RecipeIngredientSuggestionOut(
        **ingredient_out.model_dump(),
        native_ingredient_id=ingredient.native_ingredient_id,
        optional=ingredient.native_optional,
        suggested_product_source=str(suggestion["product_source"]) if isinstance(suggestion, dict) and suggestion.get("product_source") else None,
        suggested_product=suggested_product_to_out(suggestion.get("product")) if isinstance(suggestion, dict) else None,
        alternative_sections=alternative_sections,
    )


def recipe_to_out(session: Session, recipe: Recipe) -> RecipeOut:
    ingredients = session.exec(
        select(RecipeIngredient).where(RecipeIngredient.recipe_id == recipe.id)
    ).all()
    matched_ingredients, total_ingredients = recipe_matching_counts(ingredients)
    return RecipeOut(
        id=recipe.id,
        source_url=recipe.source_url,
        external_id=recipe.external_id,
        name=recipe.name,
        description=recipe.description,
        image=recipe.image,
        instructions=recipe.instructions,
        base_persons=recipe.base_persons,
        ingredients=[ingredient_to_out(session, ingredient) for ingredient in ingredients],
        matched_ingredients=matched_ingredients,
        total_ingredients=total_ingredients,
        is_fully_matched=matched_ingredients == total_ingredients,
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


def ensure_owned_product(session: Session, user_id: int, product_id: int) -> Product:
    product = session.get(Product, product_id)
    if not product or product.owner_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    return product


def ensure_owned_shopping_list(session: Session, user_id: int, shopping_list_id: int) -> ShoppingList:
    shopping_list = session.get(ShoppingList, shopping_list_id)
    if not shopping_list or shopping_list.owner_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shopping list not found")
    return shopping_list


def ensure_owned_recipe_ingredient(session: Session, user_id: int, recipe_id: int, ingredient_id: int) -> RecipeIngredient:
    ingredient = session.get(RecipeIngredient, ingredient_id)
    if not ingredient or ingredient.recipe_id != recipe_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ingredient not found")
    recipe = ensure_owned_recipe(session, user_id, recipe_id)
    if ingredient.recipe_id != recipe.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ingredient not found")
    return ingredient


def ingredient_requires_product(ingredient: RecipeIngredient) -> bool:
    if ingredient.native_optional is not None:
        return not ingredient.native_optional
    return not is_pantry_ingredient(ingredient.normalized_name)


def ingredient_can_auto_match(ingredient: RecipeIngredient) -> bool:
    return not should_skip_product_matching(ingredient.normalized_name)


def recipe_matching_counts(ingredients: list[RecipeIngredient]) -> tuple[int, int]:
    relevant_ingredients = [ingredient for ingredient in ingredients if ingredient_requires_product(ingredient)]
    matched_ingredients = sum(1 for ingredient in relevant_ingredients if ingredient.product_id)
    return matched_ingredients, len(relevant_ingredients)


def recipe_has_full_product_matching(session: Session, recipe_id: int) -> bool:
    ingredients = session.exec(
        select(RecipeIngredient).where(RecipeIngredient.recipe_id == recipe_id)
    ).all()
    matched_ingredients, total_ingredients = recipe_matching_counts(ingredients)
    return matched_ingredients == total_ingredients


def map_native_suggestions_to_ingredients(
    ingredients: list[RecipeIngredient],
    native_suggestions: list[dict[str, object]],
) -> dict[int, dict[str, object]]:
    mapped_suggestions: dict[int, dict[str, object]] = {}
    used_suggestion_indexes: set[int] = set()

    suggestion_index_by_native_ingredient_id = {
        int(suggestion["ingredient_id"]): index
        for index, suggestion in enumerate(native_suggestions)
        if suggestion.get("ingredient_id") is not None
    }
    for ingredient in ingredients:
        if ingredient.native_ingredient_id is None:
            continue
        suggestion_index = suggestion_index_by_native_ingredient_id.get(ingredient.native_ingredient_id)
        if suggestion_index is None:
            continue
        mapped_suggestions[ingredient.id] = native_suggestions[suggestion_index]
        used_suggestion_indexes.add(suggestion_index)

    ingredient_candidates_by_name: dict[str, list[RecipeIngredient]] = {}
    for ingredient in ingredients:
        if ingredient.id in mapped_suggestions:
            continue
        ingredient_candidates_by_name.setdefault(ingredient.normalized_name, []).append(ingredient)

    for suggestion_index, suggestion in enumerate(native_suggestions):
        if suggestion_index in used_suggestion_indexes:
            continue
        normalized_suggestion_name = normalize_ingredient_name(str(suggestion.get("ingredient_name") or ""))
        candidates = ingredient_candidates_by_name.get(normalized_suggestion_name, [])
        target_ingredient = next(
            (candidate for candidate in candidates if candidate.id not in mapped_suggestions),
            None,
        )
        if target_ingredient is None:
            continue
        mapped_suggestions[target_ingredient.id] = suggestion
        used_suggestion_indexes.add(suggestion_index)

    return mapped_suggestions


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


def upsert_imported_product(session: Session, owner_id: int, product_data: dict) -> Product:
    product = session.exec(
        select(Product)
        .where(Product.owner_id == owner_id)
        .where(Product.ah_id == product_data["ah_id"])
    ).first()

    if product is None:
        product = Product(owner_id=owner_id, **product_data)
    else:
        product.source_url = product_data["source_url"]
        product.title = product_data["title"]
        product.normalized_title = product_data["normalized_title"]
        product.image = product_data.get("image")
        product.price = product_data.get("price")
        product.unit = product_data.get("unit")
        product.description = product_data.get("description")
        if product_data.get("availability_label") is not None or product.availability_label is None:
            product.availability_label = product_data.get("availability_label")
        if product_data.get("is_orderable") is not None or product.is_orderable is None:
            product.is_orderable = product_data.get("is_orderable")
        if product_data.get("is_visible") is not None or product.is_visible is None:
            product.is_visible = product_data.get("is_visible")

    session.add(product)
    session.commit()
    session.refresh(product)
    return product


async def auto_match_recipe_ingredients(
    session: Session,
    owner_id: int,
    recipe_id: int,
    *,
    rematch_existing: bool = False,
) -> dict[str, int]:
    recipe = session.get(Recipe, recipe_id)
    if recipe is None:
        return {"matched": 0, "unmatched": 0}

    products = session.exec(select(Product).where(Product.owner_id == owner_id)).all()
    products_by_id = {product.id: product for product in products}
    ingredients = session.exec(
        select(RecipeIngredient).where(RecipeIngredient.recipe_id == recipe_id)
    ).all()

    native_suggestion_by_ingredient_id: dict[int, dict] = {}
    native_product_by_ingredient_id: dict[int, Product] = {}
    native_optional_ingredient_ids: set[int] = set()
    if recipe.native_recipe_id:
        imported_native_products: dict[str, Product] = {}
        try:
            native_suggestions = await fetch_ah_recipe_product_suggestions(recipe.native_recipe_id, recipe.base_persons)
        except Exception:
            native_suggestions = []

        native_suggestion_by_ingredient_id = map_native_suggestions_to_ingredients(ingredients, native_suggestions)

        for target_ingredient in ingredients:
            suggestion = native_suggestion_by_ingredient_id.get(target_ingredient.id)
            if suggestion is None:
                continue
            target_ingredient.native_ingredient_id = suggestion.get("ingredient_id")
            target_ingredient.native_optional = suggestion.get("optional")
            session.add(target_ingredient)

            if target_ingredient.native_optional:
                native_optional_ingredient_ids.add(target_ingredient.id)
                continue

            suggested_product_id = suggestion.get("product_id")
            if suggested_product_id is None:
                continue

            suggested_product = suggestion.get("product") if isinstance(suggestion, dict) else None
            product_url = None
            if isinstance(suggested_product, dict):
                product_url = suggested_product.get("source_url")
            if not product_url:
                product_url = build_ah_product_url(suggested_product_id)
            native_product = imported_native_products.get(product_url)
            if native_product is None:
                if isinstance(suggested_product, dict):
                    product_data = build_product_data_from_suggested_product(suggested_product)
                else:
                    product_data = await import_ah_product(product_url)
                native_product = upsert_imported_product(session, owner_id, product_data)
                imported_native_products[product_url] = native_product
                if native_product.id not in products_by_id:
                    products.append(native_product)
                    products_by_id[native_product.id] = native_product

            target_ingredient.product_id = native_product.id
            native_product_by_ingredient_id[target_ingredient.id] = native_product
            session.add(target_ingredient)

    matched = 0
    unmatched = 0
    for ingredient in ingredients:
        if ingredient.id in native_optional_ingredient_ids:
            continue

        if ingredient.id in native_product_by_ingredient_id:
            if ingredient_requires_product(ingredient):
                matched += 1
            continue

        matched_product = None
        search_query = ingredient.name or ingredient.normalized_name or ingredient.raw_text
        search_product = None

        if ingredient_can_auto_match(ingredient):
            candidate_url = await find_ah_product_url(search_query)
            if candidate_url:
                product_data = await import_ah_product(candidate_url)
                search_product = upsert_imported_product(session, owner_id, product_data)
                products.append(search_product)
                products_by_id[search_product.id] = search_product

        current_product = products_by_id.get(ingredient.product_id) if ingredient.product_id else None
        if current_product and search_product and is_better_product_match(
            search_query,
            current_product.normalized_title,
            search_product.normalized_title,
        ):
            ingredient.product_id = search_product.id
            current_product = search_product

        if rematch_existing and current_product and ingredient_can_auto_match(ingredient):
            if not match_product_to_ingredient(ingredient.normalized_name, [current_product]):
                ingredient.product_id = None
                current_product = None

        if ingredient_can_auto_match(ingredient) and not ingredient.product_id:
            matched_product = search_product or match_product_to_ingredient(ingredient.normalized_name, products)
            ingredient.product_id = matched_product.id if matched_product else None
            session.add(ingredient)
        elif ingredient.product_id and search_product and ingredient.product_id == search_product.id:
            session.add(ingredient)
        if ingredient_requires_product(ingredient):
            if ingredient.product_id:
                matched += 1
            else:
                unmatched += 1

    session.commit()
    return {"matched": matched, "unmatched": unmatched}


async def save_recipe_import(session: Session, owner_id: int, source_url: str, payload: dict) -> Recipe:
    preserved_matches: dict[str, list[int]] = {}
    recipe = session.exec(
        select(Recipe).where(Recipe.owner_id == owner_id).where(Recipe.source_url == source_url)
    ).first()

    if recipe is None:
        recipe = Recipe(
            owner_id=owner_id,
            source_url=source_url,
            external_id=payload.get("external_id"),
            native_recipe_id=payload.get("native_recipe_id"),
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
        existing_ingredients = session.exec(
            select(RecipeIngredient).where(RecipeIngredient.recipe_id == recipe.id)
        ).all()
        for ingredient in existing_ingredients:
            if ingredient.product_id:
                preserved_matches.setdefault(ingredient.normalized_name, []).append(ingredient.product_id)

        recipe.external_id = payload.get("external_id")
        recipe.native_recipe_id = payload.get("native_recipe_id")
        recipe.name = payload["name"]
        recipe.normalized_name = payload["normalized_name"]
        recipe.description = payload.get("description")
        recipe.image = payload.get("image")
        recipe.instructions = payload["instructions"]
        recipe.base_persons = payload["base_persons"]
        session.add(recipe)
        session.commit()
        session.refresh(recipe)

        for ingredient in existing_ingredients:
            session.delete(ingredient)
        session.commit()

    for ingredient in payload["ingredients"]:
        product_id = None
        candidates = preserved_matches.get(ingredient["normalized_name"], [])
        if candidates:
            product_id = candidates.pop(0)
        session.add(
            RecipeIngredient(
                recipe_id=recipe.id,
                name=ingredient["name"],
                normalized_name=ingredient["normalized_name"],
                quantity=ingredient["quantity"],
                unit=ingredient["unit"],
                raw_text=ingredient["raw_text"],
                native_ingredient_id=ingredient.get("native_ingredient_id"),
                native_optional=ingredient.get("native_optional"),
                product_id=product_id,
            )
        )
    session.commit()
    await auto_match_recipe_ingredients(session, owner_id, recipe.id)
    session.refresh(recipe)
    return recipe


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
            recipe = await save_recipe_import(session, job.owner_id, job.source_url, payload)
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


def shopping_list_item_to_out(session: Session, item: ShoppingListItem) -> GroceryListItemOut:
    product = session.get(Product, item.product_id)
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found for shopping list item")

    recipe_names = [name for name in item.source_recipes.split("|") if name]
    return GroceryListItemOut(
        id=item.id,
        product_id=product.id,
        product_title=product.title,
        product_url=product.source_url,
        quantity=item.quantity,
        unit=item.unit,
        recipe_names=recipe_names,
    )


def shopping_list_to_out(session: Session, shopping_list: ShoppingList) -> GroceryListOut:
    items = session.exec(
        select(ShoppingListItem)
        .where(ShoppingListItem.shopping_list_id == shopping_list.id)
        .order_by(ShoppingListItem.created_at)
    ).all()
    return GroceryListOut(
        id=shopping_list.id,
        name=shopping_list.name,
        items=[shopping_list_item_to_out(session, item) for item in items],
        created_at=shopping_list.created_at,
        updated_at=shopping_list.updated_at,
    )


def shopping_list_summary_to_out(session: Session, shopping_list: ShoppingList) -> GroceryListSummaryOut:
    item_count = session.exec(
        select(ShoppingListItem).where(ShoppingListItem.shopping_list_id == shopping_list.id)
    ).all()
    return GroceryListSummaryOut(
        id=shopping_list.id,
        name=shopping_list.name,
        item_count=len(item_count),
        updated_at=shopping_list.updated_at,
    )


def collect_recipe_sources_for_build(session: Session, user: User, payload: GroceryListBuildIn) -> list[tuple[Recipe, float]]:
    recipe_sources: list[tuple[Recipe, float]] = []

    if payload.include_weekplan:
        plans = session.exec(
            select(WeekPlan).where(WeekPlan.owner_id == user.id).order_by(WeekPlan.day, WeekPlan.created_at)
        ).all()
        for plan in plans:
            recipe = ensure_owned_recipe(session, user.id, plan.recipe_id)
            factor = plan.persons / max(recipe.base_persons, 1)
            recipe_sources.append((recipe, factor))

    for recipe_id in payload.recipe_ids:
        recipe = ensure_owned_recipe(session, user.id, recipe_id)
        recipe_sources.append((recipe, 1.0))

    return recipe_sources


def add_recipe_to_named_shopping_list(
    session: Session,
    shopping_list: ShoppingList,
    recipe: Recipe,
    persons: int,
    include_pantry_product_ids: set[int] | None = None,
) -> GroceryListOut:
    if not recipe_has_full_product_matching(session, recipe.id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Fully match ingredients first for: {recipe.name}",
        )

    factor = persons / max(recipe.base_persons, 1)
    included_pantry_products = include_pantry_product_ids or set()
    existing_items = session.exec(
        select(ShoppingListItem).where(ShoppingListItem.shopping_list_id == shopping_list.id)
    ).all()

    buckets: dict[tuple[int, str], dict] = {}
    for item in existing_items:
        base_quantity, base_unit = convert_to_base_unit(item.quantity, item.unit)
        buckets[(item.product_id, base_unit)] = {
            "item": item,
            "base_quantity": base_quantity,
            "recipes": {name for name in item.source_recipes.split("|") if name},
        }

    ingredients = session.exec(
        select(RecipeIngredient).where(RecipeIngredient.recipe_id == recipe.id)
    ).all()
    for ingredient in ingredients:
        if not ingredient.product_id:
            continue

        if not ingredient_requires_product(ingredient) and ingredient.product_id not in included_pantry_products:
            continue

        base_quantity, base_unit = convert_to_base_unit(ingredient.quantity * factor, ingredient.unit)
        key = (ingredient.product_id, base_unit)
        if key not in buckets:
            buckets[key] = {
                "item": None,
                "base_quantity": 0.0,
                "recipes": set(),
            }

        buckets[key]["base_quantity"] += base_quantity
        buckets[key]["recipes"].add(recipe.name)

    for (product_id, base_unit), item_data in buckets.items():
        display_quantity, display_unit = choose_display_unit(item_data["base_quantity"], base_unit)
        shopping_item = item_data["item"]
        if shopping_item is None:
            shopping_item = ShoppingListItem(
                shopping_list_id=shopping_list.id,
                product_id=product_id,
                quantity=display_quantity,
                unit=display_unit,
                source_recipes="|".join(sorted(item_data["recipes"])),
            )
        else:
            shopping_item.quantity = display_quantity
            shopping_item.unit = display_unit
            shopping_item.source_recipes = "|".join(sorted(item_data["recipes"]))
            shopping_item.updated_at = datetime.utcnow()

        session.add(shopping_item)

    shopping_list.updated_at = datetime.utcnow()
    session.add(shopping_list)
    session.commit()
    session.refresh(shopping_list)
    return shopping_list_to_out(session, shopping_list)


def build_named_shopping_list(session: Session, user: User, shopping_list: ShoppingList, payload: GroceryListBuildIn) -> GroceryListOut:
    recipe_sources = collect_recipe_sources_for_build(session, user, payload)
    included_pantry_products = set(payload.include_pantry_product_ids)
    if not recipe_sources:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No recipes selected for shopping list")

    unmatched_recipe_names: list[str] = []
    for recipe, _ in recipe_sources:
        if not recipe_has_full_product_matching(session, recipe.id):
            unmatched_recipe_names.append(recipe.name)

    if unmatched_recipe_names:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Fully match ingredients first for: {', '.join(sorted(set(unmatched_recipe_names)))}",
        )

    buckets: dict[tuple[int, str], dict] = {}
    for recipe, factor in recipe_sources:
        ingredients = session.exec(
            select(RecipeIngredient).where(RecipeIngredient.recipe_id == recipe.id)
        ).all()
        for ingredient in ingredients:
            if not ingredient.product_id:
                continue

            if not ingredient_requires_product(ingredient) and ingredient.product_id not in included_pantry_products:
                continue

            quantity = ingredient.quantity * factor
            base_quantity, base_unit = convert_to_base_unit(quantity, ingredient.unit)
            key = (ingredient.product_id, base_unit)
            if key not in buckets:
                buckets[key] = {
                    "product_id": ingredient.product_id,
                    "base_unit": base_unit,
                    "base_quantity": 0.0,
                    "recipes": set(),
                }

            buckets[key]["base_quantity"] += base_quantity
            buckets[key]["recipes"].add(recipe.name)

    existing = session.exec(
        select(ShoppingListItem).where(ShoppingListItem.shopping_list_id == shopping_list.id)
    ).all()
    for item in existing:
        session.delete(item)
    session.commit()

    for item_data in buckets.values():
        display_quantity, display_unit = choose_display_unit(item_data["base_quantity"], item_data["base_unit"])
        shopping_item = ShoppingListItem(
            shopping_list_id=shopping_list.id,
            product_id=item_data["product_id"],
            quantity=display_quantity,
            unit=display_unit,
            source_recipes="|".join(sorted(item_data["recipes"])),
        )
        session.add(shopping_item)

    shopping_list.updated_at = datetime.utcnow()
    session.add(shopping_list)
    session.commit()
    session.refresh(shopping_list)
    return shopping_list_to_out(session, shopping_list)


@app.get("/grocery-lists", response_model=list[GroceryListSummaryOut])
def list_named_shopping_lists(session: Session = Depends(get_session), user: User = Depends(current_user)):
    shopping_lists = session.exec(
        select(ShoppingList)
        .where(ShoppingList.owner_id == user.id)
        .order_by(ShoppingList.updated_at.desc())
    ).all()
    return [shopping_list_summary_to_out(session, shopping_list) for shopping_list in shopping_lists]


@app.post("/grocery-lists", response_model=GroceryListOut)
def create_named_shopping_list(
    payload: GroceryListCreateIn,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    shopping_list = ShoppingList(owner_id=user.id, name=payload.name.strip())
    session.add(shopping_list)
    session.commit()
    session.refresh(shopping_list)
    return shopping_list_to_out(session, shopping_list)


@app.get("/grocery-lists/{shopping_list_id}", response_model=GroceryListOut)
def get_named_shopping_list(
    shopping_list_id: int,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    shopping_list = ensure_owned_shopping_list(session, user.id, shopping_list_id)
    return shopping_list_to_out(session, shopping_list)


@app.post("/grocery-lists/{shopping_list_id}/build", response_model=GroceryListOut)
def build_named_shopping_list_endpoint(
    shopping_list_id: int,
    payload: GroceryListBuildIn,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    shopping_list = ensure_owned_shopping_list(session, user.id, shopping_list_id)
    return build_named_shopping_list(session, user, shopping_list, payload)


@app.post("/grocery-lists/{shopping_list_id}/recipes", response_model=GroceryListOut)
def add_recipe_to_named_shopping_list_endpoint(
    shopping_list_id: int,
    payload: GroceryListRecipeAddIn,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    shopping_list = ensure_owned_shopping_list(session, user.id, shopping_list_id)
    recipe = ensure_owned_recipe(session, user.id, payload.recipe_id)
    return add_recipe_to_named_shopping_list(
        session,
        shopping_list,
        recipe,
        payload.persons,
        include_pantry_product_ids=set(payload.include_pantry_product_ids),
    )


@app.patch("/grocery-lists/{shopping_list_id}/items/{item_id}", response_model=GroceryListOut)
def update_named_shopping_list_item(
    shopping_list_id: int,
    item_id: int,
    payload: GroceryListItemUpdateIn,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    shopping_list = ensure_owned_shopping_list(session, user.id, shopping_list_id)
    item = session.get(ShoppingListItem, item_id)
    if not item or item.shopping_list_id != shopping_list.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shopping list item not found")

    if payload.remove or payload.quantity == 0:
        session.delete(item)
    elif payload.quantity is not None:
        item.quantity = payload.quantity
        item.updated_at = datetime.utcnow()
        session.add(item)

    shopping_list.updated_at = datetime.utcnow()
    session.add(shopping_list)
    session.commit()
    session.refresh(shopping_list)
    return shopping_list_to_out(session, shopping_list)


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
    product = upsert_imported_product(session, user.id, product_data)
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


@app.get("/recipes/{recipe_id}/product-suggestions", response_model=RecipeProductSuggestionsOut)
async def get_recipe_product_suggestions(
    recipe_id: int,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    recipe = ensure_owned_recipe(session, user.id, recipe_id)
    ingredients = session.exec(
        select(RecipeIngredient).where(RecipeIngredient.recipe_id == recipe.id).order_by(RecipeIngredient.id)
    ).all()

    native_suggestion_by_ingredient_id: dict[int, dict[str, object]] = {}
    if recipe.native_recipe_id:
        try:
            native_suggestions = await fetch_ah_recipe_product_suggestions(recipe.native_recipe_id, recipe.base_persons)
        except Exception:
            native_suggestions = []
        native_suggestion_by_ingredient_id = map_native_suggestions_to_ingredients(ingredients, native_suggestions)

    return RecipeProductSuggestionsOut(
        recipe_id=recipe.id,
        base_persons=recipe.base_persons,
        ingredients=[
            recipe_ingredient_suggestion_to_out(
                session,
                ingredient,
                native_suggestion_by_ingredient_id.get(ingredient.id),
            )
            for ingredient in ingredients
        ],
    )


@app.delete("/recipes/{recipe_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_recipe(recipe_id: int, session: Session = Depends(get_session), user: User = Depends(current_user)):
    recipe = ensure_owned_recipe(session, user.id, recipe_id)

    week_plans = session.exec(
        select(WeekPlan).where(WeekPlan.owner_id == user.id).where(WeekPlan.recipe_id == recipe.id)
    ).all()
    for week_plan in week_plans:
        session.delete(week_plan)

    ingredients = session.exec(
        select(RecipeIngredient).where(RecipeIngredient.recipe_id == recipe.id)
    ).all()
    for ingredient in ingredients:
        session.delete(ingredient)

    jobs = session.exec(
        select(ImportJob).where(ImportJob.owner_id == user.id).where(ImportJob.recipe_id == recipe.id)
    ).all()
    for job in jobs:
        job.recipe_id = None
        session.add(job)

    session.delete(recipe)
    session.commit()


@app.post("/recipes/{recipe_id}/auto-match", response_model=RecipeOut)
async def auto_match_recipe(recipe_id: int, session: Session = Depends(get_session), user: User = Depends(current_user)):
    recipe = ensure_owned_recipe(session, user.id, recipe_id)
    await auto_match_recipe_ingredients(session, user.id, recipe.id, rematch_existing=True)
    session.refresh(recipe)
    return recipe_to_out(session, recipe)


@app.post("/recipes/{recipe_id}/ingredients/{ingredient_id}/match", response_model=RecipeOut)
async def manual_match_recipe_ingredient(
    recipe_id: int,
    ingredient_id: int,
    payload: RecipeIngredientMatchIn,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    recipe = ensure_owned_recipe(session, user.id, recipe_id)
    ingredient = ensure_owned_recipe_ingredient(session, user.id, recipe.id, ingredient_id)

    if payload.product_id is None and not payload.ah_url:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Provide product_id or ah_url")

    if payload.product_id is not None:
        product = ensure_owned_product(session, user.id, payload.product_id)
        ingredient.product_id = product.id
    elif payload.ah_url:
        product_data = await import_ah_product(payload.ah_url)
        product = upsert_imported_product(session, user.id, product_data)
        ingredient.product_id = product.id

    session.add(ingredient)
    session.commit()
    session.refresh(recipe)
    return recipe_to_out(session, recipe)


@app.post("/recipes/import", response_model=RecipeOut)
async def import_recipe(
    payload: RecipeImportIn,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    recipe_payload = await scrape_ah_recipe(payload.url)
    recipe = await save_recipe_import(session, user.id, payload.url, recipe_payload)
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
    recipe = ensure_owned_recipe(session, user.id, payload.recipe_id)
    if not recipe_has_full_product_matching(session, recipe.id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Recipe has unmatched ingredients. Match all ingredients before adding to week menu.",
        )
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
