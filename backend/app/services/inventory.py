"""Warehouse stock operations.

Every operation:

1. locks the affected ``inventory_items`` rows with ``SELECT … FOR UPDATE`` (multi-row
   operations lock in ascending id order so concurrent transfers cannot deadlock),
2. validates the business rule against the *locked* values (no lost updates / races),
3. updates the row(s) and appends one ledger row per affected item,
4. commits once – so a transfer's debit and credit succeed or fail together.

Database CHECK constraints (on_hand >= 0, reserved <= on_hand) are the last line of defence.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from typing import Any

from sqlalchemy import Select, and_, case, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.redis_cache import Cache, CacheDomain
from app.core.errors import InsufficientStockError, NotFoundError
from app.db.models import (
    InventoryItem,
    InventoryTransaction,
    Product,
    TransactionType,
    User,
    Warehouse,
)
from app.schemas.inventory import StockStatus
from app.services.catalog import CatalogService, _ilike_any
from app.services.common import PageParams, apply_sort, paginate

logger = logging.getLogger(__name__)

EFFECTIVE_SAFETY = func.coalesce(InventoryItem.safety_stock, Product.safety_stock)
EFFECTIVE_ROP = func.coalesce(InventoryItem.reorder_point, Product.reorder_point)

STATUS_EXPR = case(
    (InventoryItem.available_quantity <= 0, StockStatus.OUT_OF_STOCK.value),
    (InventoryItem.available_quantity <= EFFECTIVE_SAFETY, StockStatus.CRITICAL.value),
    (InventoryItem.available_quantity <= EFFECTIVE_ROP, StockStatus.LOW_STOCK.value),
    else_=StockStatus.HEALTHY.value,
)


def inventory_select() -> Select:
    return (
        select(
            InventoryItem,
            Product.sku,
            Product.name.label("product_name"),
            Product.category,
            Product.unit,
            Product.cost,
            Warehouse.code.label("warehouse_code"),
            Warehouse.name.label("warehouse_name"),
            EFFECTIVE_SAFETY.label("eff_safety"),
            EFFECTIVE_ROP.label("eff_rop"),
            STATUS_EXPR.label("status"),
        )
        .join(Product, Product.id == InventoryItem.product_id)
        .join(Warehouse, Warehouse.id == InventoryItem.warehouse_id)
    )


def row_to_item(row: Any) -> dict[str, Any]:
    item: InventoryItem = row[0]
    cost = float(row.cost)
    return {
        "id": item.id,
        "product_id": item.product_id,
        "sku": row.sku,
        "product_name": row.product_name,
        "category": row.category,
        "unit": row.unit,
        "warehouse_id": item.warehouse_id,
        "warehouse_code": row.warehouse_code,
        "warehouse_name": row.warehouse_name,
        "quantity_on_hand": item.quantity_on_hand,
        "reserved_quantity": item.reserved_quantity,
        "available_quantity": item.available_quantity,
        "safety_stock": int(row.eff_safety),
        "reorder_point": int(row.eff_rop),
        "unit_cost": cost,
        "stock_value": round(cost * item.quantity_on_hand, 2),
        "status": row.status,
        "updated_at": item.updated_at,
    }


class InventoryService:
    def __init__(self, session: AsyncSession, cache: Cache) -> None:
        self.session = session
        self.cache = cache
        self.catalog = CatalogService(session, cache)

    # ------------------------------------------------------------------ queries
    async def list_items(
        self,
        page: PageParams,
        *,
        warehouse_id: int | None = None,
        product_id: int | None = None,
        category: str | None = None,
        status: StockStatus | None = None,
        statuses: Sequence[StockStatus] | None = None,
        search: str | None = None,
        sort: str | None = None,
        only_stocked: bool = False,
    ) -> tuple[list[dict[str, Any]], int]:
        stmt = inventory_select()
        if warehouse_id:
            stmt = stmt.where(InventoryItem.warehouse_id == warehouse_id)
        if product_id:
            stmt = stmt.where(InventoryItem.product_id == product_id)
        if category:
            stmt = stmt.where(Product.category == category)
        if status:
            stmt = stmt.where(STATUS_EXPR.in_([status.value]))
        if statuses:
            stmt = stmt.where(STATUS_EXPR.in_([s.value for s in statuses]))
        if search:
            stmt = stmt.where(_ilike_any(search, Product.sku, Product.name))
        if only_stocked:
            stmt = stmt.where(InventoryItem.quantity_on_hand > 0)
        stmt = apply_sort(
            stmt,
            sort,
            {
                "id": InventoryItem.id,
                "sku": Product.sku,
                "product_name": Product.name,
                "warehouse_code": Warehouse.code,
                "quantity_on_hand": InventoryItem.quantity_on_hand,
                "reserved_quantity": InventoryItem.reserved_quantity,
                "available_quantity": InventoryItem.available_quantity,
                "reorder_point": EFFECTIVE_ROP,
                "stock_value": InventoryItem.quantity_on_hand * Product.cost,
                "updated_at": InventoryItem.updated_at,
                "status": case(
                    (STATUS_EXPR == "OUT_OF_STOCK", 0),
                    (STATUS_EXPR == "CRITICAL", 1),
                    (STATUS_EXPR == "LOW_STOCK", 2),
                    else_=3,
                ),
            },
            "sku,warehouse_code",
        )
        rows, total = await paginate(self.session, stmt, page)
        return [row_to_item(r) for r in rows], total

    async def get_item(self, item_id: int) -> dict[str, Any]:
        row = (await self.session.execute(inventory_select().where(InventoryItem.id == item_id))).first()
        if row is None:
            raise NotFoundError(f"Inventory item {item_id} not found")
        return row_to_item(row)

    async def _items_by_ids(self, ids: Sequence[int]) -> list[dict[str, Any]]:
        rows = (
            await self.session.execute(
                inventory_select()
                .where(InventoryItem.id.in_(ids))
                .order_by(InventoryItem.id)
                .execution_options(populate_existing=True)
            )
        ).all()
        by_id = {r[0].id: row_to_item(r) for r in rows}
        return [by_id[i] for i in ids if i in by_id]

    async def update_item_settings(
        self, item_id: int, safety_stock: int | None, reorder_point: int | None, fields: set[str]
    ) -> dict[str, Any]:
        item = await self.session.get(InventoryItem, item_id)
        if item is None:
            raise NotFoundError(f"Inventory item {item_id} not found")
        if "safety_stock" in fields:
            item.safety_stock = safety_stock
        if "reorder_point" in fields:
            item.reorder_point = reorder_point
        await self.session.commit()
        await self.cache.invalidate(CacheDomain.INVENTORY)
        self.session.expire_all()
        return await self.get_item(item_id)

    async def list_transactions(
        self,
        page: PageParams,
        *,
        product_id: int | None = None,
        warehouse_id: int | None = None,
        type_: TransactionType | None = None,
        reference: str | None = None,
        sort: str | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        stmt = (
            select(
                InventoryTransaction,
                Product.sku,
                Product.name.label("product_name"),
                Warehouse.code.label("warehouse_code"),
                User.full_name.label("actor_name"),
            )
            .join(Product, Product.id == InventoryTransaction.product_id)
            .join(Warehouse, Warehouse.id == InventoryTransaction.warehouse_id)
            .outerjoin(User, User.id == InventoryTransaction.actor_id)
        )
        if product_id:
            stmt = stmt.where(InventoryTransaction.product_id == product_id)
        if warehouse_id:
            stmt = stmt.where(InventoryTransaction.warehouse_id == warehouse_id)
        if type_:
            stmt = stmt.where(InventoryTransaction.type == type_)
        if reference:
            stmt = stmt.where(InventoryTransaction.reference == reference)
        stmt = apply_sort(
            stmt,
            sort,
            {
                "id": InventoryTransaction.id,
                "created_at": InventoryTransaction.created_at,
                "quantity": InventoryTransaction.quantity,
            },
            "-created_at",
        )
        rows, total = await paginate(self.session, stmt, page)
        return [
            self._tx_dict(r[0], r.sku, r.product_name, r.warehouse_code, r.actor_name) for r in rows
        ], total

    @staticmethod
    def _tx_dict(
        tx: InventoryTransaction,
        sku: str | None = None,
        product_name: str | None = None,
        warehouse_code: str | None = None,
        actor_name: str | None = None,
    ) -> dict[str, Any]:
        return {
            "id": tx.id,
            "product_id": tx.product_id,
            "warehouse_id": tx.warehouse_id,
            "sku": sku,
            "product_name": product_name,
            "warehouse_code": warehouse_code,
            "type": tx.type,
            "quantity": tx.quantity,
            "on_hand_delta": tx.on_hand_delta,
            "reserved_delta": tx.reserved_delta,
            "on_hand_after": tx.on_hand_after,
            "reserved_after": tx.reserved_after,
            "reference": tx.reference,
            "note": tx.note,
            "transfer_group": tx.transfer_group,
            "actor_id": tx.actor_id,
            "actor_name": actor_name,
            "created_at": tx.created_at,
        }

    # ------------------------------------------------------------------ primitives
    async def ensure_items(self, keys: Sequence[tuple[int, int]]) -> None:
        """Create missing inventory rows without taking row locks (ON CONFLICT DO NOTHING)."""
        await self.session.execute(
            pg_insert(InventoryItem)
            .values(
                [
                    {"product_id": p, "warehouse_id": w, "quantity_on_hand": 0, "reserved_quantity": 0}
                    for p, w in keys
                ]
            )
            .on_conflict_do_nothing(index_elements=["product_id", "warehouse_id"])
        )

    async def lock_items(
        self, keys: Sequence[tuple[int, int]], *, create: bool
    ) -> dict[tuple[int, int], InventoryItem]:
        """Lock (and optionally create) inventory rows for (product_id, warehouse_id) pairs.

        All rows are locked in ONE statement ordered by id, so two transactions locking
        overlapping sets always acquire locks in the same order and cannot deadlock.
        """
        if create:
            await self.ensure_items(keys)
        conditions = [and_(InventoryItem.product_id == p, InventoryItem.warehouse_id == w) for p, w in keys]
        items = (
            await self.session.scalars(
                select(InventoryItem)
                .where(or_(*conditions))
                .order_by(InventoryItem.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).all()
        return {(i.product_id, i.warehouse_id): i for i in items}

    def apply_change(
        self,
        item: InventoryItem,
        type_: TransactionType,
        *,
        quantity: int,
        on_hand_delta: int = 0,
        reserved_delta: int = 0,
        reference: str | None = None,
        note: str | None = None,
        actor_id: int | None = None,
        transfer_group: uuid.UUID | None = None,
    ) -> InventoryTransaction:
        """Validate and apply a change to a *locked* item, appending a ledger entry."""
        new_on_hand = item.quantity_on_hand + on_hand_delta
        new_reserved = item.reserved_quantity + reserved_delta
        available = item.quantity_on_hand - item.reserved_quantity
        if new_on_hand < 0 or new_reserved > new_on_hand:
            raise InsufficientStockError(
                f"Insufficient available stock: requested {quantity}, available {available}",
                details={
                    "product_id": item.product_id,
                    "warehouse_id": item.warehouse_id,
                    "requested": quantity,
                    "available": available,
                    "on_hand": item.quantity_on_hand,
                    "reserved": item.reserved_quantity,
                },
            )
        if new_reserved < 0:
            raise InsufficientStockError(
                f"Cannot release {quantity} units: only {item.reserved_quantity} reserved",
                code="INSUFFICIENT_RESERVATION",
                details={"reserved": item.reserved_quantity, "requested": quantity},
            )
        item.quantity_on_hand = new_on_hand
        item.reserved_quantity = new_reserved
        tx = InventoryTransaction(
            product_id=item.product_id,
            warehouse_id=item.warehouse_id,
            type=type_,
            quantity=quantity,
            on_hand_delta=on_hand_delta,
            reserved_delta=reserved_delta,
            on_hand_after=new_on_hand,
            reserved_after=new_reserved,
            reference=reference,
            note=note,
            actor_id=actor_id,
            transfer_group=transfer_group,
        )
        self.session.add(tx)
        return tx

    async def _finish(
        self, items: Sequence[InventoryItem], txs: Sequence[InventoryTransaction]
    ) -> dict[str, Any]:
        await self.session.flush()
        return {
            "items": await self._items_by_ids([i.id for i in items]),
            "transactions": [self._tx_dict(t) for t in txs],
        }

    async def after_commit(self) -> None:
        await self.cache.invalidate(CacheDomain.INVENTORY)

    # ------------------------------------------------------------------ operations
    # Each op flushes but does NOT commit: the route wraps it with idempotency + commit.
    async def _single(
        self,
        type_: TransactionType,
        product_id: int,
        warehouse_id: int,
        quantity: int,
        *,
        on_hand_sign: int,
        reserved_sign: int,
        reference: str | None,
        note: str | None,
        actor_id: int | None,
        create: bool,
    ) -> dict[str, Any]:
        product, warehouse = await self.catalog.ensure_active(product_id, warehouse_id)
        items = await self.lock_items([(product_id, warehouse_id)], create=create)
        item = items.get((product_id, warehouse_id))
        if item is None:
            raise InsufficientStockError(
                f"No stock of {product.sku} in warehouse {warehouse.code}",
                details={"requested": quantity, "available": 0},
            )
        tx = self.apply_change(
            item,
            type_,
            quantity=quantity,
            on_hand_delta=on_hand_sign * quantity,
            reserved_delta=reserved_sign * quantity,
            reference=reference,
            note=note,
            actor_id=actor_id,
        )
        logger.info(
            "stock operation",
            extra={
                "op": type_.value,
                "product_id": product_id,
                "warehouse_id": warehouse_id,
                "quantity": quantity,
            },
        )
        return await self._finish([item], [tx])

    async def receive(
        self,
        product_id: int,
        warehouse_id: int,
        quantity: int,
        *,
        reference: str | None,
        note: str | None,
        actor_id: int | None,
    ) -> dict[str, Any]:
        return await self._single(
            TransactionType.PURCHASE_RECEIPT,
            product_id,
            warehouse_id,
            quantity,
            on_hand_sign=1,
            reserved_sign=0,
            reference=reference,
            note=note,
            actor_id=actor_id,
            create=True,
        )

    async def return_stock(
        self,
        product_id: int,
        warehouse_id: int,
        quantity: int,
        *,
        reference: str | None,
        note: str | None,
        actor_id: int | None,
    ) -> dict[str, Any]:
        return await self._single(
            TransactionType.RETURN,
            product_id,
            warehouse_id,
            quantity,
            on_hand_sign=1,
            reserved_sign=0,
            reference=reference,
            note=note,
            actor_id=actor_id,
            create=True,
        )

    async def issue(
        self,
        product_id: int,
        warehouse_id: int,
        quantity: int,
        *,
        reference: str | None,
        note: str | None,
        actor_id: int | None,
        type_: TransactionType = TransactionType.ISSUE,
    ) -> dict[str, Any]:
        return await self._single(
            type_,
            product_id,
            warehouse_id,
            quantity,
            on_hand_sign=-1,
            reserved_sign=0,
            reference=reference,
            note=note,
            actor_id=actor_id,
            create=False,
        )

    async def reserve(
        self,
        product_id: int,
        warehouse_id: int,
        quantity: int,
        *,
        reference: str | None,
        note: str | None,
        actor_id: int | None,
    ) -> dict[str, Any]:
        return await self._single(
            TransactionType.RESERVATION,
            product_id,
            warehouse_id,
            quantity,
            on_hand_sign=0,
            reserved_sign=1,
            reference=reference,
            note=note,
            actor_id=actor_id,
            create=False,
        )

    async def release(
        self,
        product_id: int,
        warehouse_id: int,
        quantity: int,
        *,
        reference: str | None,
        note: str | None,
        actor_id: int | None,
    ) -> dict[str, Any]:
        return await self._single(
            TransactionType.RESERVATION_RELEASE,
            product_id,
            warehouse_id,
            quantity,
            on_hand_sign=0,
            reserved_sign=-1,
            reference=reference,
            note=note,
            actor_id=actor_id,
            create=False,
        )

    async def adjust(
        self,
        product_id: int,
        warehouse_id: int,
        quantity_change: int,
        *,
        reference: str | None,
        note: str | None,
        actor_id: int | None,
    ) -> dict[str, Any]:
        sign = 1 if quantity_change > 0 else -1
        return await self._single(
            TransactionType.ADJUSTMENT,
            product_id,
            warehouse_id,
            abs(quantity_change),
            on_hand_sign=sign,
            reserved_sign=0,
            reference=reference,
            note=note,
            actor_id=actor_id,
            create=sign > 0,
        )

    async def transfer(
        self,
        product_id: int,
        from_warehouse_id: int,
        to_warehouse_id: int,
        quantity: int,
        *,
        reference: str | None,
        note: str | None,
        actor_id: int | None,
    ) -> dict[str, Any]:
        product, source_wh = await self.catalog.ensure_active(product_id, from_warehouse_id)
        await self.catalog.ensure_active(product_id, to_warehouse_id)
        # Make sure the destination row exists (no lock), then lock both rows in id order.
        await self.ensure_items([(product_id, to_warehouse_id)])
        items = await self.lock_items(
            [(product_id, from_warehouse_id), (product_id, to_warehouse_id)], create=False
        )
        source = items.get((product_id, from_warehouse_id))
        dest = items[(product_id, to_warehouse_id)]
        if source is None:
            raise InsufficientStockError(
                f"No stock of {product.sku} in warehouse {source_wh.code}",
                details={"requested": quantity, "available": 0},
            )
        group = uuid.uuid4()
        out_tx = self.apply_change(
            source,
            TransactionType.TRANSFER_OUT,
            quantity=quantity,
            on_hand_delta=-quantity,
            reference=reference,
            note=note,
            actor_id=actor_id,
            transfer_group=group,
        )
        in_tx = self.apply_change(
            dest,
            TransactionType.TRANSFER_IN,
            quantity=quantity,
            on_hand_delta=quantity,
            reference=reference,
            note=note,
            actor_id=actor_id,
            transfer_group=group,
        )
        logger.info(
            "stock transfer",
            extra={
                "product_id": product_id,
                "from": from_warehouse_id,
                "to": to_warehouse_id,
                "quantity": quantity,
                "transfer_group": str(group),
            },
        )
        return await self._finish([source, dest], [out_tx, in_tx])
