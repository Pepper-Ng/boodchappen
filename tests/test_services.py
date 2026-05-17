from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.app.services import (
    aggregate_ingredients,
    format_shopping_line,
    match_product_to_ingredient,
    parse_ah_product_html,
    parse_ah_recipe_html,
    parse_ingredient_text,
    validate_ah_url,
)

FIXTURES = Path(__file__).parent / "fixtures"
PRODUCT_URL = "https://www.ah.nl/producten/product/wi129400/ah-avocado-eetrijp"
RECIPE_URL = "https://www.ah.nl/allerhande/recept/R-R1196325/rode-linzensoep-met-paprika-muntolie"


def read_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_parse_ingredient_text_handles_fractional_units_and_piece_defaults():
    ingredient = parse_ingredient_text("1¼ l water")
    assert ingredient["quantity"] == 1.25
    assert ingredient["unit"] == "l"
    assert ingredient["normalized_name"] == "water"

    onions = parse_ingredient_text("2 middelgrote uien")
    assert onions["quantity"] == 2
    assert onions["unit"] == "stuk"
    assert onions["normalized_name"] == "ui"


def test_parse_ingredient_text_keeps_free_text_without_piece_default():
    ingredient = parse_ingredient_text("zout en peper naar smaak")
    assert ingredient["quantity"] == 0
    assert ingredient["unit"] == ""
    assert ingredient["name"] == "zout en peper naar smaak"
    assert ingredient["normalized_name"] == "zout en peper naar smaak"


def test_parse_ah_product_html_reads_real_ah_fixture():
    product = parse_ah_product_html(read_fixture("ah_product_sample.html"), PRODUCT_URL)
    assert product["ah_id"] == "wi129400"
    assert product["title"] == "AH Avocado eetrijp"
    assert product["price"] == 2.99
    assert product["unit"] == "2 stuks"
    assert product["image"].startswith("https://static.ah.nl/")


def test_parse_ah_recipe_html_reads_real_ah_fixture():
    recipe = parse_ah_recipe_html(read_fixture("ah_recipe_live.html"), RECIPE_URL)
    assert recipe["external_id"] == "R-R1196325"
    assert recipe["name"] == "Rode-linzensoep met paprika-muntolie"
    assert recipe["base_persons"] == 4
    assert recipe["ingredients"][0]["normalized_name"] == "ui"
    assert any("Pureer de soep" in step for step in recipe["instruction_steps"])


def test_aggregate_ingredients_normalizes_units_and_names():
    items = [
        {"name": "ui", "normalized_name": "ui", "unit": "stuk", "quantity": 2},
        {"name": "middelgrote uien", "normalized_name": "ui", "unit": "stuk", "quantity": 1},
        {"name": "milde olijfolie", "normalized_name": "olijfolie", "unit": "el", "quantity": 2},
        {"name": "olijfolie", "normalized_name": "olijfolie", "unit": "ml", "quantity": 30},
        {"name": "kipfilet", "normalized_name": "kipfilet", "unit": "kg", "quantity": 0.25},
        {"name": "kipfilet", "normalized_name": "kipfilet", "unit": "g", "quantity": 250},
    ]

    result = aggregate_ingredients(items)
    as_map = {(item["name"], item["unit"]): item["quantity"] for item in result}

    assert as_map[("ui", "stuk")] == 3
    assert as_map[("olijfolie", "el")] == 4
    assert as_map[("kipfilet", "g")] == 500


def test_validate_ah_url_rejects_non_ah_hosts():
    with pytest.raises(ValueError, match="Albert Heijn"):
        validate_ah_url("https://example.com/product")


def test_format_shopping_line_omits_zero_quantity_defaults():
    assert format_shopping_line(0, "", "zout en peper") == "zout en peper"
    assert format_shopping_line(2, "stuk", "ui") == "2 stuk ui"


def test_match_product_to_ingredient_rejects_loose_false_positives():
    products = [
        SimpleNamespace(normalized_title="mineraalwater", id=1),
        SimpleNamespace(normalized_title="mix voor citroencake", id=2),
        SimpleNamespace(normalized_title="verse citroen", id=3),
        SimpleNamespace(normalized_title="gele uien", id=4),
    ]

    assert match_product_to_ingredient("water", products) is None
    assert match_product_to_ingredient("citroen", products).id == 3
    assert match_product_to_ingredient("ui", products).id == 4


def test_match_product_to_ingredient_requires_specific_overlap_for_multi_word_titles():
    products = [
        SimpleNamespace(normalized_title="mix voor citroencake", id=1),
        SimpleNamespace(normalized_title="verse citroen", id=2),
        SimpleNamespace(normalized_title="terra biologisch rode linzen", id=3),
    ]

    assert match_product_to_ingredient("halve citroen", products).id == 2
    assert match_product_to_ingredient("rode linzen", products).id == 3
