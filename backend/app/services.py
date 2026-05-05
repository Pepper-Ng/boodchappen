from __future__ import annotations
import json, re
import httpx
from bs4 import BeautifulSoup
from typing import List, Dict

UNIT_ALIASES = {"g":"g","gram":"g","kg":"kg","ml":"ml","l":"l","el":"el","tl":"tl","stuk":"stuk"}


def parse_number(val: str) -> float:
    val = val.replace(",", ".")
    m = re.search(r"\d+(?:\.\d+)?", val)
    return float(m.group(0)) if m else 0.0


def normalize_unit(unit: str) -> str:
    unit = unit.strip().lower()
    return UNIT_ALIASES.get(unit, unit or "stuk")

async def scrape_ah_recipe(url: str) -> dict:
    async with httpx.AsyncClient(timeout=20) as client:
        html = (await client.get(url)).text
    soup = BeautifulSoup(html, "html.parser")
    name = description = image = ""
    instructions = []
    ingredients: List[Dict] = []
    for s in soup.find_all("script", {"type":"application/ld+json"}):
        try:
            data = json.loads(s.text)
        except Exception:
            continue
        if isinstance(data, list):
            pool = data
        else:
            pool = [data]
        for obj in pool:
            if obj.get("@type") == "Recipe":
                name = obj.get("name", "")
                description = obj.get("description", "")
                image = obj.get("image", [""])[0] if isinstance(obj.get("image"), list) else obj.get("image", "")
                instructions = [i.get("text","") if isinstance(i,dict) else str(i) for i in obj.get("recipeInstructions", [])]
                for raw in obj.get("recipeIngredient", []):
                    parts = str(raw).split(" ",2)
                    qty = parse_number(parts[0]) if parts else 0
                    unit = normalize_unit(parts[1] if len(parts)>1 else "stuk")
                    ing_name = parts[2] if len(parts)>2 else str(raw)
                    ingredients.append({"name": ing_name.lower(), "quantity": qty, "unit": unit})
                return {"name":name,"description":description,"image":image,"instructions":"\n".join(instructions),"base_persons":4,"ingredients":ingredients}
    raise ValueError("Recipe metadata not found")

def aggregate_ingredients(items: List[dict]) -> List[dict]:
    bucket: Dict[tuple, float] = {}
    for i in items:
        key = (i["name"], i["unit"])
        bucket[key] = bucket.get(key, 0.0) + float(i["quantity"])
    return [{"name":k[0],"unit":k[1],"quantity":round(v,2)} for k,v in bucket.items()]
