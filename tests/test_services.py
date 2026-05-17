import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.app import services as services_module
from backend.app.services import (
    aggregate_ingredients,
    format_shopping_line,
    find_ah_product_url,
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


def test_match_product_to_ingredient_handles_descriptors_compounds_and_synonyms():
    products = [
        SimpleNamespace(normalized_title="verstegen munt", id=1),
        SimpleNamespace(normalized_title="ah biologisch citroenen", id=2),
        SimpleNamespace(normalized_title="ah risotto rijst", id=3),
        SimpleNamespace(normalized_title="ah bouillon groente", id=4),
        SimpleNamespace(normalized_title="ah parmigiano reggiano", id=5),
        SimpleNamespace(normalized_title="ah parmezaanse kaas biscuits", id=6),
    ]

    assert match_product_to_ingredient("gedroogde munt", products).id == 1
    assert match_product_to_ingredient("biologische citroen", products).id == 2
    assert match_product_to_ingredient("risottorijst", products).id == 3
    assert match_product_to_ingredient("groentebouillonblokje", products).id == 4
    assert match_product_to_ingredient("parmezaanse kaas", products).id == 5


def test_match_product_to_ingredient_ignores_pantry_items():
    products = [
        SimpleNamespace(normalized_title="bertolli bio originele extra vierge olijfolie", id=1),
    ]

    assert match_product_to_ingredient("water", products) is None
    assert match_product_to_ingredient("olijfolie", products).id == 1


def test_match_product_to_ingredient_handles_enchilada_style_ingredient_phrasing():
    products = [
        SimpleNamespace(normalized_title="verstegen strooier koriander gemalen", id=1),
        SimpleNamespace(normalized_title="verstegen chili vlokken", id=2),
        SimpleNamespace(normalized_title="ah tomatenblokjes", id=3),
        SimpleNamespace(normalized_title="ah goudse oud 48 plakken", id=4),
        SimpleNamespace(normalized_title="ah tortilla naturel wraps large 12 stuks", id=5),
        SimpleNamespace(normalized_title="ah terra witte bonen", id=6),
    ]

    assert match_product_to_ingredient("gemalen korianderzaad", products).id == 1
    assert match_product_to_ingredient("chilivlokken", products).id == 2
    assert match_product_to_ingredient("tomatenblokjes in blik", products).id == 3
    assert match_product_to_ingredient("oude kaas 48+", products).id == 4
    assert match_product_to_ingredient("tortillawraps", products).id == 5
    assert match_product_to_ingredient("witte bonen in blik", products).id == 6


def test_match_product_to_ingredient_rejects_recipe_irrelevant_extra_tokens():
    products = [
        SimpleNamespace(normalized_title="euroma ras el hanout by jonnie boer", id=1),
        SimpleNamespace(normalized_title="ah ras el hanout cashewnoten ongezouten", id=2),
        SimpleNamespace(normalized_title="maza hoemoes ras el hanout", id=3),
    ]

    assert match_product_to_ingredient("ras el hanout", products).id == 1


def test_match_product_to_ingredient_accepts_single_token_exact_matches_with_brands():
    products = [
        SimpleNamespace(normalized_title="verstegen paprikapoeder mild", id=1),
        SimpleNamespace(normalized_title="ah paprika mild gemalen", id=2),
    ]

    assert match_product_to_ingredient("paprikapoeder", products).id == 1


def test_find_ah_product_url_prefers_original_query_when_normalized_search_is_too_generic(monkeypatch: pytest.MonkeyPatch):
    async def fake_fetch(url: str) -> str:
        if "gedroogde%20munt" in url:
            return '<a href="/producten/product/wi386198/verstegen-munt" aria-label="Verstegen Munt, 15 gram"></a>'
        if url.endswith("query=munt"):
            return '<a href="/producten/product/wi238969/ah-munt" aria-label="AH Munt, 20 gram"></a>'
        raise AssertionError(url)

    monkeypatch.setattr(services_module, "fetch_ah_html", fake_fetch)

    selected = asyncio.run(find_ah_product_url("gedroogde munt"))

    assert selected == "https://www.ah.nl/producten/product/wi386198/verstegen-munt"


def test_find_ah_product_url_prefers_whole_onions_over_processed_onions(monkeypatch: pytest.MonkeyPatch):
    async def fake_fetch(url: str) -> str:
        if "middelgrote%20uien" in url:
            return """
                <a href=\"/producten/product/wi4083/ah-gele-uien\" aria-label=\"AH Gele uien, 1 kilo\"></a>
                <a href=\"/producten/product/wi41078/ah-gesneden-uien\" aria-label=\"AH Gesneden uien, 400 gram\"></a>
            """
        if url.endswith("query=ui"):
            raise AssertionError("normalized fallback should not be needed for onions")
        raise AssertionError(url)

    monkeypatch.setattr(services_module, "fetch_ah_html", fake_fetch)

    selected = asyncio.run(find_ah_product_url("middelgrote uien"))

    assert selected == "https://www.ah.nl/producten/product/wi4083/ah-gele-uien"


def test_find_ah_product_url_uses_normalized_query_when_original_result_is_processed_fallback(monkeypatch: pytest.MonkeyPatch):
    async def fake_fetch(url: str) -> str:
        if "witte%20bonen%20in%20blik" in url:
            return '<a href="/producten/product/wi208645/hak-gesneden-bonen-met-witte-bonen" aria-label="Hak Gesneden bonen met witte bonen, 400 gram"></a>'
        if url.endswith("query=witte%20bonen"):
            return '<a href="/producten/product/wi9837917/ah-terra-witte-bonen" aria-label="AH Terra Witte bonen, 400 gram"></a>'
        raise AssertionError(url)

    monkeypatch.setattr(services_module, "fetch_ah_html", fake_fetch)

    selected = asyncio.run(find_ah_product_url("witte bonen in blik"))

    assert selected == "https://www.ah.nl/producten/product/wi9837917/ah-terra-witte-bonen"
