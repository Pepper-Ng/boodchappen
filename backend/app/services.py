from __future__ import annotations

import json
import re
import time
from typing import Any
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup

AH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
}
AH_API_HEADERS = {
        "User-Agent": AH_HEADERS["User-Agent"],
        "Accept": "application/json",
        "Accept-Language": AH_HEADERS["Accept-Language"],
        "Origin": "https://www.ah.nl",
        "Referer": "https://www.ah.nl/",
}
AH_API_BASE_URL = "https://api.ah.nl"
AH_ANONYMOUS_TOKEN_URL = f"{AH_API_BASE_URL}/mobile-auth/v1/auth/token/anonymous"
AH_GRAPHQL_URL = f"{AH_API_BASE_URL}/graphql"
AH_ANONYMOUS_CLIENT_ID = "appie"
AH_RECIPE_PRODUCT_SUGGESTIONS_QUERY = """
query RecipeProductSuggestions($recipeId: Int!, $numberOfServings: Int!) {
    recipeProductSuggestionsV2(
        options: {
            recipeId: $recipeId
            numberOfServings: $numberOfServings
            productIdOverride: []
            ingredientsToOverride: []
        }
    ) {
        optional
        ingredient {
            id
            name
            quantityFloat
            quantityUnit
            rawIngredientText
        }
        productSuggestion {
            quantity
            product {
                id
                title
                webPath
                salesUnitSize
                imagePack(angles: [ANGLE_2D1, HERO]) {
                    small {
                        url
                    }
                }
                priceV2 {
                    now {
                        amount
                    }
                }
                availability {
                    availabilityLabel
                    isOrderable
                    isVisible
                }
            }
        }
        alternativeSections {
            title
            description
            productSuggestions {
                quantity
                product {
                    id
                    title
                    webPath
                    salesUnitSize
                    imagePack(angles: [ANGLE_2D1, HERO]) {
                        small {
                            url
                        }
                    }
                    priceV2 {
                        now {
                            amount
                        }
                    }
                    availability {
                        availabilityLabel
                        isOrderable
                        isVisible
                    }
                }
            }
        }
    }
}
"""

PRODUCT_URL_RE = re.compile(r"/producten/product/(?P<id>[^/]+)")
RECIPE_URL_RE = re.compile(r"/allerhande/recept/(?P<id>[^/]+)")
NUMERIC_RECIPE_ID_RE = re.compile(r'\\?"recipeId\\?":(?P<id>\d+)')
ALBERT_HEIJN_HOST = "ah.nl"
MAX_AH_REDIRECTS = 5

_AH_ANONYMOUS_TOKEN: str | None = None
_AH_ANONYMOUS_TOKEN_EXPIRES_AT = 0.0

UNIT_ALIASES = {
    "g": "g",
    "gram": "g",
    "grammen": "g",
    "kg": "kg",
    "kilo": "kg",
    "kilogram": "kg",
    "kilogrammen": "kg",
    "ml": "ml",
    "milliliter": "ml",
    "milliliters": "ml",
    "l": "l",
    "liter": "l",
    "liters": "l",
    "el": "el",
    "eetlepel": "el",
    "eetlepels": "el",
    "tl": "tl",
    "theelepel": "tl",
    "theelepels": "tl",
    "stuk": "stuk",
    "stuks": "stuk",
    "teen": "teen",
    "tenen": "teen",
    "blik": "blik",
    "blikken": "blik",
    "bosje": "bosje",
    "bosjes": "bosje",
    "pak": "pak",
    "pakken": "pak",
    "pot": "pot",
    "potten": "pot",
    "zak": "zak",
    "zakken": "zak",
}

MATCH_IGNORED_PRODUCT_TOKENS = {
    "ah",
    "albert",
    "heijn",
    "terra",
    "bio",
    "biologisch",
    "mix",
    "voor",
    "recept",
    "receptmix",
    "vers",
    "verse",
}

MATCH_DISALLOWED_PRODUCT_TOKENS = {
    "biscuit",
    "biscuits",
    "cashewnoten",
    "hoemoes",
}

MATCH_DISCOURAGED_EXTRA_PRODUCT_TOKENS = {
    "gesneden",
    "gesnipperd",
    "gesnipperde",
    "snippers",
    "uiensnippers",
}

INGREDIENT_DESCRIPTOR_TOKENS = {
    "ca",
    "ongeveer",
    "biologisch",
    "biologische",
    "gedroogd",
    "gedroogde",
    "grote",
    "groot",
    "kleine",
    "klein",
    "middelgrote",
    "middelgroot",
    "halve",
    "half",
    "hele",
    "heel",
    "vers",
    "verse",
}

