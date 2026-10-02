from datetime import UTC, datetime
from decimal import Decimal

import pytest

from app.api.export import _safe
from app.cache.redis_cache import Cache, CacheDomain
from app.services.sales import SalesService, parse_sold_at

PRODUCTS = {"SKU-1": 1}
WAREHOUSES = {"WH-A": 10}
PRICES = {1: Decimal("9.99")}
NOW = datetime(2030, 1, 1, tzinfo=UTC)


def row(**kw: str) -> dict[str, str]:
    base = {
        "sku": "sku-1",
        "warehouse_code": "wh-a",
        "sold_at": "2025-03-01",
        "quantity": "3",
        "order_reference": "SO-1",
    }
    return {**base, **kw}


def test_valid_row_defaults_price_and_normalises_codes() -> None:
    out = SalesService._validate_row(row(), PRODUCTS, WAREHOUSES, PRICES, NOW)
    assert out["product_id"] == 1 and out["warehouse_id"] == 10
    assert out["unit_price"] == Decimal("9.99") and out["quantity"] == 3


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"sku": "NOPE"}, "unknown sku"),
        ({"warehouse_code": "X"}, "unknown warehouse_code"),
        ({"quantity": "two"}, "integer"),
        ({"quantity": "0"}, "between"),
        ({"sold_at": "03/01/2025"}, "invalid sold_at"),
        ({"sold_at": "2031-01-01"}, "future"),
        ({"order_reference": ""}, "order_reference"),
        ({"unit_price": "abc"}, "number"),
        ({"unit_price": "-1"}, "range"),
    ],
)
def test_invalid_rows(override: dict[str, str], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        SalesService._validate_row(row(**override), PRODUCTS, WAREHOUSES, PRICES, NOW)


def test_parse_sold_at_variants() -> None:
    assert parse_sold_at("2025-01-02").tzinfo is not None
    assert parse_sold_at("2025-01-02T10:00:00Z").hour == 10
    assert parse_sold_at("2025-01-02T10:00:00").tzinfo == UTC


def test_csv_export_neutralises_formula_injection() -> None:
    assert _safe("=HYPERLINK(1)") == "'=HYPERLINK(1)"
    assert _safe("@cmd") == "'@cmd"
    assert _safe("Widget") == "Widget"
    assert _safe(5) == 5


async def test_cache_without_redis_computes_directly() -> None:
    cache = Cache(None)
    calls = 0

    async def compute() -> int:
        nonlocal calls
        calls += 1
        return 7

    assert await cache.get_or_set("x", [CacheDomain.SALES], compute) == 7
    assert await cache.get_or_set("x", [CacheDomain.SALES], compute) == 7
    assert calls == 2
    await cache.invalidate(CacheDomain.SALES)  # no-op, must not raise


def test_param_hash_is_order_independent() -> None:
    assert Cache._param_hash({"a": 1, "b": 2}) == Cache._param_hash({"b": 2, "a": 1})
    assert Cache._param_hash({"a": 1}) != Cache._param_hash({"a": 2})
