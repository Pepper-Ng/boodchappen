from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import main as main_module
from backend.app.db import configure_engine, init_db
from backend.app.main import app
from backend.app.services import parse_ah_recipe_html

FIXTURES = Path(__file__).parent / "fixtures"
RECIPE_URL = "https://www.ah.nl/allerhande/recept/R-R1196325/rode-linzensoep-met-paprika-muntolie"


def read_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def register_user(client: TestClient, *, email: str = "stef@example.com", username: str = "stef") -> dict:
    response = client.post(
        "/auth/register",
        json={"email": email, "password": "secret123", "username": username},
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture()
def client(tmp_path: Path):
    configure_engine(f"sqlite:///{tmp_path / 'test.db'}", force=True)
    init_db()
    with TestClient(app) as test_client:
        yield test_client


def test_login_accepts_username_or_email(client: TestClient):
    register_user(client)

    username_login = client.post(
        "/auth/login",
        json={"identifier": "stef", "password": "secret123"},
    )
    assert username_login.status_code == 200, username_login.text
    assert username_login.json()["user"]["username"] == "stef"

    email_login = client.post(
        "/auth/login",
        json={"identifier": "stef@example.com", "password": "secret123"},
    )
    assert email_login.status_code == 200, email_login.text
    assert email_login.json()["user"]["email"] == "stef@example.com"


def test_register_rejects_invalid_email(client: TestClient):
    response = client.post(
        "/auth/register",
        json={"email": "not-an-email", "password": "secret123", "username": "stef"},
    )
    assert response.status_code == 422, response.text


def test_import_endpoints_reject_non_ah_urls(client: TestClient):
    auth = register_user(client, email="importer@example.com", username="importer")
    headers = {"Authorization": f"Bearer {auth['access_token']}"}

    product_response = client.post(
        "/products/import",
        headers=headers,
        json={"ah_url": "https://example.com/product"},
    )
    assert product_response.status_code == 422, product_response.text

    recipe_response = client.post(
        "/recipes/import",
        headers=headers,
        json={"url": "https://example.com/recipe"},
    )
    assert recipe_response.status_code == 422, recipe_response.text

    job_response = client.post(
        "/recipes/import-jobs",
        headers=headers,
        json={"url": "https://example.com/recipe"},
    )
    assert job_response.status_code == 422, job_response.text


def test_weekplan_rejects_unknown_day(client: TestClient):
    auth = register_user(client, email="planner@example.com", username="planner")
    headers = {"Authorization": f"Bearer {auth['access_token']}"}

    response = client.post(
        "/weekplan",
        headers=headers,
        json={"day": "funday", "recipe_id": 9999, "persons": 4},
    )
    assert response.status_code == 422, response.text


def test_create_grocery_list_rejects_blank_name(client: TestClient):
    auth = register_user(client, email="list-owner@example.com", username="listowner")
    headers = {"Authorization": f"Bearer {auth['access_token']}"}

    response = client.post("/grocery-lists", headers=headers, json={"name": "    "})
    assert response.status_code == 422, response.text


def test_recipe_import_auto_imports_matching_products(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    auth = register_user(client, email="auto-import@example.com", username="autoimport")
    headers = {"Authorization": f"Bearer {auth['access_token']}"}
    recipe_payload = {
        "external_id": "test-auto-import",
        "name": "Linzensoep",
        "normalized_name": "linzensoep",
        "description": "Test recipe",
        "image": "",
        "instructions": "Cook",
        "base_persons": 2,
        "ingredients": [
            {
                "name": "rode linzen",
                "normalized_name": "rode linzen",
                "quantity": 250,
                "unit": "g",
                "raw_text": "250 g rode linzen",
            }
        ],
    }

    async def fake_scrape(_: str) -> dict:
        return recipe_payload

    async def fake_find_product(_: str) -> str | None:
        return "https://www.ah.nl/producten/product/wi469879/ah-terra-biologisch-rode-linzen"

    async def fake_import_product(_: str) -> dict:
        return {
            "ah_id": "wi469879",
            "source_url": "https://www.ah.nl/producten/product/wi469879/ah-terra-biologisch-rode-linzen",
            "title": "AH Terra Biologisch rode linzen",
            "normalized_title": "terra biologisch rode linzen",
            "image": "",
            "price": 1.99,
            "unit": "500 g",
            "description": "Rode linzen",
        }

    monkeypatch.setattr(main_module, "scrape_ah_recipe", fake_scrape)
    monkeypatch.setattr(main_module, "find_ah_product_url", fake_find_product)
    monkeypatch.setattr(main_module, "import_ah_product", fake_import_product)

    response = client.post("/recipes/import", headers=headers, json={"url": RECIPE_URL})
    assert response.status_code == 200, response.text
    recipe = response.json()
    assert recipe["is_fully_matched"] is True
    assert recipe["matched_ingredients"] == 1

    products = client.get("/products", headers=headers)
    assert products.status_code == 200, products.text
    assert len(products.json()) == 1


def test_recipe_import_job_and_shopping_list_flow(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    auth = register_user(client)
    headers = {"Authorization": f"Bearer {auth['access_token']}"}
    recipe_payload = {
        "external_id": "test-1",
        "name": "Pannenkoeken",
        "normalized_name": "pannenkoeken",
        "description": "Test recipe",
        "image": "",
        "instructions": "Mix and bake",
        "base_persons": 2,
        "ingredients": [
            {
                "name": "melk",
                "normalized_name": "melk",
                "quantity": 1,
                "unit": "l",
                "raw_text": "1 l melk",
            }
        ],
    }

    async def fake_scrape(_: str) -> dict:
        return recipe_payload

    search_enabled = {"value": False}

    async def fake_find_product(_: str) -> str | None:
        if not search_enabled["value"]:
            return None
        return "https://www.ah.nl/producten/product/wi1"

    async def fake_import_product(_: str) -> dict:
        return {
            "ah_id": "ah-melk-1",
            "source_url": "https://www.ah.nl/producten/product/wi1",
            "title": "Halfvolle melk",
            "normalized_title": "melk",
            "image": "",
            "price": 1.99,
            "unit": "1 L",
            "description": "Melk",
        }

    monkeypatch.setattr(main_module, "scrape_ah_recipe", fake_scrape)
    monkeypatch.setattr(main_module, "find_ah_product_url", fake_find_product)
    monkeypatch.setattr(main_module, "import_ah_product", fake_import_product)

    sync_import = client.post("/recipes/import", headers=headers, json={"url": RECIPE_URL})
    assert sync_import.status_code == 200, sync_import.text
    recipe = sync_import.json()
    assert recipe["name"] == "Rode-linzensoep met paprika-muntolie"

    async_import = client.post("/recipes/import-jobs", headers=headers, json={"url": RECIPE_URL})
    assert async_import.status_code == 202, async_import.text
    job_id = async_import.json()["id"]

    job_response = client.get(f"/import-jobs/{job_id}", headers=headers)
    assert job_response.status_code == 200, job_response.text
    assert job_response.json()["status"] == "succeeded"

    add_week_plan_fails = client.post(
        "/weekplan",
        headers=headers,
        json={"day": "monday", "recipe_id": recipe["id"], "persons": 8},
    )
    assert add_week_plan_fails.status_code == 400, add_week_plan_fails.text

    search_enabled["value"] = True
    auto_match_response = client.post(f"/recipes/{recipe['id']}/auto-match", headers=headers)
    assert auto_match_response.status_code == 200, auto_match_response.text
    assert auto_match_response.json()["is_fully_matched"] is True

    products_response = client.get("/products", headers=headers)
    assert products_response.status_code == 200, products_response.text
    assert len(products_response.json()) == 1

    add_week_plan = client.post(
        "/weekplan",
        headers=headers,
        json={"day": "monday", "recipe_id": recipe["id"], "persons": 8},
    )
    assert add_week_plan.status_code == 200, add_week_plan.text

    create_list_response = client.post("/grocery-lists", headers=headers, json={"name": "Week 1"})
    assert create_list_response.status_code == 200, create_list_response.text
    shopping_list_id = create_list_response.json()["id"]

    add_recipe_response = client.post(
        f"/grocery-lists/{shopping_list_id}/recipes",
        headers=headers,
        json={"recipe_id": recipe["id"], "persons": 8},
    )
    assert add_recipe_response.status_code == 200, add_recipe_response.text
    assert add_recipe_response.json()["items"]
    assert recipe["name"] in add_recipe_response.json()["items"][0]["recipe_names"]

    build_list_response = client.post(
        f"/grocery-lists/{shopping_list_id}/build",
        headers=headers,
        json={"include_weekplan": True, "recipe_ids": []},
    )
    assert build_list_response.status_code == 200, build_list_response.text
    built_list = build_list_response.json()
    assert built_list["items"]

    first_item = built_list["items"][0]
    updated_response = client.patch(
        f"/grocery-lists/{shopping_list_id}/items/{first_item['id']}",
        headers=headers,
        json={"quantity": first_item["quantity"] + 1},
    )
    assert updated_response.status_code == 200, updated_response.text
    updated_items = {item["id"]: item for item in updated_response.json()["items"]}
    assert updated_items[first_item["id"]]["quantity"] == pytest.approx(first_item["quantity"] + 1)


def test_delete_recipe_removes_recipe_and_weekplan_entries(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    auth = register_user(client, email="deleter@example.com", username="deleter")
    headers = {"Authorization": f"Bearer {auth['access_token']}"}
    recipe_payload = {
        "external_id": "test-delete",
        "name": "Pannenkoeken",
        "normalized_name": "pannenkoeken",
        "description": "Test recipe",
        "image": "",
        "instructions": "Mix and bake",
        "base_persons": 2,
        "ingredients": [
            {
                "name": "melk",
                "normalized_name": "melk",
                "quantity": 1,
                "unit": "l",
                "raw_text": "1 l melk",
            }
        ],
    }

    async def fake_scrape(_: str) -> dict:
        return recipe_payload

    async def fake_find_product(_: str) -> str | None:
        return "https://www.ah.nl/producten/product/wi1"

    async def fake_import_product(_: str) -> dict:
        return {
            "ah_id": "ah-melk-1",
            "source_url": "https://www.ah.nl/producten/product/wi1",
            "title": "Halfvolle melk",
            "normalized_title": "melk",
            "image": "",
            "price": 1.99,
            "unit": "1 L",
            "description": "Melk",
        }

    monkeypatch.setattr(main_module, "scrape_ah_recipe", fake_scrape)
    monkeypatch.setattr(main_module, "find_ah_product_url", fake_find_product)
    monkeypatch.setattr(main_module, "import_ah_product", fake_import_product)

    recipe_response = client.post("/recipes/import", headers=headers, json={"url": RECIPE_URL})
    assert recipe_response.status_code == 200, recipe_response.text
    recipe = recipe_response.json()

    week_response = client.post(
        "/weekplan",
        headers=headers,
        json={"day": "monday", "recipe_id": recipe["id"], "persons": 4},
    )
    assert week_response.status_code == 200, week_response.text

    delete_response = client.delete(f"/recipes/{recipe['id']}", headers=headers)
    assert delete_response.status_code == 204, delete_response.text

    missing_recipe = client.get(f"/recipes/{recipe['id']}", headers=headers)
    assert missing_recipe.status_code == 404, missing_recipe.text

    week_list = client.get("/weekplan", headers=headers)
    assert week_list.status_code == 200, week_list.text
    assert week_list.json() == []