PANTRY_INGREDIENTS = {
    "water",
    "kraanwater",
    "olijfolie",
    "zout",
    "peper",
}

ALWAYS_UNMATCHED_INGREDIENTS = {
    "water",
    "kraanwater",
}

INGREDIENT_PHRASE_NORMALIZATIONS = {
    "chilivlokken": "chili vlokken",
    "chilivlokken": "chili vlokken",
    "groentebouillonblokje": "groente bouillon",
    "groentebouillonblokjes": "groente bouillon",
    "korianderzaad": "koriander",
    "oude kaas 48": "oud kaas 48",
    "oude kaas 48+": "oud kaas 48",
    "parmigiano reggiano": "parmezaan",
    "parmezaanse kaas": "parmezaan",
    "risottorijst": "risotto rijst",
    "tomatenblokjes in blik": "tomatenblokjes",
    "tortillawraps": "tortilla wraps",
    "witte bonen in blik": "witte bonen",
}

MATCH_TOKEN_SYNONYMS = {
    "oude": "oud",
    "parmigiano": "parmezaan",
    "parmezaan": "parmezaan",
    "parmezaanse": "parmezaan",
    "reggiano": "parmezaan",
}

KNOWN_UNITS = set(UNIT_ALIASES.values())
COUNT_UNITS = {"stuk", "teen", "blik", "bosje", "pak", "pot", "zak"}
BASE_UNIT_CONVERSIONS = {
    "kg": ("g", 1000.0),
    "l": ("ml", 1000.0),
    "el": ("ml", 15.0),
    "tl": ("ml", 5.0),
}
UNICODE_FRACTIONS = {
    "½": "1/2",
    "¼": "1/4",
    "¾": "3/4",
    "⅓": "1/3",
    "⅔": "2/3",
    "⅛": "1/8",
    "⅜": "3/8",
    "⅝": "5/8",
    "⅞": "7/8",
}


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def clean_ah_title(title: str) -> str:
    cleaned = normalize_space(title)
    cleaned = re.sub(r"\s+bestellen\s*\|\s*Albert Heijn$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+recept\s*-\s*Allerhande\s*\|\s*Albert Heijn$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*\|\s*Albert Heijn$", "", cleaned, flags=re.IGNORECASE)
    return normalize_space(cleaned)


def normalize_unit(unit: str) -> str:
    token = normalize_space(unit).lower()
    return UNIT_ALIASES.get(token, token)


def normalize_fraction_number_text(value: str) -> str:
    normalized = value
    for unicode_fraction, replacement in UNICODE_FRACTIONS.items():
        normalized = re.sub(rf"(\d){re.escape(unicode_fraction)}", rf"\1 {replacement}", normalized)
        normalized = normalized.replace(unicode_fraction, replacement)
    normalized = normalized.replace(",", ".")
    return normalize_space(normalized)


def parse_number_token(token: str) -> float | None:
    if re.fullmatch(r"\d+(?:\.\d+)?", token):
        return float(token)
    if re.fullmatch(r"\d+/\d+", token):
        numerator, denominator = token.split("/", 1)
        denominator_value = float(denominator)
        if denominator_value == 0:
            return None
        return float(numerator) / denominator_value
    return None


def parse_leading_quantity(text: str) -> tuple[float, str]:
    normalized = normalize_fraction_number_text(text)
    tokens = normalized.split()
    quantity = 0.0
    consumed = 0
    for token in tokens[:2]:
        parsed = parse_number_token(token)
        if parsed is None:
            break
        quantity += parsed
        consumed += 1
    return quantity, " ".join(tokens[consumed:])


def parse_recipe_yield(value: Any) -> int:
    quantity, _ = parse_leading_quantity(str(value or "1"))
    return max(int(quantity or 1), 1)


def extract_ah_product_id(url: str) -> str:
    match = PRODUCT_URL_RE.search(url)
    if match:
        return match.group("id")
    return url.rstrip("/").rsplit("/", 1)[-1]


def extract_ah_recipe_id(url: str) -> str | None:
    match = RECIPE_URL_RE.search(url)
    if match:
        return match.group("id")
    return None


def extract_ah_numeric_recipe_id(html: str) -> int | None:
    match = NUMERIC_RECIPE_ID_RE.search(html)
    if not match:
        return None
    return int(match.group("id"))


