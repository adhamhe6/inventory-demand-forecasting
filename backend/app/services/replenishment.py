"""Stock-shortage detection and restocking recommendations.

Definitions (per product × warehouse)
-------------------------------------
* ``d``   – expected average daily demand: from the latest stored forecast (future points
  only); falls back to the trailing 28-day sales average when no forecast exists.
* ``L``   – lead time in days: preferred supplier's lead time, else the product's.
* ``D_L`` – expected demand during lead time = sum of the next ``L`` forecast days
  (extended with ``d`` beyond the forecast horizon).
* ``SS``  – safety stock (warehouse override, else product default).
* ``inbound`` – ordered-but-not-received units on open POs (DRAFT…PARTIALLY_RECEIVED).
  Drafts count for *recommendations*, so an item already turned into a draft PO is not
  recommended again (no duplicates).
* ``inbound_L`` – the part of inbound that can actually prevent a shortage: submitted /
  confirmed POs expected within the lead time (drafts haven't been sent to anyone).
* ``IP``  – inventory position = available + inbound (recommendations);
  risk uses available + inbound_L.
* ``ROP`` – reorder point = max(static product/warehouse ROP, product minimum stock, D_L + SS).
* ``S``   – order-up-to level = ROP + max(d × R, 1), where R is the review period (cover until the
  next planning cycle).

Risk levels
-----------
* CRITICAL – nothing available, or IP < D_L: will run out before a new order can arrive.
* HIGH     – IP < D_L + SS: safety stock will be breached within the lead time.
* MEDIUM   – IP ≤ ROP: at/below reorder point – order now.
* LOW      – IP ≤ ROP + d × R: will reach the reorder point within the next review period.
* NONE     – otherwise.

Timing check: if expected demand until the *next scheduled delivery* exceeds available stock,
the item will stock out before that delivery lands, so the risk is raised to at least HIGH
even when the inbound quantity itself is large.

Recommendation: when IP ≤ ROP, order ``ceil(S − IP)`` units.
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.redis_cache import Cache, CacheDomain
from app.core.config import get_settings
from app.core.errors import AppError, BusinessRuleError
from app.db.models import (
    EntityStatus,
    ForecastPoint,
    ForecastRun,
    InventoryItem,
    Product,
    PurchaseOrderStatus,
    Sale,
    Supplier,
    Warehouse,
)
from app.schemas.forecasting import DemandSource, RiskLevel
from app.schemas.purchasing import POLineCreate, PurchaseOrderCreate
from app.services.forecasting import latest_runs_subquery
from app.services.purchasing import PurchasingService

RISK_ORDER = {
    RiskLevel.CRITICAL: 0,
    RiskLevel.HIGH: 1,
    RiskLevel.MEDIUM: 2,
    RiskLevel.LOW: 3,
    RiskLevel.NONE: 4,
}
FALLBACK_WINDOW_DAYS = 28
ANALYSIS_DOMAINS = (
    CacheDomain.INVENTORY,
    CacheDomain.PURCHASING,
    CacheDomain.FORECASTS,
    CacheDomain.CATALOG,
    CacheDomain.SALES,
)


def classify(
    available: int, inbound: int, d_l: float, ss: int, rop: float, review_demand: float, d: float
) -> RiskLevel:
    ip = available + inbound
    if available <= 0 and (d > 0 or ss > 0 or rop > 0):
        return RiskLevel.CRITICAL
    if d <= 0 and ip > rop:
        return RiskLevel.NONE
    if ip < d_l:
        return RiskLevel.CRITICAL
    if ip < d_l + ss:
        return RiskLevel.HIGH
    if ip <= rop:
        return RiskLevel.MEDIUM
    if ip <= rop + review_demand:
        return RiskLevel.LOW
    return RiskLevel.NONE


def recommended_quantity(ip: int, rop: float, order_up_to: float) -> int:
    if ip > rop:
        return 0
    return max(math.ceil(order_up_to - ip), 1)


def lead_time_demand(points: list[float], d: float, lead_time: int) -> float:
    if lead_time <= 0:
        return 0.0
    head = points[:lead_time]
    return float(sum(head) + max(0, lead_time - len(head)) * d)


class ReplenishmentService:
    def __init__(self, session: AsyncSession, cache: Cache) -> None:
        self.session = session
        self.cache = cache
        self.review_days = get_settings().restock_review_period_days

    async def analyze(self) -> list[dict[str, Any]]:
        """Full analysis for every active item (cached; invalidated by any relevant write)."""
        return await self.cache.get_or_set(
            "replenishment:analysis",
            ANALYSIS_DOMAINS,
            self._compute,
            params={"review": self.review_days},
            ttl=900,
        )

    async def _compute(self) -> list[dict[str, Any]]:
        today = datetime.now(UTC).date()
        rows = (
            await self.session.execute(
                select(
                    InventoryItem.id,
                    InventoryItem.product_id,
                    InventoryItem.warehouse_id,
                    InventoryItem.quantity_on_hand,
                    InventoryItem.available_quantity,
                    func.coalesce(InventoryItem.safety_stock, Product.safety_stock).label("ss"),
                    func.coalesce(InventoryItem.reorder_point, Product.reorder_point).label("static_rop"),
                    Product.min_stock,
                    Product.sku,
                    Product.name,
                    Product.category,
                    Product.cost,
                    Product.lead_time_days,
                    Product.supplier_id,
                    Supplier.name.label("supplier_name"),
                    Supplier.lead_time_days.label("supplier_lead"),
                    Supplier.status.label("supplier_status"),
                    Warehouse.code,
                    Warehouse.name.label("warehouse_name"),
                )
                .join(Product, Product.id == InventoryItem.product_id)
                .join(Warehouse, Warehouse.id == InventoryItem.warehouse_id)
                .outerjoin(Supplier, Supplier.id == Product.supplier_id)
                .where(Product.is_active.is_(True), Warehouse.status == EntityStatus.ACTIVE)
            )
        ).all()
        open_lines = await PurchasingService(self.session, self.cache).open_lines()
        inbound: dict[tuple[int, int], int] = defaultdict(int)
        committed: dict[tuple[int, int], list[tuple[int, date | None]]] = defaultdict(list)
        for pid, wid, qty, expected, status in open_lines:
            inbound[(pid, wid)] += qty
            if status != PurchaseOrderStatus.DRAFT:
                committed[(pid, wid)].append((qty, expected))
        forecasts = await self._forecast_points(today)
        fallback = await self._historical_rates(today)

        results = []
        for r in rows:
            key = (r.product_id, r.warehouse_id)
            lead = int(r.supplier_lead if r.supplier_lead is not None else r.lead_time_days)
            if key in forecasts:
                run_id, pts, avg = forecasts[key]
                d = float(sum(pts) / len(pts)) if pts else avg
                source = DemandSource.FORECAST
            elif fallback.get(key, 0) > 0:
                run_id, pts, d, source = None, [], fallback[key], DemandSource.HISTORICAL_AVERAGE
            else:
                run_id, pts, d, source = None, [], 0.0, DemandSource.NONE
            d_l = lead_time_demand(pts, d, lead)
            ss = int(r.ss)
            available = int(r.available_quantity)
            inb = inbound.get(key, 0)
            ip = available + inb
            horizon_end = today + timedelta(days=lead)
            inb_lead = sum(q for q, exp in committed.get(key, []) if exp is None or exp <= horizon_end)
            # Overdue deliveries haven't arrived: assume "today" at the earliest.
            arrivals = [max(exp, today) for _, exp in committed.get(key, []) if exp is not None]
            next_inbound = min(arrivals) if arrivals else None
            # The minimum stock threshold is a hard floor for the reorder point.
            rop = max(float(r.static_rop), float(r.min_stock), d_l + ss)
            review_demand = d * self.review_days
            # Strictly above ROP, so an order placed now clears the trigger even with no demand.
            order_up_to = rop + max(review_demand, 1.0)
            risk = classify(available, inb_lead, d_l, ss, rop, review_demand, d)
            gap = False
            if d > 0 and next_inbound is not None:
                demand_until_delivery = lead_time_demand(pts, d, (next_inbound - today).days)
                gap = available < demand_until_delivery
                if gap and RISK_ORDER[risk] > RISK_ORDER[RiskLevel.HIGH]:
                    risk = RiskLevel.HIGH
            qty = recommended_quantity(ip, rop, order_up_to) if (d > 0 or rop > 0) else 0
            days_cover = round(available / d, 1) if d > 0 else None
            stockout = today + timedelta(days=math.floor(available / d)) if d > 0 else None
            cost = float(r.cost)
            results.append(
                {
                    "inventory_item_id": r.id,
                    "product_id": r.product_id,
                    "sku": r.sku,
                    "product_name": r.name,
                    "category": r.category,
                    "warehouse_id": r.warehouse_id,
                    "warehouse_code": r.code,
                    "warehouse_name": r.warehouse_name,
                    "supplier_id": r.supplier_id,
                    "supplier_name": r.supplier_name,
                    "quantity_on_hand": int(r.quantity_on_hand),
                    "available_quantity": available,
                    "inbound_quantity": inb,
                    "inbound_within_lead_time": inb_lead,
                    "next_inbound_date": next_inbound.isoformat() if next_inbound else None,
                    "stockout_before_inbound": gap,
                    "inventory_position": ip,
                    "safety_stock": ss,
                    "static_reorder_point": int(r.static_rop),
                    "reorder_point": round(rop, 2),
                    "lead_time_days": lead,
                    "review_period_days": self.review_days,
                    "avg_daily_demand": round(d, 3),
                    "demand_during_lead_time": round(d_l, 2),
                    "projected_stock_at_lead_time": round(available + inb_lead - d_l, 2),
                    "days_of_cover": days_cover,
                    "stockout_date": stockout.isoformat() if stockout else None,
                    "order_up_to_level": round(order_up_to, 2),
                    "recommended_quantity": qty,
                    "unit_cost": cost,
                    "estimated_cost": round(qty * cost, 2),
                    "demand_source": source.value,
                    "forecast_run_id": run_id,
                    "risk_level": risk.value,
                }
            )
        return results

    async def _forecast_points(self, today: date) -> dict[tuple[int, int], tuple[int, list[float], float]]:
        latest = latest_runs_subquery()
        runs = (
            await self.session.execute(
                select(
                    ForecastRun.id,
                    ForecastRun.product_id,
                    ForecastRun.warehouse_id,
                    ForecastRun.avg_daily_demand,
                ).join(latest, latest.c.id == ForecastRun.id)
            )
        ).all()
        by_run = {r.id: (r.product_id, r.warehouse_id, r.avg_daily_demand) for r in runs}
        points: dict[int, list[float]] = defaultdict(list)
        if by_run:
            for p in (
                await self.session.execute(
                    select(ForecastPoint.run_id, ForecastPoint.predicted)
                    .where(ForecastPoint.run_id.in_(list(by_run)), ForecastPoint.forecast_date >= today)
                    .order_by(ForecastPoint.run_id, ForecastPoint.forecast_date)
                )
            ).all():
                points[p.run_id].append(float(p.predicted))
        return {(pid, wid): (rid, points.get(rid, []), float(avg)) for rid, (pid, wid, avg) in by_run.items()}

    async def _historical_rates(self, today: date) -> dict[tuple[int, int], float]:
        since = datetime.combine(
            today - timedelta(days=FALLBACK_WINDOW_DAYS), datetime.min.time(), tzinfo=UTC
        )
        rows = (
            await self.session.execute(
                select(Sale.product_id, Sale.warehouse_id, func.sum(Sale.quantity))
                .where(Sale.sold_at >= since)
                .group_by(Sale.product_id, Sale.warehouse_id)
            )
        ).all()
        return {(r[0], r[1]): float(r[2]) / FALLBACK_WINDOW_DAYS for r in rows}

    # ------------------------------------------------------------------ views
    @staticmethod
    def _risk_view(a: dict[str, Any]) -> dict[str, Any]:
        risk = RiskLevel(a["risk_level"])
        position = a["available_quantity"] + a["inbound_within_lead_time"]
        reason, action = {
            RiskLevel.CRITICAL: (
                "Out of stock"
                if a["available_quantity"] <= 0
                else f"Expected lead-time demand ({a['demand_during_lead_time']:.0f}) exceeds stock + inbound ({position})",
                "Expedite: order immediately or transfer stock from another warehouse",
            ),
            RiskLevel.HIGH: (
                f"Safety stock ({a['safety_stock']}) will be breached within the {a['lead_time_days']}-day lead time",
                "Place a replenishment order now",
            ),
            RiskLevel.MEDIUM: (
                f"Inventory position {position} is at/below reorder point {a['reorder_point']:.0f}",
                "Reorder within this review cycle",
            ),
            RiskLevel.LOW: ("Approaching reorder point within the review period", "Monitor; plan next order"),
            RiskLevel.NONE: ("Stock covers expected demand", "No action needed"),
        }[risk]
        if a["stockout_before_inbound"] and a["available_quantity"] > 0:
            reason = f"Expected to run out around {a['stockout_date']}, before the next delivery on {a['next_inbound_date']}"
            action = "Expedite the open purchase order or transfer stock from another warehouse"
        return {**a, "reason": reason, "recommended_action": action}

    @staticmethod
    def sort_rows(rows: list[dict[str, Any]], sort: str, allowed: set[str]) -> list[dict[str, Any]]:
        """Stable multi-key sort (``risk,-estimated_cost``); ``risk`` sorts by severity.

        Unknown fields are rejected (allow-list), and ``None`` values always sort last.
        """
        out = list(rows)
        for part in reversed([p.strip() for p in sort.split(",") if p.strip()]):
            desc = part.startswith("-")
            name = part.lstrip("-+")
            if name not in allowed:
                raise AppError(
                    f"Cannot sort by '{name}'", code="INVALID_SORT", details={"allowed": sorted(allowed)}
                )

            def key(row: dict[str, Any], name: str = name) -> Any:
                return RISK_ORDER[RiskLevel(row["risk_level"])] if name == "risk" else row.get(name)

            present = [r for r in out if key(r) is not None]
            missing = [r for r in out if key(r) is None]
            present.sort(key=key, reverse=desc)
            out = present + missing
        return out

    async def risks(
        self,
        *,
        warehouse_id: int | None = None,
        min_level: RiskLevel = RiskLevel.LOW,
        category: str | None = None,
        search: str | None = None,
    ) -> list[dict[str, Any]]:
        threshold = RISK_ORDER[min_level]
        out = []
        for a in await self.analyze():
            if RISK_ORDER[RiskLevel(a["risk_level"])] > threshold:
                continue
            if warehouse_id and a["warehouse_id"] != warehouse_id:
                continue
            if category and a["category"] != category:
                continue
            if search and search.lower() not in f"{a['sku']} {a['product_name']}".lower():
                continue
            out.append(self._risk_view(a))
        out.sort(
            key=lambda a: (
                RISK_ORDER[RiskLevel(a["risk_level"])],
                a["days_of_cover"] if a["days_of_cover"] is not None else 1e9,
            )
        )
        return out

    async def recommendations(
        self, *, warehouse_id: int | None = None, supplier_id: int | None = None, search: str | None = None
    ) -> list[dict[str, Any]]:
        out = []
        for a in await self.analyze():
            if a["recommended_quantity"] <= 0:
                continue
            if warehouse_id and a["warehouse_id"] != warehouse_id:
                continue
            if supplier_id and a["supplier_id"] != supplier_id:
                continue
            if search and search.lower() not in f"{a['sku']} {a['product_name']}".lower():
                continue
            rationale = (
                f"Position {a['inventory_position']} (available {a['available_quantity']} + inbound "
                f"{a['inbound_quantity']}) ≤ reorder point {a['reorder_point']:.0f} "
                f"(lead-time demand {a['demand_during_lead_time']:.0f} + safety {a['safety_stock']}). "
                f"Order up to {a['order_up_to_level']:.0f} = reorder point + "
                f"{a['review_period_days']}d review-period demand."
            )
            out.append({**a, "rationale": rationale})
        out.sort(key=lambda a: (RISK_ORDER[RiskLevel(a["risk_level"])], -a["estimated_cost"]))
        return out

    async def create_purchase_orders(
        self, selections: list[dict[str, Any]], actor_id: int | None
    ) -> tuple[list[int], list[str]]:
        """Group selected recommendations into one DRAFT PO per (supplier, warehouse)."""
        product_ids = {s["product_id"] for s in selections}
        products = {
            p.id: p
            for p in (await self.session.scalars(select(Product).where(Product.id.in_(product_ids)))).all()
        }
        groups: dict[tuple[int, int], list[POLineCreate]] = defaultdict(list)
        for s in selections:
            product = products.get(s["product_id"])
            if product is None:
                raise BusinessRuleError(f"Product {s['product_id']} not found", code="INVALID_REFERENCE")
            supplier_id = s.get("supplier_id") or product.supplier_id
            if supplier_id is None:
                raise BusinessRuleError(
                    f"Product {product.sku} has no preferred supplier; choose one explicitly",
                    code="SUPPLIER_REQUIRED",
                )
            lines = groups[(supplier_id, s["warehouse_id"])]
            if any(line.product_id == product.id for line in lines):
                raise BusinessRuleError(
                    f"Product {product.sku} selected twice for the same order", code="DUPLICATE_LINE"
                )
            lines.append(POLineCreate(product_id=product.id, quantity_ordered=s["quantity"]))
        purchasing = PurchasingService(self.session, self.cache)
        ids, numbers = [], []
        for (supplier_id, warehouse_id), lines in groups.items():
            po = await purchasing.create(
                PurchaseOrderCreate(
                    supplier_id=supplier_id,
                    warehouse_id=warehouse_id,
                    lines=lines,
                    notes="Created from restocking recommendations",
                ),
                actor_id,
                commit=False,
            )
            ids.append(po["id"])
            numbers.append(po["po_number"])
        # All-or-nothing: either every grouped PO is created or none.
        await self.session.commit()
        await self.cache.invalidate(CacheDomain.PURCHASING)
        return ids, numbers
