import asyncio
from typing import Any

import pytest
from sqlalchemy import func, select

from app.cache.redis_cache import get_cache
from app.core.errors import BusinessRuleError, InvalidStateTransitionError
from app.db.database import get_sessionmaker
from app.db.models import InventoryItem, InventoryTransaction, PurchaseOrderStatus
from app.schemas.purchasing import PurchaseOrderCreate, ReceiveLine
from app.services.purchasing import PurchasingService

pytestmark = pytest.mark.integration
S = PurchaseOrderStatus


async def svc_call(name: str, *args: Any, **kw: Any) -> Any:
    async with get_sessionmaker()() as s:
        return await getattr(PurchasingService(s, get_cache()), name)(*args, **kw)


async def make_po(catalog: dict, qty1: int = 10, qty2: int = 5) -> dict:
    data = PurchaseOrderCreate(
        supplier_id=catalog["supplier"].id,
        warehouse_id=catalog["wa"].id,
        lines=[
            {"product_id": catalog["p1"].id, "quantity_ordered": qty1},
            {"product_id": catalog["p2"].id, "quantity_ordered": qty2, "unit_cost": "9.50"},
        ],
    )
    return await svc_call("create", data, None)


async def confirm(po_id: int) -> None:
    await svc_call("change_status", po_id, S.SUBMITTED, None)
    await svc_call("change_status", po_id, S.CONFIRMED, None)


async def test_create_defaults(catalog: dict) -> None:
    po = await make_po(catalog)
    assert po["status"] == S.DRAFT and po["po_number"].endswith("001001")
    assert str(po["lines"][0]["unit_cost"]) == "2.50"  # product cost
    assert str(po["total_amount"]) == "72.50"
    assert po["expected_delivery_date"] is not None
    assert po["allowed_transitions"] == [S.SUBMITTED, S.CANCELLED]


async def test_invalid_transitions_rejected(catalog: dict) -> None:
    po = await make_po(catalog)
    with pytest.raises(InvalidStateTransitionError):
        await svc_call("change_status", po["id"], S.CONFIRMED, None)  # must submit first
    with pytest.raises(InvalidStateTransitionError):
        await svc_call("change_status", po["id"], S.RECEIVED, None)  # only via receiving
    with pytest.raises(InvalidStateTransitionError):
        await svc_call("receive", po["id"], None, receipt_key=None, notes=None, actor_id=None)  # draft


async def test_partial_then_full_receipt_updates_stock_and_status(catalog: dict) -> None:
    po = await make_po(catalog)
    await confirm(po["id"])
    line1 = po["lines"][0]["id"]
    po2, receipt, replayed = await svc_call(
        "receive",
        po["id"],
        [ReceiveLine(line_id=line1, quantity=4)],
        receipt_key="GRN-A",
        notes=None,
        actor_id=None,
    )
    assert not replayed and po2["status"] == S.PARTIALLY_RECEIVED and receipt["lines"][0]["quantity"] == 4
    po3, _, _ = await svc_call("receive", po["id"], None, receipt_key="GRN-B", notes=None, actor_id=None)
    assert po3["status"] == S.RECEIVED and po3["received_date"] is not None
    assert [ln["quantity_outstanding"] for ln in po3["lines"]] == [0, 0]
    async with get_sessionmaker()() as s:
        stock = dict(
            (await s.execute(select(InventoryItem.product_id, InventoryItem.quantity_on_hand))).all()
        )
    assert stock == {catalog["p1"].id: 10, catalog["p2"].id: 5}
    with pytest.raises(InvalidStateTransitionError):  # nothing left; cannot receive again
        await svc_call("receive", po["id"], None, receipt_key="GRN-C", notes=None, actor_id=None)
    with pytest.raises(InvalidStateTransitionError):
        await svc_call("change_status", po["id"], S.CANCELLED, None)


async def test_duplicate_receipt_key_is_idempotent(catalog: dict) -> None:
    po = await make_po(catalog)
    await confirm(po["id"])
    line1 = po["lines"][0]["id"]
    args = (po["id"], [ReceiveLine(line_id=line1, quantity=3)])
    _, r1, rep1 = await svc_call("receive", *args, receipt_key="DN-77", notes=None, actor_id=None)
    _, r2, rep2 = await svc_call("receive", *args, receipt_key="DN-77", notes=None, actor_id=None)
    assert (rep1, rep2) == (False, True) and r1["id"] == r2["id"]
    async with get_sessionmaker()() as s:
        assert await s.scalar(select(func.count()).select_from(InventoryTransaction)) == 1
        assert await s.scalar(select(InventoryItem.quantity_on_hand)) == 3


async def test_concurrent_duplicate_receipts_apply_once(catalog: dict) -> None:
    po = await make_po(catalog)
    await confirm(po["id"])
    results = await asyncio.gather(
        *[
            svc_call("receive", po["id"], None, receipt_key="SAME-KEY", notes=None, actor_id=None)
            for _ in range(5)
        ]
    )
    assert sum(1 for _, _, replayed in results if not replayed) == 1
    async with get_sessionmaker()() as s:
        assert await s.scalar(select(func.sum(InventoryItem.quantity_on_hand))) == 15


async def test_over_receipt_rejected(catalog: dict) -> None:
    po = await make_po(catalog)
    await confirm(po["id"])
    with pytest.raises(BusinessRuleError) as exc:
        await svc_call(
            "receive",
            po["id"],
            [ReceiveLine(line_id=po["lines"][0]["id"], quantity=11)],
            receipt_key=None,
            notes=None,
            actor_id=None,
        )
    assert exc.value.code == "OVER_RECEIPT"


async def test_cancel_and_open_quantities(catalog: dict) -> None:
    po = await make_po(catalog)
    other = await make_po(catalog, qty1=7, qty2=1)
    await svc_call("change_status", other["id"], S.CANCELLED, None)
    open_q = await svc_call("open_quantities")
    assert open_q[(catalog["p1"].id, catalog["wa"].id)] == 10  # cancelled PO not counted
    assert po["status"] == S.DRAFT