def is_supported_ah_host(host: str | None) -> bool:
    if not host:
        return False
    normalized_host = host.rstrip(".").lower()
    return normalized_host == ALBERT_HEIJN_HOST or normalized_host.endswith(f".{ALBERT_HEIJN_HOST}")


def validate_ah_url(url: str) -> str:
    try:
        parsed = httpx.URL(url)
    except Exception as exc:
        raise ValueError("Invalid Albert Heijn URL") from exc

    if not parsed.is_absolute_url or parsed.scheme not in {"http", "https"}:
        raise ValueError("Invalid Albert Heijn URL")
    if not is_supported_ah_host(parsed.host):
        raise ValueError("Only Albert Heijn URLs are supported")
    if parsed.port not in (None, 80, 443):
        raise ValueError("Only standard Albert Heijn web URLs are supported")

    return str(parsed)


def build_ah_product_url(product_id: str | int) -> str:
    normalized_product_id = str(product_id).strip()
    if not normalized_product_id:
        raise ValueError("Albert Heijn product id is required")
    if not normalized_product_id.startswith("wi"):
        normalized_product_id = f"wi{normalized_product_id}"
    return f"https://www.ah.nl/producten/product/{normalized_product_id}"


def build_ah_web_url(path: str | None, *, fallback_product_id: str | int | None = None) -> str | None:
    normalized_path = normalize_space(str(path or ""))
    if normalized_path:
        if normalized_path.startswith("http://") or normalized_path.startswith("https://"):
            return normalized_path
        if normalized_path.startswith("/"):
            return f"https://www.ah.nl{normalized_path}"
    if fallback_product_id is None:
        return None
    return build_ah_product_url(fallback_product_id)


def normalize_product_title(title: str) -> str:
    cleaned = clean_ah_title(title).lower()
    cleaned = re.sub(r"^ah\s+", "", cleaned)
    cleaned = re.sub(r"[^\w\s-]", "", cleaned)
    return normalize_space(cleaned)


def normalize_recipe_name(name: str) -> str:
    cleaned = clean_ah_title(name).lower()
    cleaned = re.sub(r"[^\w\s-]", "", cleaned)
    return normalize_space(cleaned)


def normalize_ingredient_name(name: str) -> str:
    cleaned = normalize_space(name).lower().replace("’", "'")
    cleaned = re.sub(r"[^\w\s-]", "", cleaned)
    for source, replacement in INGREDIENT_PHRASE_NORMALIZATIONS.items():
        cleaned = re.sub(rf"\b{re.escape(source)}\b", replacement, cleaned)
    words = [word for word in cleaned.split() if word not in INGREDIENT_DESCRIPTOR_TOKENS]
    if not words:
        return cleaned

    words = [MATCH_TOKEN_SYNONYMS.get(word, word) for word in words]

    if "olijfolie" in words:
        return "olijfolie"

    if words[-1] in {"uien", "ui"}:
        prefix = [word for word in words[:-1] if word not in {"middelgrote", "grote", "kleine"}]
        if prefix and prefix[-1] in {"rode", "gele", "witte", "bos"}:
            return " ".join(prefix + ["ui"])
        if prefix and prefix[-1] in MATCH_DISCOURAGED_EXTRA_PRODUCT_TOKENS:
            return " ".join(prefix + ["ui"])
        return "ui"

    if words[-1] == "aardappelen":
        words[-1] = "aardappel"
    elif words[-1] == "winterpenen":
        words[-1] = "winterpeen"
    elif words[-1] == "citroenen":
        words[-1] = "citroen"
    elif words[-1] == "preien":
        words[-1] = "prei"

    return " ".join(words)


def tokenize_matching_text(value: str, *, drop_product_stopwords: bool = False) -> set[str]:
    normalized = normalize_ingredient_name(value)
    tokens = {
        MATCH_TOKEN_SYNONYMS.get(token, token)
        for token in normalize_space(normalized).split()
        if token and len(token) >= 2
    }
    if drop_product_stopwords:
        return {token for token in tokens if token not in MATCH_IGNORED_PRODUCT_TOKENS}
    return tokens


def score_token_overlap(query_tokens: set[str], candidate_tokens: set[str]) -> tuple[float, float, int, int] | None:
    overlap = query_tokens & candidate_tokens
    if not overlap:
        return None

    extra_tokens = candidate_tokens - query_tokens
    if extra_tokens & MATCH_DISALLOWED_PRODUCT_TOKENS:
        return None

    overlap_count = len(overlap)
    ingredient_ratio = overlap_count / max(len(query_tokens), 1)
    product_ratio = overlap_count / max(len(candidate_tokens), 1)
    discouraged_extra_count = len(extra_tokens & MATCH_DISCOURAGED_EXTRA_PRODUCT_TOKENS)
    return ingredient_ratio, product_ratio, overlap_count, -discouraged_extra_count, -len(extra_tokens)


