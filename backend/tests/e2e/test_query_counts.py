"""N+1 guard: the number of SQL statements per request must not grow with the row count."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import event

from app.db.database import get_engine, get_sessionmaker
from app.db.models import (
    ForecastPoint,
    ForecastRun,
    InventoryItem,
    Product,
    PurchaseOrder,
    PurchaseOrderLine,
    Supplier,
    Warehouse,
)

from .helpers import ok

pytestmark = pytest.mark.e2e
API = "/api/v1"


@contextmanager
def count_queries() -> Iterator[list[str]]:
    statements: list[str] = []

    def before(conn, cursor, statement, params, context, executemany) -> None:
        statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", before)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", before)


async def add_rows(n: int, offset: int) -> None:
    """n products, each with a PO, an inventory item and a forecast run, so every endpoint under
    test returns n more rows (inventory, forecasts, restocking and shortages included)."""
    today = datetime.now(UTC).date()
    async with get_sessionmaker()() as s:
        sup = Supplier(name=f"Sup {offset}", lead_time_days=3)
        wh = Warehouse(code=f"W{offset}", name="W")
        s.add_all([sup, wh])
        await s.flush()
        for i in range(n):
            p = Product(sku=f"P{offset}-{i}", name="p", cost=Decimal(1), price=Decimal(2), supplier_id=sup.id)
            s.add(p)
            await s.flush()
            s.add(
                PurchaseOrder(
                    po_number=f"PO-{offset}-{i}",
                    supplier_id=sup.id,
                    warehouse_id=wh.id,
                    lines=[PurchaseOrderLine(product_id=p.id, quantity_ordered=1, unit_cost=Decimal(1))],
                )
            )
            s.add(InventoryItem(product_id=p.id, warehouse_id=wh.id, quantity_on_hand=0))
            s.add(
                ForecastRun(
                    product_id=p.id,
                    warehouse_id=wh.id,
                    horizon_days=3,
                    model_name="moving_average",
                    model_version="1",
                    history_days=30,
                    total_predicted=6.0,
                    avg_daily_demand=2.0,
                    metrics={"mae": 1.0},
                    details={},
                    points=[
                        ForecastPoint(
                            forecast_date=today + timedelta(days=d), predicted=2.0, lower=1.0, upper=3.0
                        )
                        for d in range(3)
                    ],
                )
            )
        await s.commit()


@pytest.mark.parametrize(
    "path",
    [
        "/products?page_size=100",
        "/purchase-orders?page_size=100",
        "/inventory?page_size=100",
        "/forecasts?page_size=100",
        "/restocking",
        "/shortages?min_risk=NONE",
    ],
)
async def test_query_count_is_independent_of_row_count(client, auth, path: str) -> None:
    h = auth()
    await add_rows(3, 1)
    with count_queries() as small:
        ok(await client.get(f"{API}{path}", headers=h))
    await add_rows(30, 2)
    from app.cache.redis_cache import CacheDomain, get_cache

    await get_cache().invalidate(*CacheDomain)
    with count_queries() as large:
        body = ok(await client.get(f"{API}{path}", headers=h))
    # Guard against a vacuous comparison: the endpoint must actually return the added rows.
    assert body["total"] >= 33, f"{path} returned {body['total']} rows"
    assert len(large) == len(small), f"{path}: {len(small)} → {len(large)} queries (N+1?)"
    assert len(large) <= 10
