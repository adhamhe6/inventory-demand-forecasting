"""Products, warehouses and suppliers."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import Select, and_, case, exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.cache.redis_cache import Cache, CacheDomain
from app.core.errors import BusinessRuleError, ConflictError, NotFoundError
from app.db.models import (
    EntityStatus,
    InventoryItem,
    InventoryTransaction,
    Product,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    Sale,
    Supplier,
    Warehouse,
)
from app.schemas.catalog import (
    ProductCreate,
    ProductUpdate,
    SupplierCreate,
    SupplierUpdate,
    WarehouseCreate,
    WarehouseUpdate,
)
from app.services.common import PageParams, apply_sort, paginate

logger = logging.getLogger(__name__)

OPEN_PO_STATUSES = (
    PurchaseOrderStatus.DRAFT,
    PurchaseOrderStatus.SUBMITTED,
    PurchaseOrderStatus.CONFIRMED,
    PurchaseOrderStatus.PARTIALLY_RECEIVED,
)


def integrity_conflict(exc: IntegrityError, messages: dict[str, str]) -> ConflictError:
    """Translate a unique-constraint violation into a meaningful 409."""
    text = str(exc.orig)
    for constraint, message in messages.items():
        if constraint in text:
            return ConflictError(message, code="DUPLICATE")
    return ConflictError("The request conflicts with existing data", code="CONFLICT")


def _ilike_any(term: str, *cols: Any) -> Any:
    # Bound parameter (never string-formatted SQL); escape LIKE wildcards in user input.
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{escaped}%"
    return or_(*[c.ilike(pattern, escape="\\") for c in cols])


class CatalogService:
    def __init__(self, session: AsyncSession, cache: Cache) -> None:
        self.session = session
        self.cache = cache

    async def _commit(self, *domains: CacheDomain) -> None:
        await self.session.commit()
        await self.cache.invalidate(CacheDomain.CATALOG, *domains)

    # ------------------------------------------------------------------ suppliers
    async def get_supplier(self, supplier_id: int) -> Supplier:
        supplier = await self.session.get(Supplier, supplier_id)
        if supplier is None:
            raise NotFoundError(f"Supplier {supplier_id} not found")
        return supplier

    async def list_suppliers(
        self, page: PageParams, *, search: str | None, status: EntityStatus | None, sort: str | None
    ) -> tuple[list[Supplier], int]:
        stmt: Select[Any] = select(Supplier)
        if search:
            stmt = stmt.where(_ilike_any(search, Supplier.name, Supplier.contact_name, Supplier.email))
        if status:
            stmt = stmt.where(Supplier.status == status)
        stmt = apply_sort(
            stmt,
            sort,
            {
                "id": Supplier.id,
                "name": Supplier.name,
                "lead_time_days": Supplier.lead_time_days,
                "created_at": Supplier.created_at,
            },
            "name",
        )
        rows, total = await paginate(self.session, stmt, page)
        return [r[0] for r in rows], total

    async def create_supplier(self, data: SupplierCreate) -> Supplier:
        supplier = Supplier(**data.model_dump())
        self.session.add(supplier)
        try:
            await self.session.flush()
        except IntegrityError as exc:
            await self.session.rollback()
            raise integrity_conflict(
                exc, {"uq_suppliers_name": "A supplier with this name already exists"}
            ) from exc
        await self._commit()
        logger.info("supplier created", extra={"supplier_id": supplier.id})
        return supplier

    async def update_supplier(self, supplier_id: int, data: SupplierUpdate) -> Supplier:
        supplier = await self.get_supplier(supplier_id)
        for key, value in data.model_dump(exclude_unset=True).items():
            setattr(supplier, key, value)
        try:
            await self.session.flush()
        except IntegrityError as exc:
            await self.session.rollback()
            raise integrity_conflict(
                exc, {"uq_suppliers_name": "A supplier with this name already exists"}
            ) from exc
        await self._commit(CacheDomain.PURCHASING)
        await self.session.refresh(supplier)
        return supplier

    async def supplier_stats(self, supplier_id: int) -> dict[str, Any]:
        po_total = (
            select(
                PurchaseOrderLine.purchase_order_id.label("po_id"),
                func.sum(PurchaseOrderLine.quantity_ordered * PurchaseOrderLine.unit_cost).label("amount"),
            )
            .group_by(PurchaseOrderLine.purchase_order_id)
            .subquery()
        )
        row = (
            await self.session.execute(
                select(
                    func.count(PurchaseOrder.id),
                    func.count(PurchaseOrder.id).filter(PurchaseOrder.status.in_(OPEN_PO_STATUSES)),
                    func.coalesce(
                        func.sum(po_total.c.amount).filter(
                            PurchaseOrder.status != PurchaseOrderStatus.CANCELLED
                        ),
                        0,
                    ),
                    func.avg(
                        case(
                            (PurchaseOrder.received_date <= PurchaseOrder.expected_delivery_date, 1.0),
                            else_=0.0,
                        )
                    ).filter(PurchaseOrder.status == PurchaseOrderStatus.RECEIVED),
                    func.avg(PurchaseOrder.received_date - PurchaseOrder.order_date).filter(
                        PurchaseOrder.status == PurchaseOrderStatus.RECEIVED
                    ),
                )
                .select_from(PurchaseOrder)
                .outerjoin(po_total, po_total.c.po_id == PurchaseOrder.id)
                .where(PurchaseOrder.supplier_id == supplier_id)
            )
        ).one()
        product_count = await self.session.scalar(
            select(func.count(Product.id)).where(Product.supplier_id == supplier_id)
        )
        return {
            "total_purchase_orders": int(row[0]),
            "open_purchase_orders": int(row[1]),
            "total_spend": float(row[2] or 0),
            "on_time_rate": None if row[3] is None else round(float(row[3]), 4),
            "avg_actual_lead_time_days": None if row[4] is None else round(float(row[4]), 2),
            "product_count": int(product_count or 0),
        }

    # ------------------------------------------------------------------ warehouses
    async def get_warehouse(self, warehouse_id: int) -> Warehouse:
        warehouse = await self.session.get(Warehouse, warehouse_id)
        if warehouse is None:
            raise NotFoundError(f"Warehouse {warehouse_id} not found")
        return warehouse

    async def list_warehouses(
        self, page: PageParams, *, search: str | None, status: EntityStatus | None, sort: str | None
    ) -> tuple[list[Warehouse], int]:
        stmt: Select[Any] = select(Warehouse)
        if search:
            stmt = stmt.where(_ilike_any(search, Warehouse.name, Warehouse.code, Warehouse.location))
        if status:
            stmt = stmt.where(Warehouse.status == status)
        stmt = apply_sort(
            stmt,
            sort,
            {
                "id": Warehouse.id,
                "code": Warehouse.code,
                "name": Warehouse.name,
                "created_at": Warehouse.created_at,
            },
            "code",
        )
        rows, total = await paginate(self.session, stmt, page)
        return [r[0] for r in rows], total

    async def create_warehouse(self, data: WarehouseCreate) -> Warehouse:
        warehouse = Warehouse(**data.model_dump())
        self.session.add(warehouse)
        try:
            await self.session.flush()
        except IntegrityError as exc:
            await self.session.rollback()
            raise integrity_conflict(
                exc, {"uq_warehouses_code": f"Warehouse code '{data.code}' already exists"}
            ) from exc
        await self._commit()
        logger.info("warehouse created", extra={"warehouse_id": warehouse.id, "code": warehouse.code})
        return warehouse

    async def update_warehouse(self, warehouse_id: int, data: WarehouseUpdate) -> Warehouse:
        warehouse = await self.get_warehouse(warehouse_id)
        for key, value in data.model_dump(exclude_unset=True).items():
            setattr(warehouse, key, value)
        await self.session.flush()
        await self._commit(CacheDomain.INVENTORY)
        await self.session.refresh(warehouse)
        return warehouse

    async def warehouse_summaries(self) -> list[dict[str, Any]]:
        rop = func.coalesce(InventoryItem.reorder_point, Product.reorder_point)
        agg = (
            select(
                InventoryItem.warehouse_id.label("wid"),
                func.count(InventoryItem.id)
                .filter(InventoryItem.quantity_on_hand > 0)
                .label("product_count"),
                func.coalesce(func.sum(InventoryItem.quantity_on_hand), 0).label("total_units"),
                func.coalesce(func.sum(InventoryItem.reserved_quantity), 0).label("reserved_units"),
                func.coalesce(func.sum(InventoryItem.quantity_on_hand * Product.cost), 0).label("value"),
                func.count(InventoryItem.id).filter(InventoryItem.available_quantity <= rop).label("low"),
            )
            .join(Product, Product.id == InventoryItem.product_id)
            .group_by(InventoryItem.warehouse_id)
            .subquery()
        )
        rows = (
            await self.session.execute(
                select(Warehouse, agg).outerjoin(agg, agg.c.wid == Warehouse.id).order_by(Warehouse.code)
            )
        ).all()
        return [
            {
                **{
                    c: getattr(r[0], c)
                    for c in ("id", "code", "name", "location", "status", "created_at", "updated_at")
                },
                "product_count": int(r.product_count or 0),
                "total_units": int(r.total_units or 0),
                "reserved_units": int(r.reserved_units or 0),
                "inventory_value": round(float(r.value or 0), 2),
                "low_stock_items": int(r.low or 0),
            }
            for r in rows
        ]

    # ------------------------------------------------------------------ products
    async def get_product(self, product_id: int) -> Product:
        product = await self.session.scalar(
            select(Product).options(selectinload(Product.supplier)).where(Product.id == product_id)
        )
        if product is None:
            raise NotFoundError(f"Product {product_id} not found")
        return product

    async def list_products(
        self,
        page: PageParams,
        *,
        search: str | None,
        category: str | None,
        supplier_id: int | None,
        is_active: bool | None,
        sort: str | None,
    ) -> tuple[list[Product], int]:
        stmt: Select[Any] = select(Product).options(selectinload(Product.supplier))
        if search:
            stmt = stmt.where(_ilike_any(search, Product.sku, Product.name, Product.category))
        if category:
            stmt = stmt.where(Product.category == category)
        if supplier_id:
            stmt = stmt.where(Product.supplier_id == supplier_id)
        if is_active is not None:
            stmt = stmt.where(Product.is_active.is_(is_active))
        stmt = apply_sort(
            stmt,
            sort,
            {
                "id": Product.id,
                "sku": Product.sku,
                "name": Product.name,
                "category": Product.category,
                "price": Product.price,
                "cost": Product.cost,
                "created_at": Product.created_at,
            },
            "sku",
        )
        rows, total = await paginate(self.session, stmt, page)
        return [r[0] for r in rows], total

    async def list_categories(self) -> list[str]:
        return list(
            (await self.session.scalars(select(Product.category).distinct().order_by(Product.category))).all()
        )

    async def _validate_supplier_ref(self, supplier_id: int | None) -> None:
        if supplier_id is not None and await self.session.get(Supplier, supplier_id) is None:
            raise BusinessRuleError(f"Supplier {supplier_id} does not exist", code="INVALID_REFERENCE")

    async def create_product(self, data: ProductCreate) -> Product:
        await self._validate_supplier_ref(data.supplier_id)
        product = Product(**data.model_dump())
        self.session.add(product)
        try:
            await self.session.flush()
        except IntegrityError as exc:
            await self.session.rollback()
            raise integrity_conflict(exc, {"uq_products_sku": f"SKU '{data.sku}' already exists"}) from exc
        await self._commit()
        logger.info("product created", extra={"product_id": product.id, "sku": product.sku})
        return await self.get_product(product.id)

    async def update_product(self, product_id: int, data: ProductUpdate) -> Product:
        product = await self.get_product(product_id)
        changes = data.model_dump(exclude_unset=True)
        if "supplier_id" in changes:
            await self._validate_supplier_ref(changes["supplier_id"])
        for key, value in changes.items():
            setattr(product, key, value)
        await self.session.flush()
        await self._commit(CacheDomain.INVENTORY)
        self.session.expire(product)
        return await self.get_product(product_id)

    async def delete_product(self, product_id: int) -> None:
        """Hard-delete only products with no business history; otherwise ask to deactivate."""
        product = await self.get_product(product_id)
        referenced = await self.session.scalar(
            select(
                or_(
                    exists().where(InventoryTransaction.product_id == product_id),
                    exists().where(Sale.product_id == product_id),
                    exists().where(PurchaseOrderLine.product_id == product_id),
                    exists().where(
                        and_(InventoryItem.product_id == product_id, InventoryItem.quantity_on_hand > 0)
                    ),
                )
            )
        )
        if referenced:
            raise ConflictError(
                "Product has stock, sales or purchase history and cannot be deleted; deactivate it instead",
                code="PRODUCT_IN_USE",
            )
        await self.session.execute(
            InventoryItem.__table__.delete().where(InventoryItem.product_id == product_id)
        )
        await self.session.delete(product)
        await self._commit(CacheDomain.INVENTORY, CacheDomain.FORECASTS)
        logger.info("product deleted", extra={"product_id": product_id})

    async def ensure_active(self, product_id: int, warehouse_id: int) -> tuple[Product, Warehouse]:
        product = await self.session.get(Product, product_id)
        if product is None:
            raise NotFoundError(f"Product {product_id} not found", code="PRODUCT_NOT_FOUND")
        warehouse = await self.session.get(Warehouse, warehouse_id)
        if warehouse is None:
            raise NotFoundError(f"Warehouse {warehouse_id} not found", code="WAREHOUSE_NOT_FOUND")
        if warehouse.status != EntityStatus.ACTIVE:
            raise BusinessRuleError(f"Warehouse {warehouse.code} is inactive", code="WAREHOUSE_INACTIVE")
        return product, warehouse