def candidate_has_discouraged_extra_tokens(query: str, candidate_title: str) -> bool:
    query_tokens = tokenize_matching_text(query)
    candidate_tokens = tokenize_matching_text(candidate_title, drop_product_stopwords=True)
    extra_tokens = candidate_tokens - query_tokens
    return bool(extra_tokens & MATCH_DISCOURAGED_EXTRA_PRODUCT_TOKENS)


def product_match_score(query: str, normalized_title: str) -> tuple[int, float, float, int, int, int] | None:
    normalized_query = normalize_ingredient_name(query)
    query_tokens = tokenize_matching_text(normalized_query)
    if not query_tokens:
        return None

    title_tokens = tokenize_matching_text(normalized_title, drop_product_stopwords=True)
    score = score_token_overlap(query_tokens, title_tokens)
    if not score:
        return None

    exact_match = int(
        normalize_ingredient_name(normalized_title) == normalized_query
        and not candidate_has_discouraged_extra_tokens(query, normalized_title)
    )
    return (exact_match, *score)


def is_better_product_match(query: str, current_normalized_title: str, candidate_normalized_title: str) -> bool:
    current_score = product_match_score(query, current_normalized_title)
    candidate_score = product_match_score(query, candidate_normalized_title)
    if candidate_score is None:
        return False
    if current_score is None:
        return True
    return candidate_score > current_score


def select_best_candidate(query: str, candidates: list[dict[str, str]]) -> dict[str, str] | None:
    normalized_query = normalize_ingredient_name(query)
    query_tokens = tokenize_matching_text(normalized_query)
    if not query_tokens:
        return candidates[0] if candidates else None

    scored_candidates: list[tuple[float, float, int, int, int, dict[str, str]]] = []
    for candidate in candidates:
        normalized_title = normalize_product_title(candidate["title"])
        score = product_match_score(query, normalized_title)
        if score:
            scored_candidates.append((*score, candidate))

    if not scored_candidates:
        return None

    scored_candidates.sort(key=lambda item: item[:-1], reverse=True)
    best_exact, best_ratio, best_product_ratio, best_overlap, _, _, best_candidate = scored_candidates[0]
    if best_exact or (best_ratio >= 1.0 and (best_product_ratio >= 0.5 or len(query_tokens) == 1)) or best_overlap >= 2:
        return best_candidate
    return None


def is_pantry_ingredient(normalized_name: str) -> bool:
    return normalized_name in PANTRY_INGREDIENTS


def should_skip_product_matching(normalized_name: str) -> bool:
    return normalized_name in ALWAYS_UNMATCHED_INGREDIENTS


def parse_ingredient_text(raw_text: str) -> dict[str, Any]:
    cleaned = normalize_space(raw_text)
    quantity, remainder = parse_leading_quantity(cleaned)
    tokens = remainder.split()
    unit = "stuk" if quantity > 0.0 else ""
    name = remainder or cleaned

    if tokens:
        candidate_unit = normalize_unit(tokens[0])
        if candidate_unit in KNOWN_UNITS:
            unit = candidate_unit
            name = " ".join(tokens[1:]) or tokens[0]

    if quantity == 0.0 and unit in COUNT_UNITS:
        quantity = 1.0

    normalized_name = normalize_ingredient_name(name)
    return {
        "name": normalize_space(name).lower(),
        "normalized_name": normalized_name,
        "quantity": quantity,
        "unit": unit,
        "raw_text": cleaned,
    }


def iter_json_ld_objects(soup: BeautifulSoup):
    for script in soup.find_all("script", {"type": "application/ld+json"}):
        raw_payload = script.string or script.get_text()
        if not raw_payload:
            continue
        try:
            payload = json.loads(raw_payload)
        except json.JSONDecodeError:
            continue

        if isinstance(payload, list):
            for item in payload:
                if isinstance(item, dict):
                    yield item
            continue

        if isinstance(payload, dict):
            yield payload


def find_schema_object(soup: BeautifulSoup, schema_type: str) -> dict[str, Any] | None:
    for obj in iter_json_ld_objects(soup):
        object_type = obj.get("@type")
        if object_type == schema_type:
            return obj
        if isinstance(object_type, list) and schema_type in object_type:
            return obj
    return None


def first_non_empty_image(value: Any) -> str | None:
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str) and item:
                return item
        return None
    if isinstance(value, str) and value:
        return value
    return None


