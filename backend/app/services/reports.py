"""Reporting & dashboard aggregations. All heavy lifting is done in SQL (GROUP BY), and the
expensive, frequently requested results are cached in Redis with domain-versioned keys."""

from __future__ import annotations

from collections import Counter
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal

from sqlalchemy import Date, case, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.redis_cache import Cache, CacheDomain
from app.db.models import (
    ForecastPoint,
    ForecastRun,
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
from app.schemas.forecasting import RiskLevel
from app.services.catalog import CatalogService
from app.services.forecasting import latest_runs_subquery
from app.services.inventory import STATUS_EXPR
from app.services.purchasing import OPEN_STATUSES
from app.services.replenishment import ReplenishmentService

Granularity = Literal["day", "week", "month"]


def _day_start(d: date) -> datetime:
    return datetime.combine(d, time.min, tzinfo=UTC)


class ReportService:
    def __init__(self, session: AsyncSession, cache: Cache) -> None:
        self.session = session
        self.cache = cache

    # ------------------------------------------------------------------ dashboard
    async def dashboard(self) -> dict[str, Any]:
        return await self.cache.get_or_set(
            "reports:dashboard",
            [
                CacheDomain.INVENTORY,
                CacheDomain.SALES,
                CacheDomain.PURCHASING,
                CacheDomain.FORECASTS,
                CacheDomain.CATALOG,
            ],
            self._dashboard,
            params={"day": datetime.now(UTC).date().isoformat()},
            ttl=600,
        )

    async def _dashboard(self) -> dict[str, Any]:
        today = datetime.now(UTC).date()
        inv = (
            await self.session.execute(
                select(
                    func.count(func.distinct(InventoryItem.product_id)).filter(
                        InventoryItem.quantity_on_hand > 0
                    ),
                    func.coalesce(func.sum(InventoryItem.quantity_on_hand), 0),
                    func.coalesce(func.sum(InventoryItem.quantity_on_hand * Product.cost), 0),
                    func.count().filter(STATUS_EXPR.in_(["LOW_STOCK", "CRITICAL", "OUT_OF_STOCK"])),
                    func.count().filter(STATUS_EXPR == "OUT_OF_STOCK"),
                )
                .select_from(InventoryItem)
                .join(Product, Product.id == InventoryItem.product_id)
                .where(Product.is_active.is_(True))
            )
        ).one()
        active_products = await self.session.scalar(select(func.count()).where(Product.is_active.is_(True)))

        open_po = (
            await self.session.execute(
                select(
                    func.count(func.distinct(PurchaseOrder.id)),
                    func.coalesce(
                        func.sum(
                            (PurchaseOrderLine.quantity_ordered - PurchaseOrderLine.quantity_received)
                            * PurchaseOrderLine.unit_cost
                        ),
                        0,
                    ),
                )
                .select_from(PurchaseOrder)
                .join(PurchaseOrderLine, PurchaseOrderLine.purchase_order_id == PurchaseOrder.id)
                .where(PurchaseOrder.status.in_(OPEN_STATUSES))
            )
        ).one()

        def window(start: date, end: date) -> Any:
            return (Sale.sold_at >= _day_start(start)) & (Sale.sold_at < _day_start(end))

        cur_start, prev_start = today - timedelta(days=30), today - timedelta(days=60)
        sales = (
            await self.session.execute(
                select(
                    func.coalesce(
                        func.sum(Sale.quantity).filter(window(cur_start, today + timedelta(days=1))), 0
                    ),
                    func.coalesce(
                        func.sum(Sale.quantity * Sale.unit_price).filter(
                            window(cur_start, today + timedelta(days=1))
                        ),
                        0,
                    ),
                    func.coalesce(func.sum(Sale.quantity).filter(window(prev_start, cur_start)), 0),
                ).where(Sale.sold_at >= _day_start(prev_start))
            )
        ).one()
        units_30, revenue_30, units_prev = int(sales[0]), float(sales[1]), int(sales[2])

        analysis = await ReplenishmentService(self.session, self.cache).analyze()
        risk_counts = Counter(a["risk_level"] for a in analysis)
        forecast = await self.forecast_aggregate(days=30)

        return {
            "generated_at": datetime.now(UTC).isoformat(),
            "kpis": {
                "active_products": int(active_products or 0),
                "stocked_products": int(inv[0]),
                "total_units": int(inv[1]),
                "inventory_value": round(float(inv[2]), 2),
                "low_stock_items": int(inv[3]),
                "out_of_stock_items": int(inv[4]),
                "shortage_risk_items": risk_counts.get("CRITICAL", 0) + risk_counts.get("HIGH", 0),
                "open_purchase_orders": int(open_po[0]),
                "open_purchase_order_value": round(float(open_po[1]), 2),
                "sales_units_30d": units_30,
                "revenue_30d": round(revenue_30, 2),
                "sales_units_change_pct": round((units_30 - units_prev) / units_prev * 100, 1)
                if units_prev
                else None,
                "forecast_units_30d": round(sum(p["predicted"] for p in forecast), 1),
                "restock_recommendations": sum(1 for a in analysis if a["recommended_quantity"] > 0),
            },
            "sales_trend": await self.sales_series(today - timedelta(days=89), today, "day"),
            "inventory_trend": await self.inventory_trend(90),
            "forecast_trend": forecast,
            "risk_distribution": [
                {"risk_level": lvl.value, "count": risk_counts.get(lvl.value, 0)} for lvl in RiskLevel
            ],
            "warehouse_distribution": [
                {
                    "warehouse_id": w["id"],
                    "code": w["code"],
                    "name": w["name"],
                    "units": w["total_units"],
                    "value": w["inventory_value"],
                    "low_stock_items": w["low_stock_items"],
                }
                for w in await CatalogService(self.session, self.cache).warehouse_summaries()
            ],
            "category_value": await self.inventory_value("category"),
        }

    # ------------------------------------------------------------------ building blocks
    async def sales_series(
        self,
        start: date,
        end: date,
        granularity: Granularity,
        *,
        warehouse_id: int | None = None,
        product_id: int | None = None,
        category: str | None = None,
    ) -> list[dict[str, Any]]:
        bucket = cast(func.date_trunc(granularity, func.timezone("UTC", Sale.sold_at)), Date)
        stmt = (
            select(
                bucket.label("period"),
                func.sum(Sale.quantity).label("units"),
                func.sum(Sale.quantity * Sale.unit_price).label("revenue"),
                func.count(func.distinct(Sale.order_reference)).label("orders"),
            )
            .where(Sale.sold_at >= _day_start(start), Sale.sold_at < _day_start(end + timedelta(days=1)))
            .group_by(bucket)
            .order_by(bucket)
        )
        if warehouse_id:
            stmt = stmt.where(Sale.warehouse_id == warehouse_id)
        if product_id:
            stmt = stmt.where(Sale.product_id == product_id)
        if category:
            stmt = stmt.join(Product, Product.id == Sale.product_id).where(Product.category == category)
        rows = {r.period: r for r in (await self.session.execute(stmt)).all()}
        if granularity != "day":
            return [
                {
                    "period": p.isoformat(),
                    "units": int(r.units),
                    "revenue": round(float(r.revenue), 2),
                    "orders": int(r.orders),
                }
                for p, r in rows.items()
            ]
        out = []
        d = start
        while d <= end:  # zero-fill days without sales so charts have continuous axes
            r = rows.get(d)
            out.append(
                {
                    "period": d.isoformat(),
                    "units": int(r.units) if r else 0,
                    "revenue": round(float(r.revenue), 2) if r else 0.0,
                    "orders": int(r.orders) if r else 0,
                }
            )
            d += timedelta(days=1)
        return out

    async def inventory_trend(self, days: int, warehouse_id: int | None = None) -> list[dict[str, Any]]:
        """Reconstruct end-of-day on-hand units/value from the ledger, walking back from now."""
        today = datetime.now(UTC).date()
        start = today - timedelta(days=days - 1)
        cur_stmt = select(
            func.coalesce(func.sum(InventoryItem.quantity_on_hand), 0),
            func.coalesce(func.sum(InventoryItem.quantity_on_hand * Product.cost), 0),
        ).join(Product, Product.id == InventoryItem.product_id)
        day = cast(func.timezone("UTC", InventoryTransaction.created_at), Date)
        delta_stmt = (
            select(
                day.label("day"),
                func.sum(InventoryTransaction.on_hand_delta),
                func.sum(InventoryTransaction.on_hand_delta * Product.cost),
            )
            .join(Product, Product.id == InventoryTransaction.product_id)
            .where(InventoryTransaction.created_at >= _day_start(start + timedelta(days=1)))
            .group_by(day)
        )
        if warehouse_id:
            cur_stmt = cur_stmt.where(InventoryItem.warehouse_id == warehouse_id)
            delta_stmt = delta_stmt.where(InventoryTransaction.warehouse_id == warehouse_id)
        row = (await self.session.execute(cur_stmt)).one()
        units: float = float(row[0])
        value: float = float(row[1])
        deltas = {
            r[0]: (float(r[1] or 0), float(r[2] or 0)) for r in (await self.session.execute(delta_stmt)).all()
        }
        out = []
        d = today
        while d >= start:
            out.append({"date": d.isoformat(), "units": round(units), "value": round(value, 2)})
            du, dv = deltas.get(d, (0.0, 0.0))
            units, value = units - du, value - dv
            d -= timedelta(days=1)
        return out[::-1]

    async def forecast_aggregate(
        self, days: int = 30, warehouse_id: int | None = None
    ) -> list[dict[str, Any]]:
        """Sum of latest per-item forecasts for the next ``days`` days."""
        today = datetime.now(UTC).date()
        latest = latest_runs_subquery()
        stmt = (
            select(
                ForecastPoint.forecast_date,
                func.sum(ForecastPoint.predicted),
                func.sum(ForecastPoint.lower),
                func.sum(ForecastPoint.upper),
            )
            .join(ForecastRun, ForecastRun.id == ForecastPoint.run_id)
            .join(latest, latest.c.id == ForecastRun.id)
            .where(
                ForecastPoint.forecast_date >= today,
                ForecastPoint.forecast_date < today + timedelta(days=days),
            )
            .group_by(ForecastPoint.forecast_date)
            .order_by(ForecastPoint.forecast_date)
        )
        if warehouse_id:
            stmt = stmt.where(ForecastRun.warehouse_id == warehouse_id)
        return [
            {
                "date": r[0].isoformat(),
                "predicted": round(float(r[1]), 2),
                "lower": round(float(r[2]), 2),
                "upper": round(float(r[3]), 2),
            }
            for r in (await self.session.execute(stmt)).all()
        ]

    # ------------------------------------------------------------------ reports
    async def inventory_value(self, group_by: Literal["warehouse", "category"]) -> list[dict[str, Any]]:
        key = Warehouse.code if group_by == "warehouse" else Product.category
        rows = (
            await self.session.execute(
                select(
                    key.label("group"),
                    func.count(func.distinct(InventoryItem.product_id)).filter(
                        InventoryItem.quantity_on_hand > 0
                    ),
                    func.coalesce(func.sum(InventoryItem.quantity_on_hand), 0),
                    func.coalesce(func.sum(InventoryItem.quantity_on_hand * Product.cost), 0),
                    func.coalesce(func.sum(InventoryItem.quantity_on_hand * Product.price), 0),
                )
                .join(Product, Product.id == InventoryItem.product_id)
                .join(Warehouse, Warehouse.id == InventoryItem.warehouse_id)
                .group_by(key)
                .order_by(func.sum(InventoryItem.quantity_on_hand * Product.cost).desc())
            )
        ).all()
        return [
            {
                "group": r[0],
                "products": int(r[1]),
                "units": int(r[2]),
                "cost_value": round(float(r[3]), 2),
                "retail_value": round(float(r[4]), 2),
            }
            for r in rows
        ]

    async def sales_summary(
        self,
        start: date,
        end: date,
        granularity: Granularity,
        *,
        warehouse_id: int | None,
        category: str | None,
        top: int = 10,
    ) -> dict[str, Any]:
        async def compute() -> dict[str, Any]:
            series = await self.sales_series(
                start, end, granularity, warehouse_id=warehouse_id, category=category
            )
            stmt = (
                select(
                    Product.id,
                    Product.sku,
                    Product.name,
                    Product.category,
                    func.sum(Sale.quantity).label("units"),
                    func.sum(Sale.quantity * Sale.unit_price).label("revenue"),
                )
                .join(Product, Product.id == Sale.product_id)
                .where(Sale.sold_at >= _day_start(start), Sale.sold_at < _day_start(end + timedelta(days=1)))
                .group_by(Product.id)
                .order_by(func.sum(Sale.quantity * Sale.unit_price).desc())
                .limit(top)
            )
            if warehouse_id:
                stmt = stmt.where(Sale.warehouse_id == warehouse_id)
            if category:
                stmt = stmt.where(Product.category == category)
            top_rows = (await self.session.execute(stmt)).all()
            units = sum(p["units"] for p in series)
            revenue = sum(p["revenue"] for p in series)
            orders = sum(p["orders"] for p in series)
            return {
                "date_from": start.isoformat(),
                "date_to": end.isoformat(),
                "granularity": granularity,
                "totals": {
                    "units": units,
                    "revenue": round(revenue, 2),
                    "orders": orders,
                    "avg_order_value": round(revenue / orders, 2) if orders else 0.0,
                },
                "series": series,
                "top_products": [
                    {
                        "product_id": r.id,
                        "sku": r.sku,
                        "name": r.name,
                        "category": r.category,
                        "units": int(r.units),
                        "revenue": round(float(r.revenue), 2),
                    }
                    for r in top_rows
                ],
            }

        return await self.cache.get_or_set(
            "reports:sales_summary",
            [CacheDomain.SALES, CacheDomain.CATALOG],
            compute,
            params={"s": start, "e": end, "g": granularity, "w": warehouse_id, "c": category, "t": top},
        )

    async def supplier_performance(self) -> list[dict[str, Any]]:
        po_value = (
            select(
                PurchaseOrderLine.purchase_order_id.label("po_id"),
                func.sum(PurchaseOrderLine.quantity_ordered * PurchaseOrderLine.unit_cost).label("value"),
                func.sum(PurchaseOrderLine.quantity_ordered).label("ordered"),
                func.sum(PurchaseOrderLine.quantity_received).label("received"),
            )
            .group_by(PurchaseOrderLine.purchase_order_id)
            .subquery()
        )
        received = PurchaseOrder.status == PurchaseOrderStatus.RECEIVED
        rows = (
            await self.session.execute(
                select(
                    Supplier.id,
                    Supplier.name,
                    Supplier.lead_time_days,
                    Supplier.status,
                    func.count(PurchaseOrder.id),
                    func.count(PurchaseOrder.id).filter(PurchaseOrder.status.in_(OPEN_STATUSES)),
                    func.count(PurchaseOrder.id).filter(received),
                    func.coalesce(
                        func.sum(po_value.c.value).filter(
                            PurchaseOrder.status != PurchaseOrderStatus.CANCELLED
                        ),
                        0,
                    ),
                    func.avg(
                        case(
                            (PurchaseOrder.received_date <= PurchaseOrder.expected_delivery_date, 1.0),
                            else_=0.0,
                        )
                    ).filter(received),
                    func.avg(PurchaseOrder.received_date - PurchaseOrder.order_date).filter(received),
                    func.coalesce(func.sum(po_value.c.received), 0),
                    func.coalesce(
                        func.sum(po_value.c.ordered).filter(
                            PurchaseOrder.status != PurchaseOrderStatus.CANCELLED
                        ),
                        0,
                    ),
                    func.count(PurchaseOrder.id).filter(
                        PurchaseOrder.status.in_(OPEN_STATUSES[1:]),
                        PurchaseOrder.expected_delivery_date < datetime.now(UTC).date(),
                    ),
                )
                .outerjoin(PurchaseOrder, PurchaseOrder.supplier_id == Supplier.id)
                .outerjoin(po_value, po_value.c.po_id == PurchaseOrder.id)
                .group_by(Supplier.id)
                .order_by(Supplier.name)
            )
        ).all()
        return [
            {
                "supplier_id": r[0],
                "supplier_name": r[1],
                "promised_lead_time_days": r[2],
                "status": r[3],
                "total_purchase_orders": int(r[4]),
                "open_purchase_orders": int(r[5]),
                "received_purchase_orders": int(r[6]),
                "total_spend": round(float(r[7]), 2),
                "on_time_rate": None if r[8] is None else round(float(r[8]), 4),
                "avg_actual_lead_time_days": None if r[9] is None else round(float(r[9]), 1),
                "fill_rate": round(float(r[10]) / float(r[11]), 4) if r[11] else None,
                "overdue_purchase_orders": int(r[12]),
            }
            for r in rows
        ]

    async def purchase_order_summary(self) -> dict[str, Any]:
        rows = (
            await self.session.execute(
                select(
                    PurchaseOrder.status,
                    func.count(func.distinct(PurchaseOrder.id)),
                    func.coalesce(
                        func.sum(PurchaseOrderLine.quantity_ordered * PurchaseOrderLine.unit_cost), 0
                    ),
                    func.coalesce(
                        func.sum(PurchaseOrderLine.quantity_ordered - PurchaseOrderLine.quantity_received), 0
                    ),
                )
                .join(PurchaseOrderLine, PurchaseOrderLine.purchase_order_id == PurchaseOrder.id)
                .group_by(PurchaseOrder.status)
            )
        ).all()
        by_status = {
            r[0].value: {"count": int(r[1]), "value": round(float(r[2]), 2), "outstanding_units": int(r[3])}
            for r in rows
        }
        today = datetime.now(UTC).date()
        overdue = (
            await self.session.execute(
                select(
                    PurchaseOrder.id,
                    PurchaseOrder.po_number,
                    Supplier.name,
                    PurchaseOrder.expected_delivery_date,
                    PurchaseOrder.status,
                )
                .join(Supplier, Supplier.id == PurchaseOrder.supplier_id)
                .where(
                    PurchaseOrder.status.in_(OPEN_STATUSES[1:]), PurchaseOrder.expected_delivery_date < today
                )
                .order_by(PurchaseOrder.expected_delivery_date)
                .limit(50)
            )
        ).all()
        return {
            "by_status": [
                {
                    "status": s.value,
                    **by_status.get(s.value, {"count": 0, "value": 0.0, "outstanding_units": 0}),
                }
                for s in PurchaseOrderStatus
            ],
            "overdue": [
                {
                    "id": r[0],
                    "po_number": r[1],
                    "supplier_name": r[2],
                    "expected_delivery_date": r[3].isoformat() if r[3] else None,
                    "status": r[4].value,
                    "days_overdue": (today - r[3]).days if r[3] else None,
                }
                for r in overdue
            ],
        }

    async def forecast_accuracy(self) -> dict[str, Any]:
        latest = latest_runs_subquery()
        rows = (
            await self.session.execute(
                select(
                    ForecastRun.model_name,
                    func.count(),
                    func.avg(ForecastRun.metrics["mae"].as_float()),
                    func.avg(ForecastRun.metrics["wape"].as_float()),
                    func.sum(ForecastRun.total_predicted),
                    func.max(ForecastRun.generated_at),
                )
                .join(latest, latest.c.id == ForecastRun.id)
                .group_by(ForecastRun.model_name)
            )
        ).all()
        return {
            "by_model": [
                {
                    "model_name": r[0],
                    "items": int(r[1]),
                    "avg_mae": None if r[2] is None else round(float(r[2]), 3),
                    "avg_wape": None if r[3] is None else round(float(r[3]), 4),
                    "total_predicted": round(float(r[4] or 0), 1),
                    "last_generated_at": r[5].isoformat() if r[5] else None,
                }
                for r in rows
            ],
            "items_forecasted": sum(int(r[1]) for r in rows),
            "last_generated_at": max((r[5] for r in rows if r[5]), default=None),
        }
