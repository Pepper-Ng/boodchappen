from backend.app.services import aggregate_ingredients

def test_aggregate_ingredients():
    items=[{"name":"kipfilet","unit":"g","quantity":100},{"name":"kipfilet","unit":"g","quantity":150},{"name":"ui","unit":"stuk","quantity":2}]
    res=aggregate_ingredients(items)
    as_map={(i['name'],i['unit']):i['quantity'] for i in res}
    assert as_map[("kipfilet","g")] == 250
    assert as_map[("ui","stuk")] == 2