def extract_html_ingredient_lines(soup: BeautifulSoup) -> list[str]:
    lines: list[str] = []
    for item in soup.select("[data-testid='ingredients'] p[aria-label]"):
        label = normalize_space(item.get("aria-label", ""))
        if label:
            lines.append(label)
    if lines:
        return lines

    for item in soup.select("[data-testid='print-ingredients'] p"):
        label = normalize_space(item.get_text(" ", strip=True))
        if label:
            lines.append(label)
    return lines


def extract_instruction_steps(recipe_schema: dict[str, Any], soup: BeautifulSoup) -> list[str]:
    steps: list[str] = []

    for item in recipe_schema.get("recipeInstructions", []):
        if isinstance(item, dict):
            text = normalize_space(str(item.get("text", "")))
        else:
            text = normalize_space(str(item))
        if text:
            steps.append(text)
    if steps:
        return steps

    for item in soup.select("[data-testid='preparation-steps'] li p"):
        text = normalize_space(item.get_text(" ", strip=True))
        if text:
            steps.append(text)
    if steps:
        return steps

    for item in soup.select("[data-testid='print-steps'] li p"):
        text = normalize_space(item.get_text(" ", strip=True))
        if text:
            steps.append(text)
    return steps


def parse_ah_product_html(html: str, url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    product_schema = find_schema_object(soup, "Product")

    title = ""
    image = None
    description = None
    price = None
    unit = None
    ah_id = extract_ah_product_id(url)

    if product_schema:
        title = clean_ah_title(str(product_schema.get("name", "")))
        image = first_non_empty_image(product_schema.get("image"))
        description = normalize_space(str(product_schema.get("description", ""))) or None
        ah_id = str(product_schema.get("sku") or ah_id)

        offers = product_schema.get("offers")
        if isinstance(offers, list):
            offers = offers[0] if offers else None
        if isinstance(offers, dict) and offers.get("price") is not None:
            parsed_price, _ = parse_leading_quantity(str(offers.get("price")))
            price = round(parsed_price, 2) if parsed_price else None

        weight = product_schema.get("weight")
        if isinstance(weight, dict):
            unit = normalize_space(str(weight.get("value", ""))) or None

    if not title:
        meta_title = soup.find("meta", {"property": "og:title"})
        if meta_title and meta_title.get("content"):
            title = clean_ah_title(str(meta_title["content"]))
        elif soup.title and soup.title.string:
            title = clean_ah_title(soup.title.string)
        else:
            raise ValueError("Product metadata not found")

    if not image:
        meta_image = soup.find("meta", {"property": "og:image"})
        image = meta_image.get("content") if meta_image else None

    if description is None:
        meta_description = soup.find("meta", {"name": "description"})
        if meta_description and meta_description.get("content"):
            description = normalize_space(str(meta_description["content"]))

    return {
        "ah_id": ah_id,
        "source_url": url,
        "title": title,
        "normalized_title": normalize_product_title(title),
        "image": image,
        "price": price,
        "unit": unit,
        "description": description,
        "availability_label": None,
        "is_orderable": None,
        "is_visible": None,
    }


def parse_ah_suggested_product(suggestion: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(suggestion, dict):
        return None

    product = suggestion.get("product")
    if not isinstance(product, dict):
        return None

    product_id = product.get("id")
    if product_id is None:
        return None

    availability = product.get("availability") if isinstance(product.get("availability"), dict) else {}
    image_pack = product.get("imagePack") if isinstance(product.get("imagePack"), list) else []
    image_url = None
    for image in image_pack:
        if not isinstance(image, dict):
            continue
        small_image = image.get("small")
        if isinstance(small_image, dict) and small_image.get("url"):
            image_url = str(small_image.get("url"))
            break

    price_block = product.get("priceV2") if isinstance(product.get("priceV2"), dict) else {}
    now_block = price_block.get("now") if isinstance(price_block.get("now"), dict) else {}
    amount = now_block.get("amount")

    title = normalize_space(str(product.get("title") or ""))
    source_url = build_ah_web_url(product.get("webPath"), fallback_product_id=product_id)
    ah_id = f"wi{int(product_id)}"

    return {
        "ah_product_id": int(product_id),
        "ah_id": ah_id,
        "title": title,
        "source_url": source_url,
        "quantity": int(suggestion.get("quantity") or 1),
        "image": image_url,
        "price": float(amount) if amount is not None else None,
        "unit": normalize_space(str(product.get("salesUnitSize") or "")) or None,
        "availability_label": normalize_space(str(availability.get("availabilityLabel") or "")) or None,
        "is_orderable": bool(availability.get("isOrderable")) if availability.get("isOrderable") is not None else None,
        "is_visible": bool(availability.get("isVisible")) if availability.get("isVisible") is not None else None,
    }


def build_product_data_from_suggested_product(suggested_product: dict[str, Any]) -> dict[str, Any]:
    return {
        "ah_id": suggested_product["ah_id"],
        "source_url": suggested_product["source_url"],
        "title": suggested_product["title"],
        "normalized_title": normalize_product_title(suggested_product["title"]),
        "image": suggested_product.get("image"),
        "price": suggested_product.get("price"),
        "unit": suggested_product.get("unit"),
        "description": None,
        "availability_label": suggested_product.get("availability_label"),
        "is_orderable": suggested_product.get("is_orderable"),
        "is_visible": suggested_product.get("is_visible"),
    }


def parse_ah_recipe_html(html: str, url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    recipe_schema = find_schema_object(soup, "Recipe")
    if recipe_schema is None:
        raise ValueError("Recipe metadata not found")

    name = clean_ah_title(str(recipe_schema.get("name", "")))
    if not name:
        raise ValueError("Recipe name not found")

    description = normalize_space(str(recipe_schema.get("description", ""))) or None
    image = first_non_empty_image(recipe_schema.get("image"))
    if not image:
        meta_image = soup.find("meta", {"property": "og:image"})
        image = meta_image.get("content") if meta_image else None

    ingredients_raw = [
        normalize_space(str(item))
        for item in recipe_schema.get("recipeIngredient", [])
        if normalize_space(str(item))
    ]
    if not ingredients_raw:
        ingredients_raw = extract_html_ingredient_lines(soup)

    ingredients = [parse_ingredient_text(item) for item in ingredients_raw]
    instruction_steps = extract_instruction_steps(recipe_schema, soup)
    if not instruction_steps:
        raise ValueError("Recipe instructions not found")

    return {
        "external_id": extract_ah_recipe_id(url),
        "native_recipe_id": extract_ah_numeric_recipe_id(html),
        "name": name,
        "normalized_name": normalize_recipe_name(name),
        "description": description,
        "image": image,
        "instruction_steps": instruction_steps,
        "instructions": "\n".join(instruction_steps),
        "base_persons": parse_recipe_yield(recipe_schema.get("recipeYield")),
        "ingredients": ingredients,
    }


def parse_ah_product_search_results(html: str) -> list[dict[str, str]]:
    soup = BeautifulSoup(html, "html.parser")
    results: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    for link in soup.select("a[href*='/producten/product/']"):
        href = normalize_space(str(link.get("href", "")))
        if not href:
            continue

        url = href if href.startswith("http") else f"https://www.ah.nl{href}"
        try:
            url = validate_ah_url(url)
        except ValueError:
            continue

        if url in seen_urls:
            continue

        seen_urls.add(url)
        title = normalize_space(str(link.get("aria-label", "")))
        if title:
            title = title.split(",", 1)[0]

        if not title:
            title_node = link.find_next("p")
            if title_node:
                title = normalize_space(title_node.get_text(" ", strip=True))

        results.append({
            "url": url,
            "title": clean_ah_title(title) if title else "",
        })

    return results


async def get_ah_anonymous_token(*, force_refresh: bool = False) -> str:
    global _AH_ANONYMOUS_TOKEN
    global _AH_ANONYMOUS_TOKEN_EXPIRES_AT

    if not force_refresh and _AH_ANONYMOUS_TOKEN and time.monotonic() < _AH_ANONYMOUS_TOKEN_EXPIRES_AT:
        return _AH_ANONYMOUS_TOKEN

    async with httpx.AsyncClient(headers=AH_API_HEADERS, timeout=20.0) as client:
        response = await client.post(
            AH_ANONYMOUS_TOKEN_URL,
            json={"clientId": AH_ANONYMOUS_CLIENT_ID},
        )
        response.raise_for_status()
        payload = response.json()

    access_token = str(payload.get("access_token") or "").strip()
    if not access_token:
        raise ValueError("Albert Heijn anonymous token response missing access token")

    expires_in = int(payload.get("expires_in") or 0)
    _AH_ANONYMOUS_TOKEN = access_token
    _AH_ANONYMOUS_TOKEN_EXPIRES_AT = time.monotonic() + max(expires_in - 60, 0)
    return access_token


async def fetch_ah_graphql(query: str, *, variables: dict[str, Any] | None = None) -> dict[str, Any]:
    async def send_request(access_token: str) -> httpx.Response:
        headers = {**AH_API_HEADERS, "Authorization": f"Bearer {access_token}"}
        async with httpx.AsyncClient(headers=headers, timeout=20.0) as client:
            return await client.post(
                AH_GRAPHQL_URL,
                json={"query": query, "variables": variables or {}},
            )

    access_token = await get_ah_anonymous_token()
    response = await send_request(access_token)
    if response.status_code == httpx.codes.UNAUTHORIZED:
        access_token = await get_ah_anonymous_token(force_refresh=True)
        response = await send_request(access_token)

    response.raise_for_status()
    payload = response.json()
    errors = payload.get("errors") or []
    if errors:
        first_error = errors[0]
        raise ValueError(str(first_error.get("message") or "Albert Heijn GraphQL query failed"))

    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError("Albert Heijn GraphQL response missing data")
    return data


def parse_ah_recipe_product_suggestions(payload: dict[str, Any]) -> list[dict[str, Any]]:
    items = payload.get("recipeProductSuggestionsV2")
    if not isinstance(items, list):
        return []

    suggestions: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue

        ingredient = item.get("ingredient")
        if not isinstance(ingredient, dict):
            continue

        ingredient_name = normalize_space(str(ingredient.get("name") or ""))
        if not ingredient_name:
            continue

        primary_product = parse_ah_suggested_product(item.get("productSuggestion"))
        selected_product = primary_product
        product_source = "primary" if primary_product else None

        parsed_alternative_sections: list[dict[str, Any]] = []
        alternative_sections = item.get("alternativeSections")
        if isinstance(alternative_sections, list):
            for section in alternative_sections:
                if not isinstance(section, dict):
                    continue
                parsed_products: list[dict[str, Any]] = []
                product_suggestions = section.get("productSuggestions")
                if isinstance(product_suggestions, list):
                    for alternative_suggestion in product_suggestions:
                        parsed_product = parse_ah_suggested_product(alternative_suggestion)
                        if parsed_product is not None:
                            parsed_products.append(parsed_product)
                if not parsed_products:
                    continue
                parsed_alternative_sections.append(
                    {
                        "title": normalize_space(str(section.get("title") or "")) or None,
                        "description": normalize_space(str(section.get("description") or "")) or None,
                        "products": parsed_products,
                    }
                )

        if selected_product is None:
            for section in parsed_alternative_sections:
                products = section.get("products") or []
                if products:
                    selected_product = products[0]
                    product_source = "alternative"
                    break

        suggestions.append(
            {
                "ingredient_id": ingredient.get("id"),
                "ingredient_name": ingredient_name,
                "ingredient_quantity": ingredient.get("quantityFloat"),
                "ingredient_unit": normalize_space(str(ingredient.get("quantityUnit") or "")) or None,
                "ingredient_raw_text": normalize_space(str(ingredient.get("rawIngredientText") or "")) or None,
                "optional": bool(item.get("optional")),
                "product_id": selected_product.get("ah_product_id") if selected_product else None,
                "product_quantity": selected_product.get("quantity") if selected_product else 1,
                "product": selected_product,
                "product_source": product_source,
                "alternative_sections": parsed_alternative_sections,
            }
        )

    return suggestions


async def fetch_ah_recipe_product_suggestions(recipe_id: int, number_of_servings: int) -> list[dict[str, Any]]:
    payload = await fetch_ah_graphql(
        AH_RECIPE_PRODUCT_SUGGESTIONS_QUERY,
        variables={
            "recipeId": recipe_id,
            "numberOfServings": number_of_servings,
        },
    )
    return parse_ah_recipe_product_suggestions(payload)


async def fetch_ah_html(url: str) -> str:
    current_url = validate_ah_url(url)

    async with httpx.AsyncClient(headers=AH_HEADERS, follow_redirects=False, timeout=20.0) as client:
        for _ in range(MAX_AH_REDIRECTS + 1):
            response = await client.get(current_url)
            if response.is_redirect:
                if response.next_request is None:
                    raise ValueError("Invalid redirect while loading Albert Heijn page")
                current_url = validate_ah_url(str(response.next_request.url))
                continue

            response.raise_for_status()
            return response.text

    raise ValueError("Too many redirects while loading Albert Heijn page")


async def import_ah_product(url: str) -> dict[str, Any]:
    return parse_ah_product_html(await fetch_ah_html(url), url)


async def scrape_ah_recipe(url: str) -> dict[str, Any]:
    return parse_ah_recipe_html(await fetch_ah_html(url), url)


async def find_ah_product_url(query: str) -> str | None:
    normalized_query = normalize_ingredient_name(query)
    if should_skip_product_matching(normalized_query):
        return None

    search_queries: list[str] = []
    original_query = normalize_space(query)
    if original_query:
        search_queries.append(original_query)
    if normalized_query and normalized_query not in {item.lower() for item in search_queries}:
        search_queries.append(normalized_query)

    fallback_candidate: dict[str, str] | None = None
    for index, search_query in enumerate(search_queries):
        search_html = await fetch_ah_html(build_ah_search_url(search_query))
        candidates = parse_ah_product_search_results(search_html)
        best_candidate = select_best_candidate(query, candidates)
        if not best_candidate:
            continue

        if candidate_has_discouraged_extra_tokens(query, best_candidate["title"]) and index < len(search_queries) - 1:
            fallback_candidate = best_candidate
            continue

        if best_candidate:
            return best_candidate["url"]

    return fallback_candidate["url"] if fallback_candidate else None


def convert_to_base_unit(quantity: float, unit: str) -> tuple[float, str]:
    normalized_unit = normalize_unit(unit)
    base_unit, factor = BASE_UNIT_CONVERSIONS.get(normalized_unit, (normalized_unit, 1.0))
    return quantity * factor, base_unit


def round_quantity(quantity: float) -> float:
    rounded = round(quantity + 1e-9, 2)
    if abs(rounded - round(rounded)) < 1e-9:
        return float(int(round(rounded)))
    return rounded


def is_divisible(quantity: float, divisor: float) -> bool:
    if divisor == 0:
        return False
    return abs((quantity / divisor) - round(quantity / divisor)) < 1e-9


def choose_display_unit(quantity: float, base_unit: str) -> tuple[float, str]:
    if base_unit == "ml":
        if quantity >= 1000:
            return quantity / 1000, "l"
        if is_divisible(quantity, 15) and quantity <= 240:
            return quantity / 15, "el"
        if is_divisible(quantity, 5) and quantity <= 100:
            return quantity / 5, "tl"

    if base_unit == "g" and quantity >= 1000:
        return quantity / 1000, "kg"

    return quantity, base_unit


def aggregate_ingredients(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[tuple[str, str], float] = {}
    for item in items:
        name = normalize_space(str(item.get("name", ""))).lower()
        normalized_name = str(item.get("normalized_name") or normalize_ingredient_name(name))
        quantity = float(item.get("quantity", 0.0))
        base_quantity, base_unit = convert_to_base_unit(quantity, str(item.get("unit", "stuk")))
        key = (normalized_name, base_unit)
        buckets[key] = buckets.get(key, 0.0) + base_quantity

    aggregated: list[dict[str, Any]] = []
    for (normalized_name, base_unit), total in buckets.items():
        display_quantity, display_unit = choose_display_unit(total, base_unit)
        aggregated.append(
            {
                "name": normalized_name,
                "normalized_name": normalized_name,
                "quantity": round_quantity(display_quantity),
                "unit": display_unit,
                "base_quantity": round_quantity(total),
                "base_unit": base_unit,
            }
        )

    aggregated.sort(key=lambda item: (item["name"], item["unit"]))
    return aggregated


def format_shopping_line(quantity: float, unit: str, name: str) -> str:
    parts: list[str] = []
    if quantity > 0:
        parts.append(f"{quantity:g}")
    if unit:
        parts.append(unit)
    parts.append(name)
    return " ".join(part for part in parts if part)


def build_ah_search_url(query: str) -> str:
    return f"https://www.ah.nl/zoeken?query={quote(query)}"


def match_product_to_ingredient(normalized_name: str, products: list[Any]):
    if should_skip_product_matching(normalized_name):
        return None

    ingredient_tokens = tokenize_matching_text(normalized_name)

    if ingredient_tokens:
        scored_products: list[tuple[int, float, float, int, int, int, Any]] = []
        for product in products:
            normalized_title = getattr(product, "normalized_title", "")
            score = product_match_score(normalized_name, normalized_title)
            if score:
                scored_products.append((*score, product))

        if scored_products:
            scored_products.sort(key=lambda item: item[:-1], reverse=True)
            best_exact, best_ratio, best_product_ratio, best_overlap, _, _, best_product = scored_products[0]
            if best_exact or (best_ratio >= 1.0 and (best_product_ratio >= 0.5 or len(ingredient_tokens) == 1)) or best_overlap >= 2:
                return best_product

    return None
