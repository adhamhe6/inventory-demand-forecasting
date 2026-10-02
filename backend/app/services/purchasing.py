"""Purchase-order workflow and receiving.

State machine (receiving transitions are only reachable through :meth:`receive`)::

    DRAFT ──submit──► SUBMITTED ──confirm──► CONFIRMED ──receive──► PARTIALLY_RECEIVED ──► RECEIVED
      │                   │                     │                        ▲      │
      └──────cancel───────┴──────cancel─────────┘                        └──────┘ receive
                                          (cancel only before any receipt)
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import Select, exists, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.cache.redis_cache import Cache, CacheDomain
from app.core.errors import BusinessRuleError, InvalidStateTransitionError, NotFoundError
from app.db.models import (
    EntityStatus,
    Product,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderReceipt,
    PurchaseOrderReceiptLine,
    PurchaseOrderStatus,
    Supplier,
    TransactionType,
    Warehouse,
)
from app.schemas.purchasing import POLineCreate, PurchaseOrderCreate, PurchaseOrderUpdate, ReceiveLine
from app.services.catalog import _ilike_any
from app.services.common import PageParams, apply_sort, paginate
from app.services.inventory import InventoryService

logger = logging.getLogger(__name__)
S = PurchaseOrderStatus

MANUAL_TRANSITIONS: dict[PurchaseOrderStatus, set[PurchaseOrderStatus]] = {
    S.DRAFT: {S.SUBMITTED, S.CANCELLED},
    S.SUBMITTED: {S.CONFIRMED, S.CANCELLED},
    S.CONFIRMED: {S.CANCELLED},
    S.PARTIALLY_RECEIVED: set(),
    S.RECEIVED: set(),
    S.CANCELLED: set(),
}
RECEIVABLE = {S.CONFIRMED, S.PARTIALLY_RECEIVED}
OPEN_STATUSES = (S.DRAFT, S.SUBMITTED, S.CONFIRMED, S.PARTIALLY_RECEIVED)


def allowed_transitions(status: PurchaseOrderStatus) -> list[PurchaseOrderStatus]:
    allowed = sorted(MANUAL_TRANSITIONS[status], key=list(S).index)
    if status in RECEIVABLE:
        allowed += [S.PARTIALLY_RECEIVED, S.RECEIVED] if status == S.CONFIRMED else [S.RECEIVED]
    return allowed


class PurchasingService:
    def __init__(self, session: AsyncSession, cache: Cache) -> None:
        self.session = session
        self.cache = cache

    async def _commit(self, *extra: CacheDomain) -> None:
        await self.session.commit()
        await self.cache.invalidate(CacheDomain.PURCHASING, *extra)

    # ------------------------------------------------------------------ reads
    async def _load(self, po_id: int, *, lock: bool = False) -> PurchaseOrder:
        if lock:
            # Lock the PO row first so concurrent receive/transition requests serialise.
            locked = await self.session.scalar(
                select(PurchaseOrder.id).where(PurchaseOrder.id == po_id).with_for_update()
            )
            if locked is None:
                raise NotFoundError(f"Purchase order {po_id} not found")
        po = await self.session.scalar(
            select(PurchaseOrder)
            .options(
                selectinload(PurchaseOrder.lines).selectinload(PurchaseOrderLine.product),
                selectinload(PurchaseOrder.receipts).selectinload(PurchaseOrderReceipt.lines),
                selectinload(PurchaseOrder.supplier),
                selectinload(PurchaseOrder.warehouse),
            )
            .where(PurchaseOrder.id == po_id)
            .execution_options(populate_existing=True)
        )
        if po is None:
            raise NotFoundError(f"Purchase order {po_id} not found")
        return po

    async def get(self, po_id: int) -> dict[str, Any]:
        return self.to_dict(await self._load(po_id))

    @staticmethod
    def to_dict(po: PurchaseOrder) -> dict[str, Any]:
        sku_by_product = {line.product_id: line.product.sku for line in po.lines}
        lines = [
            {
                "id": line.id,
                "product_id": line.product_id,
                "sku": line.product.sku,
                "product_name": line.product.name,
                "quantity_ordered": line.quantity_ordered,
                "quantity_received": line.quantity_received,
                "quantity_outstanding": line.quantity_ordered - line.quantity_received,
                "unit_cost": line.unit_cost,
                "line_total": (line.unit_cost * line.quantity_ordered).quantize(Decimal("0.01")),
            }
            for line in po.lines
        ]
        return {
            "id": po.id,
            "po_number": po.po_number,
            "supplier_id": po.supplier_id,
            "supplier_name": po.supplier.name,
            "warehouse_id": po.warehouse_id,
            "warehouse_code": po.warehouse.code,
            "status": po.status,
            "order_date": po.order_date,
            "expected_delivery_date": po.expected_delivery_date,
            "received_date": po.received_date,
            "submitted_at": po.submitted_at,
            "notes": po.notes,
            "total_amount": sum((ln["line_total"] for ln in lines), Decimal("0.00")),
            "total_units": sum(ln["quantity_ordered"] for ln in lines),
            "received_units": sum(ln["quantity_received"] for ln in lines),
            "line_count": len(lines),
            "created_at": po.created_at,
            "lines": lines,
            "receipts": [
                {
                    "id": r.id,
                    "receipt_key": r.receipt_key,
                    "received_at": r.received_at,
                    "received_by_id": r.received_by_id,
                    "notes": r.notes,
                    "lines": [
                        {
                            "purchase_order_line_id": rl.purchase_order_line_id,
                            "product_id": rl.product_id,
                            "sku": sku_by_product.get(rl.product_id, ""),
                            "quantity": rl.quantity,
                        }
                        for rl in r.lines
                    ],
                }
                for r in po.receipts
            ],
            "allowed_transitions": allowed_transitions(po.status),
        }

    async def list(
        self,
        page: PageParams,
        *,
        statuses: Sequence[PurchaseOrderStatus] | None = None,
        supplier_id: int | None = None,
        warehouse_id: int | None = None,
        product_id: int | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
        search: str | None = None,
        sort: str | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        totals = (
            select(
                PurchaseOrderLine.purchase_order_id.label("po_id"),
                func.sum(PurchaseOrderLine.quantity_ordered * PurchaseOrderLine.unit_cost).label("amount"),
                func.sum(PurchaseOrderLine.quantity_ordered).label("units"),
                func.sum(PurchaseOrderLine.quantity_received).label("received"),
                func.count().label("line_count"),
            )
            .group_by(PurchaseOrderLine.purchase_order_id)
            .subquery()
        )
        stmt: Select[Any] = (
            select(
                PurchaseOrder,
                Supplier.name.label("supplier_name"),
                Warehouse.code.label("warehouse_code"),
                totals.c.amount,
                totals.c.units,
                totals.c.received,
                totals.c.line_count,
            )
            .join(Supplier, Supplier.id == PurchaseOrder.supplier_id)
            .join(Warehouse, Warehouse.id == PurchaseOrder.warehouse_id)
            .outerjoin(totals, totals.c.po_id == PurchaseOrder.id)
        )
        if statuses:
            stmt = stmt.where(PurchaseOrder.status.in_(statuses))
        if supplier_id:
            stmt = stmt.where(PurchaseOrder.supplier_id == supplier_id)
        if warehouse_id:
            stmt = stmt.where(PurchaseOrder.warehouse_id == warehouse_id)
        if product_id:
            stmt = stmt.where(
                exists().where(
                    (PurchaseOrderLine.purchase_order_id == PurchaseOrder.id)
                    & (PurchaseOrderLine.product_id == product_id)
                )
            )
        if date_from:
            stmt = stmt.where(PurchaseOrder.order_date >= date_from)
        if date_to:
            stmt = stmt.where(PurchaseOrder.order_date <= date_to)
        if search:
            stmt = stmt.where(_ilike_any(search, PurchaseOrder.po_number, Supplier.name))
        stmt = apply_sort(
            stmt,
            sort,
            {
                "id": PurchaseOrder.id,
                "po_number": PurchaseOrder.po_number,
                "order_date": PurchaseOrder.order_date,
                "expected_delivery_date": PurchaseOrder.expected_delivery_date,
                "status": PurchaseOrder.status,
                "total_amount": totals.c.amount,
                "supplier_name": Supplier.name,
                "created_at": PurchaseOrder.created_at,
            },
            "-created_at",
        )
        rows, total = await paginate(self.session, stmt, page)
        items = [
            {
                "id": r[0].id,
                "po_number": r[0].po_number,
                "supplier_id": r[0].supplier_id,
                "supplier_name": r.supplier_name,
                "warehouse_id": r[0].warehouse_id,
                "warehouse_code": r.warehouse_code,
                "status": r[0].status,
                "order_date": r[0].order_date,
                "expected_delivery_date": r[0].expected_delivery_date,
                "received_date": r[0].received_date,
                "total_amount": Decimal(r.amount or 0).quantize(Decimal("0.01")),
                "total_units": int(r.units or 0),
                "received_units": int(r.received or 0),
                "line_count": int(r.line_count or 0),
                "created_at": r[0].created_at,
            }
            for r in rows
        ]
        return items, total

    # ------------------------------------------------------------------ writes
    async def _next_po_number(self) -> str:
        seq = await self.session.scalar(text("SELECT nextval('purchase_order_number_seq')"))
        return f"PO-{datetime.now(UTC):%Y}-{int(seq or 0):06d}"

    async def _build_lines(self, lines: Sequence[POLineCreate]) -> list[PurchaseOrderLine]:
        ids = [line.product_id for line in lines]
        products = {
            p.id: p for p in (await self.session.scalars(select(Product).where(Product.id.in_(ids)))).all()
        }
        missing = [i for i in ids if i not in products]
        if missing:
            raise BusinessRuleError(
                f"Unknown product id(s): {missing}",
                code="INVALID_REFERENCE",
                details={"product_ids": missing},
            )
        inactive = [products[i].sku for i in ids if not products[i].is_active]
        if inactive:
            raise BusinessRuleError(
                f"Inactive product(s) cannot be ordered: {inactive}", code="PRODUCT_INACTIVE"
            )
        return [
            PurchaseOrderLine(
                product_id=line.product_id,
                quantity_ordered=line.quantity_ordered,
                quantity_received=0,
                unit_cost=line.unit_cost if line.unit_cost is not None else products[line.product_id].cost,
            )
            for line in lines
        ]

    async def create(
        self, data: PurchaseOrderCreate, actor_id: int | None, *, commit: bool = True
    ) -> dict[str, Any]:
        supplier = await self.session.get(Supplier, data.supplier_id)
        if supplier is None:
            raise BusinessRuleError(f"Supplier {data.supplier_id} does not exist", code="INVALID_REFERENCE")
        if supplier.status != EntityStatus.ACTIVE:
            raise BusinessRuleError(f"Supplier '{supplier.name}' is inactive", code="SUPPLIER_INACTIVE")
        warehouse = await self.session.get(Warehouse, data.warehouse_id)
        if warehouse is None:
            raise BusinessRuleError(f"Warehouse {data.warehouse_id} does not exist", code="INVALID_REFERENCE")
        if warehouse.status != EntityStatus.ACTIVE:
            raise BusinessRuleError(f"Warehouse {warehouse.code} is inactive", code="WAREHOUSE_INACTIVE")
        today = datetime.now(UTC).date()
        expected = data.expected_delivery_date or today + timedelta(days=supplier.lead_time_days)
        if expected < today:
            raise BusinessRuleError("expected_delivery_date cannot be in the past", code="INVALID_DATE")
        po = PurchaseOrder(
            po_number=await self._next_po_number(),
            supplier_id=supplier.id,
            warehouse_id=warehouse.id,
            status=S.DRAFT,
            order_date=today,
            expected_delivery_date=expected,
            notes=data.notes,
            created_by_id=actor_id,
            lines=await self._build_lines(data.lines),
        )
        self.session.add(po)
        await self.session.flush()
        if commit:
            await self._commit()
        logger.info("purchase order created", extra={"po_id": po.id, "po_number": po.po_number})
        return await self.get(po.id)

    async def update(self, po_id: int, data: PurchaseOrderUpdate) -> dict[str, Any]:
        po = await self._load(po_id, lock=True)
        if po.status != S.DRAFT:
            raise InvalidStateTransitionError(
                f"Only DRAFT purchase orders can be edited (status is {po.status})"
            )
        changes = data.model_dump(exclude_unset=True)
        if "expected_delivery_date" in changes:
            if data.expected_delivery_date and data.expected_delivery_date < po.order_date:
                raise BusinessRuleError(
                    "expected_delivery_date must not be before order_date", code="INVALID_DATE"
                )
            po.expected_delivery_date = data.expected_delivery_date
        if "notes" in changes:
            po.notes = data.notes
        if data.lines is not None:
            po.lines.clear()
            await self.session.flush()
            po.lines.extend(await self._build_lines(data.lines))
        await self.session.flush()
        await self._commit()
        return await self.get(po_id)

    async def change_status(
        self, po_id: int, target: PurchaseOrderStatus, actor_id: int | None
    ) -> dict[str, Any]:
        po = await self._load(po_id, lock=True)
        if target not in MANUAL_TRANSITIONS[po.status]:
            hint = (
                " Use the receive endpoint to receive goods."
                if target in (S.PARTIALLY_RECEIVED, S.RECEIVED)
                else ""
            )
            raise InvalidStateTransitionError(
                f"Cannot change purchase order from {po.status} to {target}.{hint}",
                details={
                    "current": po.status,
                    "requested": target,
                    "allowed": allowed_transitions(po.status),
                },
            )
        if target == S.CANCELLED and any(line.quantity_received > 0 for line in po.lines):
            raise InvalidStateTransitionError("Cannot cancel a purchase order that has received goods")
        if target == S.SUBMITTED:
            po.submitted_at = datetime.now(UTC)
        old = po.status
        po.status = target
        await self.session.flush()
        await self._commit()
        logger.info(
            "purchase order status changed",
            extra={"po_id": po.id, "from": old.value, "to": target.value, "actor_id": actor_id},
        )
        return await self.get(po_id)

    async def delete_draft(self, po_id: int) -> None:
        po = await self._load(po_id, lock=True)
        if po.status != S.DRAFT:
            raise InvalidStateTransitionError("Only DRAFT purchase orders can be deleted; cancel it instead")
        await self.session.delete(po)
        await self._commit()

    async def receive(
        self,
        po_id: int,
        lines: Sequence[ReceiveLine] | None,
        *,
        receipt_key: str | None,
        notes: str | None,
        actor_id: int | None,
    ) -> tuple[dict[str, Any], dict[str, Any], bool]:
        """Receive goods against a PO. Returns (po, receipt, replayed).

        Idempotent per ``receipt_key``: a repeated key returns the original receipt without
        touching stock. All stock movements + PO updates commit in one transaction.
        """
        po = await self._load(po_id, lock=True)
        if receipt_key:
            existing = next((r for r in po.receipts if r.receipt_key == receipt_key), None)
            if existing is not None:
                po_dict = self.to_dict(po)
                receipt = next(r for r in po_dict["receipts"] if r["id"] == existing.id)
                logger.info("duplicate receipt ignored", extra={"po_id": po_id, "receipt_key": receipt_key})
                return po_dict, receipt, True
        if po.status not in RECEIVABLE:
            raise InvalidStateTransitionError(
                f"Purchase order {po.po_number} is {po.status}; only CONFIRMED or PARTIALLY_RECEIVED orders can be received",
                details={"current": po.status},
            )
        by_id = {line.id: line for line in po.lines}
        if lines is None:
            to_receive = [(ln, ln.quantity_ordered - ln.quantity_received) for ln in po.lines]
            to_receive = [(ln, q) for ln, q in to_receive if q > 0]
        else:
            to_receive = []
            for req in lines:
                line = by_id.get(req.line_id)
                if line is None:
                    raise BusinessRuleError(
                        f"Line {req.line_id} does not belong to purchase order {po.po_number}",
                        code="INVALID_REFERENCE",
                    )
                outstanding = line.quantity_ordered - line.quantity_received
                if req.quantity > outstanding:
                    raise BusinessRuleError(
                        f"Cannot receive {req.quantity} of {line.product.sku}: only {outstanding} outstanding",
                        code="OVER_RECEIPT",
                        details={"line_id": line.id, "outstanding": outstanding, "requested": req.quantity},
                    )
                to_receive.append((line, req.quantity))
        if not to_receive:
            raise BusinessRuleError(
                "Nothing left to receive on this purchase order", code="NOTHING_TO_RECEIVE"
            )

        inventory = InventoryService(self.session, self.cache)
        items = await inventory.lock_items(
            [(ln.product_id, po.warehouse_id) for ln, _ in to_receive], create=True
        )
        receipt = PurchaseOrderReceipt(
            purchase_order_id=po.id,
            receipt_key=receipt_key or f"auto-{uuid.uuid4().hex}",
            received_by_id=actor_id,
            notes=notes,
        )
        for line, qty in to_receive:
            inventory.apply_change(
                items[(line.product_id, po.warehouse_id)],
                TransactionType.PURCHASE_RECEIPT,
                quantity=qty,
                on_hand_delta=qty,
                reference=po.po_number,
                note=f"Receipt {receipt.receipt_key}",
                actor_id=actor_id,
            )
            line.quantity_received += qty
            receipt.lines.append(
                PurchaseOrderReceiptLine(
                    purchase_order_line_id=line.id, product_id=line.product_id, quantity=qty
                )
            )
        self.session.add(receipt)
        fully = all(ln.quantity_received == ln.quantity_ordered for ln in po.lines)
        po.status = S.RECEIVED if fully else S.PARTIALLY_RECEIVED
        if fully:
            po.received_date = datetime.now(UTC).date()
        await self.session.flush()
        await self._commit(CacheDomain.INVENTORY)
        logger.info(
            "purchase order received",
            extra={
                "po_id": po.id,
                "po_number": po.po_number,
                "status": po.status.value,
                "units": sum(q for _, q in to_receive),
                "receipt_key": receipt.receipt_key,
            },
        )
        po_dict = await self.get(po_id)
        return po_dict, next(r for r in po_dict["receipts"] if r["id"] == receipt.id), False

    async def open_quantities(self) -> dict[tuple[int, int], int]:
        """Outstanding (ordered - received) units per (product, warehouse) on open POs."""
        rows = (
            await self.session.execute(
                select(
                    PurchaseOrderLine.product_id,
                    PurchaseOrder.warehouse_id,
                    func.sum(PurchaseOrderLine.quantity_ordered - PurchaseOrderLine.quantity_received),
                )
                .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderLine.purchase_order_id)
                .where(PurchaseOrder.status.in_(OPEN_STATUSES))
                .group_by(PurchaseOrderLine.product_id, PurchaseOrder.warehouse_id)
            )
        ).all()
        return {(r[0], r[1]): int(r[2] or 0) for r in rows}
