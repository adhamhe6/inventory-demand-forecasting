"""Inventory operations against PostgreSQL: invariants, atomicity and concurrency."""

import asyncio
from typing import Any

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.cache.redis_cache import get_cache
from app.core.errors import InsufficientStockError, NotFoundError
from app.db.database import get_sessionmaker
from app.db.models import InventoryItem, InventoryTransaction, TransactionType

pytestmark = pytest.mark.integration


async def run_op(name: str, *args: Any, **kw: Any) -> dict[str, Any]:
    from app.services.inventory import InventoryService

    async with get_sessionmaker()() as s:
        svc = InventoryService(s, get_cache())
        result = await getattr(svc, name)(
            *args, reference=kw.pop("reference", None), note=kw.pop("note", None), actor_id=None, **kw
        )
        await s.commit()
        return result


async def item(pid: int, wid: int) -> InventoryItem | None:
    async with get_sessionmaker()() as s:
        return await s.scalar(
            select(InventoryItem).where(InventoryItem.product_id == pid, InventoryItem.warehouse_id == wid)
        )


async def test_receive_creates_item_and_ledger(catalog: dict) -> None:
    p, wa = catalog["p1"], catalog["wa"]
    res = await run_op("receive", p.id, wa.id, 40, reference="GRN-1")
    assert res["items"][0]["quantity_on_hand"] == 40
    assert res["items"][0]["available_quantity"] == 40
    tx = res["transactions"][0]
    assert (
        tx["type"] == TransactionType.PURCHASE_RECEIPT
        and tx["on_hand_after"] == 40
        and tx["reference"] == "GRN-1"
    )


async def test_issue_more_than_available_fails_without_side_effects(catalog: dict) -> None:
    p, wa = catalog["p1"], catalog["wa"]
    await run_op("receive", p.id, wa.id, 10)
    await run_op("reserve", p.id, wa.id, 6)
    with pytest.raises(InsufficientStockError) as exc:
        await run_op("issue", p.id, wa.id, 5)  # only 4 available (6 reserved)
    assert exc.value.details["available"] == 4
    i = await item(p.id, wa.id)
    assert (i.quantity_on_hand, i.reserved_quantity, i.available_quantity) == (10, 6, 4)


async def test_reservation_lifecycle(catalog: dict) -> None:
    p, wa = catalog["p1"], catalog["wa"]
    await run_op("receive", p.id, wa.id, 20)
    r = await run_op("reserve", p.id, wa.id, 15)
    assert r["items"][0]["available_quantity"] == 5 and r["items"][0]["quantity_on_hand"] == 20
    with pytest.raises(InsufficientStockError):
        await run_op("reserve", p.id, wa.id, 6)
    with pytest.raises(InsufficientStockError) as exc:
        await run_op("release", p.id, wa.id, 16)
    assert exc.value.code == "INSUFFICIENT_RESERVATION"
    r = await run_op("release", p.id, wa.id, 15)
    assert r["items"][0]["available_quantity"] == 20


async def test_negative_adjustment_cannot_drop_below_reserved(catalog: dict) -> None:
    p, wa = catalog["p1"], catalog["wa"]
    await run_op("receive", p.id, wa.id, 10)
    await run_op("reserve", p.id, wa.id, 8)
    with pytest.raises(InsufficientStockError):
        await run_op("adjust", p.id, wa.id, -3, note="damaged")
    r = await run_op("adjust", p.id, wa.id, -2, note="damaged")
    assert r["items"][0]["quantity_on_hand"] == 8 and r["transactions"][0]["on_hand_delta"] == -2


async def test_transfer_is_atomic_and_linked(catalog: dict) -> None:
    p, wa, wb = catalog["p1"], catalog["wa"], catalog["wb"]
    await run_op("receive", p.id, wa.id, 30)
    r = await run_op("transfer", p.id, wa.id, wb.id, 12)
    by_wh = {i["warehouse_id"]: i for i in r["items"]}
    assert by_wh[wa.id]["quantity_on_hand"] == 18 and by_wh[wb.id]["quantity_on_hand"] == 12
    groups = {t["transfer_group"] for t in r["transactions"]}
    assert len(groups) == 1 and None not in groups
    # A failing transfer leaves both sides untouched.
    with pytest.raises(InsufficientStockError):
        await run_op("transfer", p.id, wa.id, wb.id, 19)
    assert (await item(p.id, wa.id)).quantity_on_hand == 18
    assert (await item(p.id, wb.id)).quantity_on_hand == 12


async def test_unknown_product_or_warehouse(catalog: dict) -> None:
    with pytest.raises(NotFoundError) as exc:
        await run_op("receive", 9999, catalog["wa"].id, 1)
    assert exc.value.code == "PRODUCT_NOT_FOUND"
    with pytest.raises(NotFoundError):
        await run_op("receive", catalog["p1"].id, 9999, 1)


async def test_database_constraints_block_invalid_states(catalog: dict) -> None:
    """Defence in depth: even raw SQL cannot create negative or over-reserved stock."""
    p, wa = catalog["p1"], catalog["wa"]
    await run_op("receive", p.id, wa.id, 5)
    for stmt in (
        "UPDATE inventory_items SET quantity_on_hand = -1",
        "UPDATE inventory_items SET reserved_quantity = 6",
        "UPDATE inventory_items SET available_quantity = 99",  # generated column
    ):
        async with get_sessionmaker()() as s:
            with pytest.raises(Exception) as exc:
                await s.execute(text(stmt))
            assert isinstance(exc.value, IntegrityError) or "can only be updated to DEFAULT" in str(exc.value)


async def test_concurrent_issues_never_oversell(catalog: dict) -> None:
    """20 concurrent requests for 1 unit each against 10 units: exactly 10 succeed."""
    p, wa = catalog["p1"], catalog["wa"]
    await run_op("receive", p.id, wa.id, 10)
    results = await asyncio.gather(
        *[run_op("issue", p.id, wa.id, 1) for _ in range(20)], return_exceptions=True
    )
    ok = [r for r in results if not isinstance(r, Exception)]
    failed = [r for r in results if isinstance(r, InsufficientStockError)]
    assert len(ok) == 10 and len(failed) == 10
    assert (await item(p.id, wa.id)).quantity_on_hand == 0
    async with get_sessionmaker()() as s:
        balances = (
            await s.scalars(
                select(InventoryTransaction.on_hand_after).where(
                    InventoryTransaction.type == TransactionType.ISSUE
                )
            )
        ).all()
    assert sorted(balances) == list(range(10))  # every ledger balance is unique & consistent


async def test_opposite_concurrent_transfers_do_not_deadlock(catalog: dict) -> None:
    p, wa, wb = catalog["p1"], catalog["wa"], catalog["wb"]
    await run_op("receive", p.id, wa.id, 100)
    await run_op("receive", p.id, wb.id, 100)
    ops = []
    for _ in range(10):
        ops.append(run_op("transfer", p.id, wa.id, wb.id, 1))
        ops.append(run_op("transfer", p.id, wb.id, wa.id, 1))
    results = await asyncio.wait_for(asyncio.gather(*ops, return_exceptions=True), timeout=30)
    assert not [r for r in results if isinstance(r, Exception)]
    assert (await item(p.id, wa.id)).quantity_on_hand + (await item(p.id, wb.id)).quantity_on_hand == 200
