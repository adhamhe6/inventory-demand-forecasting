"""Demo data generator.

Rather than random rows, this *simulates a year of operations* so every table is mutually
consistent: daily demand (trend × weekly seasonality × noise) is fulfilled from stock, a
reorder-point policy raises purchase orders that arrive after the supplier's (noisy) lead
time, and every movement is written to the inventory ledger. The final day is then shaped
into a demonstration scenario:

* healthy items, overstock, and items with growing / declining / intermittent demand
* items already in shortage (cycle-count shrinkage + a supplier hold), one out of stock
* items below their reorder point without an open order  → restocking recommendations
* items low on stock but already covered by an open PO   → *no* duplicate recommendation
* open POs in every workflow state (draft, submitted, confirmed, overdue, partially received)

Usage::

    python -m app.scripts.seed            # seed (refuses if products exist)
    python -m app.scripts.seed --reset    # wipe business data first
    python -m app.scripts.seed --skip-forecasts
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import math
import random
import time as _time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import Any

import numpy as np
from sqlalchemy import func, select, text

from app.cache.redis_cache import CacheDomain, get_cache
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.core.security import Role, hash_password
from app.db.database import dispose_engine, get_sessionmaker
from app.db.models import Product, User
from app.services.forecasting import ForecastService

logger = logging.getLogger("seed")

HISTORY_DAYS = 365
DEMO_PASSWORD = "DemoPass123!"  # documented demo-only credentials (seeded only on request)
WEEKDAY: dict[str, list[float]] = {
    "flat": [1, 1, 1, 1, 1, 1, 1],
    "office": [1.25, 1.2, 1.15, 1.1, 1.0, 0.35, 0.25],
    "retail": [0.85, 0.85, 0.9, 0.95, 1.1, 1.35, 1.1],
}

WAREHOUSES = [
    ("WH-NORTH", "North Distribution Center", "Chicago, IL", 1.0),
    ("WH-SOUTH", "South Distribution Center", "Dallas, TX", 0.75),
    ("WH-WEST", "West Fulfillment Hub", "Los Angeles, CA", 0.55),
]

SUPPLIERS = [
    # name, contact, email, phone, terms, lead, reliability (sd of delay days), status
    (
        "Northwind Electronics",
        "Dana Fischer",
        "orders@northwind-elec.example",
        "+1 312 555 0101",
        "Net 30",
        10,
        2,
        "ACTIVE",
    ),
    (
        "Summit Office Supply",
        "Raj Patel",
        "sales@summitoffice.example",
        "+1 214 555 0144",
        "Net 15",
        5,
        1,
        "ACTIVE",
    ),
    (
        "Harbor Home Goods",
        "Mei Lin",
        "trade@harborhome.example",
        "+1 213 555 0190",
        "Net 45",
        14,
        5,
        "ACTIVE",
    ),
    (
        "Ironclad Tools",
        "Marcus Webb",
        "b2b@ironcladtools.example",
        "+1 773 555 0122",
        "Net 30",
        21,
        3,
        "ACTIVE",
    ),
    (
        "CareWell Distributors",
        "Sofia Alvarez",
        "supply@carewell.example",
        "+1 469 555 0177",
        "Net 30",
        7,
        1,
        "ACTIVE",
    ),
    (
        "PackRight Packaging",
        "Tom Okafor",
        "orders@packright.example",
        "+1 312 555 0166",
        "Net 10",
        3,
        1,
        "ACTIVE",
    ),
    (
        "Legacy Imports Ltd",
        "Ann Moore",
        "info@legacyimports.example",
        "+1 555 555 0100",
        "Prepaid",
        45,
        7,
        "INACTIVE",
    ),
]

ALL = ("WH-NORTH", "WH-SOUTH", "WH-WEST")


@dataclass
class ProductSpec:
    sku: str
    name: str
    category: str
    unit: str
    cost: float
    price: float
    supplier: str
    base: float  # units/day at WH-NORTH
    weekly: str = "flat"
    trend: float = 0.0  # relative change over the year (+1.0 = doubles)
    intermittent: float = 0.0  # probability of a demand day (0 = smooth demand)
    scenario: str = "healthy"
    warehouses: tuple[str, ...] = ALL
    history_days: int = HISTORY_DAYS
    description: str = ""
    active: bool = True


PRODUCTS = [
    ProductSpec(
        "ELEC-USBC-1M",
        "USB-C Cable 1m",
        "Electronics",
        "pcs",
        2.10,
        9.99,
        "Northwind Electronics",
        18,
        "retail",
    ),
    ProductSpec(
        "ELEC-HDMI-2M",
        "HDMI 2.1 Cable 2m",
        "Electronics",
        "pcs",
        3.40,
        12.99,
        "Northwind Electronics",
        9,
        "retail",
        scenario="outstanding_po",
    ),
    ProductSpec(
        "ELEC-PWR-65W",
        "65W USB-C GaN Charger",
        "Electronics",
        "pcs",
        11.50,
        34.99,
        "Northwind Electronics",
        5,
        "retail",
        trend=1.4,
        scenario="growing",
    ),
    ProductSpec(
        "ELEC-MOUSE-WL",
        "Wireless Optical Mouse",
        "Electronics",
        "pcs",
        6.80,
        24.99,
        "Northwind Electronics",
        6,
        "retail",
    ),
    ProductSpec(
        "ELEC-KB-MECH",
        "Mechanical Keyboard TKL",
        "Electronics",
        "pcs",
        32.00,
        89.00,
        "Northwind Electronics",
        2,
        "retail",
        warehouses=("WH-NORTH", "WH-WEST"),
    ),
    ProductSpec(
        "ELEC-HUB-7P",
        "7-Port USB 3.0 Hub",
        "Electronics",
        "pcs",
        9.20,
        29.99,
        "Northwind Electronics",
        3.5,
        "retail",
        trend=0.5,
        scenario="shortage",
    ),
    ProductSpec(
        "ELEC-EARBUD-PRO",
        "Wireless Earbuds Pro",
        "Electronics",
        "pcs",
        22.00,
        69.99,
        "Northwind Electronics",
        6,
        "retail",
        trend=0.6,
        history_days=28,
        scenario="new",
        warehouses=("WH-NORTH", "WH-SOUTH"),
    ),
    ProductSpec(
        "OFF-PAPER-A4",
        "Copy Paper A4 (500 sheets)",
        "Office Supplies",
        "ream",
        3.10,
        7.49,
        "Summit Office Supply",
        25,
        "office",
        warehouses=("WH-NORTH", "WH-SOUTH"),
    ),
    ProductSpec(
        "OFF-PEN-BLK",
        "Ballpoint Pens Black (12)",
        "Office Supplies",
        "box",
        1.20,
        4.99,
        "Summit Office Supply",
        14,
        "office",
        warehouses=("WH-NORTH", "WH-SOUTH"),
    ),
    ProductSpec(
        "OFF-NOTE-A5",
        "Hardcover Notebook A5",
        "Office Supplies",
        "pcs",
        1.80,
        5.99,
        "Summit Office Supply",
        8,
        "office",
        trend=0.8,
        scenario="below_rop",
        warehouses=("WH-NORTH", "WH-SOUTH"),
    ),
    ProductSpec(
        "OFF-STAPLER",
        "Heavy Duty Stapler",
        "Office Supplies",
        "pcs",
        4.50,
        12.99,
        "Summit Office Supply",
        1.6,
        "office",
        intermittent=0.35,
        warehouses=("WH-NORTH", "WH-SOUTH"),
    ),
    ProductSpec(
        "OFF-TONER-HP",
        "Toner Cartridge 26A",
        "Office Supplies",
        "pcs",
        38.00,
        89.99,
        "Summit Office Supply",
        1.4,
        "office",
        intermittent=0.3,
        warehouses=("WH-NORTH",),
    ),
    ProductSpec(
        "OFF-FAX-ROLL",
        "Thermal Fax Paper Roll",
        "Office Supplies",
        "roll",
        1.10,
        3.99,
        "Legacy Imports Ltd",
        0,
        scenario="inactive",
        warehouses=("WH-NORTH",),
        active=False,
    ),
    ProductSpec(
        "HOME-MUG-CER",
        "Ceramic Coffee Mug 350ml",
        "Home & Kitchen",
        "pcs",
        2.20,
        8.99,
        "Harbor Home Goods",
        8,
        "retail",
        warehouses=("WH-SOUTH", "WH-WEST"),
    ),
    ProductSpec(
        "HOME-BOTTLE-SS",
        "Insulated Steel Bottle 750ml",
        "Home & Kitchen",
        "pcs",
        5.10,
        19.99,
        "Harbor Home Goods",
        7,
        "retail",
        trend=1.0,
        scenario="growing",
        warehouses=("WH-SOUTH", "WH-WEST"),
    ),
    ProductSpec(
        "HOME-TOWEL-SET",
        "Cotton Towel Set (4)",
        "Home & Kitchen",
        "set",
        9.80,
        29.99,
        "Harbor Home Goods",
        3,
        "retail",
        warehouses=("WH-SOUTH", "WH-WEST"),
    ),
    ProductSpec(
        "HOME-KNIFE-CH",
        "Chef Knife 8in",
        "Home & Kitchen",
        "pcs",
        14.00,
        49.00,
        "Harbor Home Goods",
        1.8,
        "retail",
        scenario="out_of_stock",
        warehouses=("WH-SOUTH", "WH-WEST"),
    ),
    ProductSpec(
        "TOOL-DRILL-18V",
        "Cordless Drill 18V",
        "Tools & Hardware",
        "pcs",
        48.00,
        129.00,
        "Ironclad Tools",
        1.3,
        "retail",
        warehouses=("WH-NORTH", "WH-WEST"),
    ),
    ProductSpec(
        "TOOL-BITS-SET",
        "Drill Bit Set (29pc)",
        "Tools & Hardware",
        "set",
        7.50,
        24.99,
        "Ironclad Tools",
        3,
        "retail",
        scenario="below_rop",
        warehouses=("WH-NORTH", "WH-WEST"),
    ),
    ProductSpec(
        "TOOL-TAPE-5M",
        "Tape Measure 5m",
        "Tools & Hardware",
        "pcs",
        3.20,
        11.99,
        "Ironclad Tools",
        5,
        "retail",
        warehouses=("WH-NORTH", "WH-WEST"),
    ),
    ProductSpec(
        "TOOL-GLOVES",
        "Work Gloves (pair)",
        "Tools & Hardware",
        "pair",
        1.90,
        7.99,
        "Ironclad Tools",
        12,
        "office",
        scenario="outstanding_po",
        warehouses=("WH-NORTH", "WH-WEST"),
    ),
    ProductSpec(
        "TOOL-SPARE-BELT",
        "Sander Replacement Belt",
        "Tools & Hardware",
        "pcs",
        6.00,
        19.99,
        "Ironclad Tools",
        1.2,
        intermittent=0.18,
        warehouses=("WH-NORTH",),
    ),
    ProductSpec(
        "HLTH-SANIT-500",
        "Hand Sanitizer 500ml",
        "Health & Personal Care",
        "bottle",
        1.60,
        5.49,
        "CareWell Distributors",
        22,
        "flat",
        trend=-0.45,
    ),
    ProductSpec(
        "HLTH-MASK-50",
        "Disposable Face Masks (50)",
        "Health & Personal Care",
        "box",
        3.90,
        12.99,
        "CareWell Distributors",
        6,
        intermittent=0.45,
    ),
    ProductSpec(
        "HLTH-VITC-100",
        "Vitamin C 1000mg (100)",
        "Health & Personal Care",
        "bottle",
        4.40,
        14.99,
        "CareWell Distributors",
        5,
        "retail",
        trend=0.9,
        scenario="shortage",
    ),
    ProductSpec(
        "HLTH-THERM",
        "Digital Thermometer",
        "Health & Personal Care",
        "pcs",
        6.50,
        19.99,
        "CareWell Distributors",
        1.2,
        "flat",
    ),
    ProductSpec(
        "PKG-BOX-M",
        "Shipping Box Medium",
        "Packaging",
        "pcs",
        0.45,
        1.99,
        "PackRight Packaging",
        60,
        "office",
        warehouses=("WH-NORTH", "WH-SOUTH"),
    ),
    ProductSpec(
        "PKG-TAPE-48",
        "Packing Tape 48mm",
        "Packaging",
        "roll",
        0.90,
        3.49,
        "PackRight Packaging",
        30,
        "office",
        warehouses=("WH-NORTH", "WH-SOUTH"),
    ),
    ProductSpec(
        "PKG-BUBBLE-50",
        "Bubble Wrap Roll 50m",
        "Packaging",
        "roll",
        6.20,
        18.99,
        "PackRight Packaging",
        4,
        "office",
        scenario="overstock",
        warehouses=("WH-NORTH", "WH-SOUTH"),
    ),
    ProductSpec(
        "PKG-LABEL-4X6",
        "Thermal Labels 4x6 (500)",
        "Packaging",
        "roll",
        8.10,
        22.99,
        "PackRight Packaging",
        5,
        "office",
        trend=0.7,
        scenario="shortage",
        warehouses=("WH-NORTH", "WH-SOUTH"),
    ),
]


@dataclass
class Series:
    spec: ProductSpec
    product_id: int
    warehouse_id: int
    warehouse_code: str
    supplier_id: int
    lead: int
    delay_sd: float
    scale: float
    stock: int = 0
    reserved: int = 0
    on_order: int = 0
    demand_log: list[int] = field(default_factory=list)
    reorder_enabled: bool = True


class Writer:
    """Accumulates rows for COPY."""

    def __init__(self) -> None:
        self.sales: list[tuple[Any, ...]] = []
        self.tx: list[tuple[Any, ...]] = []
        self.pos: list[dict[str, Any]] = []
        self._ref = 100000

    def next_ref(self, prefix: str = "SO") -> str:
        self._ref += 1
        return f"{prefix}-{self._ref}"

    def ledger(
        self,
        s: Series,
        kind: str,
        qty: int,
        on_delta: int,
        res_delta: int,
        at: datetime,
        reference: str | None,
        note: str | None,
        actor: int | None,
        group: Any = None,
    ) -> None:
        s.stock += on_delta
        s.reserved += res_delta
        if s.stock < 0 or not 0 <= s.reserved <= s.stock:
            raise RuntimeError(f"simulation produced invalid stock for {s.spec.sku} ({kind})")
        self.tx.append(
            (
                s.product_id,
                s.warehouse_id,
                kind,
                qty,
                on_delta,
                res_delta,
                s.stock,
                s.reserved,
                reference,
                note,
                group,
                actor,
                at,
            )
        )


def demand_rate(spec: ProductSpec, scale: float, day_index: int, d: date) -> float:
    progress = day_index / HISTORY_DAYS
    trend = max(0.05, 1 + spec.trend * progress)
    weekly = WEEKDAY[spec.weekly][d.weekday()]
    yearly = 1 + (
        0.15 * math.sin(2 * math.pi * (d.timetuple().tm_yday - 100) / 365)
        if spec.category == "Home & Kitchen"
        else 0
    )
    return spec.base * scale * trend * weekly * yearly


async def _reset(session: Any) -> None:
    tables = [
        "forecast_points",
        "forecast_runs",
        "jobs",
        "idempotency_records",
        "purchase_order_receipt_lines",
        "purchase_order_receipts",
        "purchase_order_lines",
        "purchase_orders",
        "inventory_transactions",
        "inventory_items",
        "sales",
        "products",
        "suppliers",
        "warehouses",
    ]
    await session.execute(text(f"TRUNCATE {', '.join(tables)} RESTART IDENTITY CASCADE"))
    await session.execute(text("DELETE FROM users WHERE email LIKE '%@demo.example'"))
    await session.commit()


async def seed(*, reset: bool = False, run_forecasts: bool = True, rng_seed: int = 42) -> dict[str, Any]:
    started = _time.perf_counter()
    rnd = random.Random(rng_seed)
    nprng = np.random.default_rng(rng_seed)
    sm = get_sessionmaker()
    today = datetime.now(UTC).date()
    start_day = today - timedelta(days=HISTORY_DAYS)

    async with sm() as session:
        if reset:
            await _reset(session)
        elif await session.scalar(select(func.count()).select_from(Product)):
            raise SystemExit("Products already exist; use --reset to wipe business data first.")

        # ---------------------------------------------------------------- users
        demo_users = [
            ("admin@demo.example", "Avery Admin (demo)", Role.ADMIN),
            ("warehouse@demo.example", "Wendy Warehouse", Role.WAREHOUSE_MANAGER),
            ("inventory@demo.example", "Ivan Inventory", Role.INVENTORY_MANAGER),
            ("purchasing@demo.example", "Paula Purchasing", Role.PURCHASING_MANAGER),
            ("analyst@demo.example", "Andy Analyst", Role.ANALYST),
        ]
        pw = hash_password(DEMO_PASSWORD)
        for email, name, role in demo_users:
            if not await session.scalar(select(User.id).where(User.email == email)):
                session.add(User(email=email, full_name=name, role=role, password_hash=pw, is_active=True))
        await session.flush()
        actor_ids = list((await session.scalars(select(User.id).order_by(User.id))).all())
        wh_actor = await session.scalar(select(User.id).where(User.email == "warehouse@demo.example"))
        po_actor = await session.scalar(select(User.id).where(User.email == "purchasing@demo.example"))

        # ---------------------------------------------------------------- master data
        wh_ids: dict[str, int] = {}
        wh_scale: dict[str, float] = {}
        for code, name, loc, scale in WAREHOUSES:
            wh_ids[code] = await session.scalar(
                text(
                    "INSERT INTO warehouses (code, name, location, status) VALUES (:c, :n, :l, 'ACTIVE') RETURNING id"
                ),
                {"c": code, "n": name, "l": loc},
            )
            wh_scale[code] = scale
        sup_ids: dict[str, int] = {}
        sup_meta: dict[str, tuple[int, float]] = {}
        for name, contact, email, phone, terms, lead, sd, status in SUPPLIERS:
            sup_ids[name] = await session.scalar(
                text(
                    "INSERT INTO suppliers (name, contact_name, email, phone, address, payment_terms, lead_time_days, status) "
                    "VALUES (:n, :c, :e, :p, :a, :t, :l, :s) RETURNING id"
                ),
                {
                    "n": name,
                    "c": contact,
                    "e": email,
                    "p": phone,
                    "a": f"{rnd.randint(10, 999)} Commerce Way",
                    "t": terms,
                    "l": lead,
                    "s": status,
                },
            )
            sup_meta[name] = (lead, sd)

        series: list[Series] = []
        prod_ids: dict[str, int] = {}
        for spec in PRODUCTS:
            lead = sup_meta[spec.supplier][0]
            daily = spec.base * (1 + max(spec.trend, 0) * 0.5)
            ss = math.ceil(1.65 * math.sqrt(max(daily, 0.1) * lead)) if daily else 0
            rop = math.ceil(daily * lead) + ss
            prod_ids[spec.sku] = await session.scalar(
                text(
                    "INSERT INTO products (sku, name, description, category, unit, cost, price, min_stock, reorder_point, "
                    "safety_stock, lead_time_days, is_active, supplier_id) VALUES (:sku, :name, :d, :cat, :unit, :cost, "
                    ":price, :min, :rop, :ss, :lead, :active, :sup) RETURNING id"
                ),
                {
                    "sku": spec.sku,
                    "name": spec.name,
                    "d": spec.description or f"{spec.name} – {spec.category}",
                    "cat": spec.category,
                    "unit": spec.unit,
                    "cost": Decimal(str(spec.cost)),
                    "price": Decimal(str(spec.price)),
                    "min": ss,
                    "rop": rop,
                    "ss": ss,
                    "lead": lead,
                    "active": spec.active,
                    "sup": sup_ids[spec.supplier],
                },
            )
            for code in spec.warehouses:
                series.append(
                    Series(
                        spec,
                        prod_ids[spec.sku],
                        wh_ids[code],
                        code,
                        sup_ids[spec.supplier],
                        lead,
                        sup_meta[spec.supplier][1],
                        wh_scale[code],
                    )
                )
        await session.commit()

    # -------------------------------------------------------------------- simulation
    w = Writer()
    arrivals: dict[date, list[tuple[Series, int, int, int]]] = defaultdict(
        list
    )  # day -> (series, qty, po, line)
    po_lines: dict[int, list[dict[str, Any]]] = defaultdict(list)
    po_id = 0
    line_id = 0
    for s in series:
        s.reorder_enabled = s.spec.active
        hold_days = {"shortage": 40, "below_rop": 30, "out_of_stock": 45, "outstanding_po": 30}.get(
            s.spec.scenario, 0
        )
        s.__dict__["hold_from"] = HISTORY_DAYS - hold_days if hold_days else HISTORY_DAYS + 1

    def opening(s: Series, day_i: int, d: date) -> None:
        rate = demand_rate(s.spec, s.scale, day_i, d) or 1
        # Random initial cover staggers reorder cycles so items don't all reorder in lockstep.
        qty = max(10, math.ceil(rate * (s.lead + rnd.randint(8, 50))))
        w.ledger(
            s,
            "ADJUSTMENT",
            qty,
            qty,
            0,
            datetime.combine(d, time(7, 0), tzinfo=UTC),
            "OPENING-BALANCE",
            "Opening balance",
            actor_ids[0],
        )

    for day_i in range(HISTORY_DAYS):
        d = start_day + timedelta(days=day_i)
        # 1. deliveries
        for s, qty, pid, lid in arrivals.pop(d, []):
            s.on_order -= qty
            w.ledger(
                s,
                "PURCHASE_RECEIPT",
                qty,
                qty,
                0,
                datetime.combine(d, time(8, rnd.randint(0, 59)), tzinfo=UTC),
                f"PO#{pid}",
                "Receipt",
                wh_actor,
            )
            for ln in po_lines[pid]:
                if ln["id"] == lid:
                    ln["received"] += qty
                    ln["received_on"] = d
        # 2. demand
        reorders: dict[tuple[int, int], list[tuple[Series, int]]] = defaultdict(list)
        for s in series:
            first_day = HISTORY_DAYS - s.spec.history_days
            if day_i < first_day or not s.spec.active:
                if day_i == first_day and s.spec.active:
                    opening(s, day_i, d)
                continue
            if day_i == first_day:
                opening(s, day_i, d)
            rate = demand_rate(s.spec, s.scale, day_i, d)
            if s.spec.intermittent:
                qty_demand = (
                    int(nprng.geometric(1 / max(rate / s.spec.intermittent, 1.01)))
                    if rnd.random() < s.spec.intermittent
                    else 0
                )
            else:
                qty_demand = int(nprng.poisson(rate))
            s.demand_log.append(qty_demand)
            sold = min(qty_demand, s.stock - s.reserved)
            if sold > 0:
                n_orders = max(1, min(sold, int(nprng.poisson(max(1.0, sold / 4)))))
                cuts = sorted(rnd.sample(range(1, sold), n_orders - 1)) if n_orders > 1 else []
                parts = [b - a for a, b in zip([0, *cuts], [*cuts, sold], strict=True)]
                times = sorted(rnd.randint(9 * 60, 20 * 60) for _ in parts)
                for q, minute in zip(parts, times, strict=True):
                    at = datetime.combine(d, time(minute // 60, minute % 60, rnd.randint(0, 59)), tzinfo=UTC)
                    ref = w.next_ref()
                    price = round(s.spec.price * (0.9 if rnd.random() < 0.08 else 1.0), 2)
                    w.sales.append((s.product_id, s.warehouse_id, at, q, Decimal(str(price)), ref, at))
                    w.ledger(s, "SALE", q, -q, 0, at, ref, None, None)
            # 3. replenishment policy (trailing-average reorder point, ~30-day order cycle)
            recent = s.demand_log[-28:]
            est = (sum(recent) / len(recent)) if recent else rate
            ss_est = 1.65 * math.sqrt(max(est, 0.1) * s.lead)
            position = s.stock - s.reserved + s.on_order
            if s.reorder_enabled and day_i == s.__dict__["hold_from"]:
                # Scenario items stop reordering for the final weeks. One last order sized to
                # cover the hold keeps demand history uncensored (no artificial stock-outs).
                cover = est * (HISTORY_DAYS - day_i + s.lead + 5) + ss_est
                if cover > position:
                    reorders[(s.supplier_id, s.warehouse_id)].append(
                        (s, max(5, int(math.ceil((cover - position) / 5) * 5)))
                    )
            elif s.reorder_enabled and day_i < s.__dict__["hold_from"]:
                rop_est = est * s.lead + ss_est
                if position <= rop_est:
                    order_to = rop_est + est * 45
                    qty = max(5, int(math.ceil((order_to - position) / 5) * 5))
                    reorders[(s.supplier_id, s.warehouse_id)].append((s, qty))
        for (sup_id, wid), items in reorders.items():
            po_id += 1
            lead = items[0][0].lead
            delay = round(abs(nprng.normal(0, items[0][0].delay_sd))) if items[0][0].delay_sd else 0
            if rnd.random() < 0.3:
                delay = -min(delay, 1)
            arrive = d + timedelta(days=max(1, lead + delay))
            w.pos.append(
                {
                    "id": po_id,
                    "supplier_id": sup_id,
                    "warehouse_id": wid,
                    "order_date": d,
                    "expected": d + timedelta(days=lead),
                    "arrive": arrive,
                }
            )
            for s, qty in items:
                line_id += 1
                po_lines[po_id].append(
                    {
                        "id": line_id,
                        "product_id": s.product_id,
                        "qty": qty,
                        "received": 0,
                        "cost": Decimal(str(s.spec.cost)),
                        "received_on": None,
                    }
                )
                s.on_order += qty
                arrivals[arrive].append((s, qty, po_id, line_id))

    # -------------------------------------------------------------------- end-of-history scenario shaping
    end_at = datetime.combine(today - timedelta(days=1), time(18, 30), tzinfo=UTC)
    by_key = {(s.spec.sku, s.warehouse_code): s for s in series}
    for s in series:
        recent = s.demand_log[-28:] or [0]
        rate = sum(recent) / len(recent)
        final: int | None = None
        if s.spec.scenario == "shortage":
            final = int(rate * s.lead * 0.55)
        elif s.spec.scenario == "below_rop":
            final = int(rate * s.lead + 0.5 * math.sqrt(max(rate, 0.1) * s.lead))
        elif s.spec.scenario == "out_of_stock":
            final = 0
        elif s.spec.scenario == "outstanding_po":
            final = int(rate * s.lead * 0.6)
        elif s.spec.scenario == "overstock":
            final = int(rate * 120)
        if final is not None and final != s.stock - s.reserved:
            delta = final - s.stock
            w.ledger(
                s,
                "ADJUSTMENT",
                abs(delta),
                delta,
                0,
                end_at,
                "CC-" + s.warehouse_code,
                "Cycle count correction" if delta < 0 else "Found stock in cycle count",
                wh_actor,
            )
    # Customer reservations on a few healthy items
    for sku, code, frac in [
        ("ELEC-USBC-1M", "WH-NORTH", 0.2),
        ("OFF-PAPER-A4", "WH-SOUTH", 0.15),
        ("PKG-BOX-M", "WH-NORTH", 0.1),
        ("TOOL-DRILL-18V", "WH-WEST", 0.3),
    ]:
        s = by_key[(sku, code)]
        q = int(s.stock * frac)
        if q > 0:
            w.ledger(
                s,
                "RESERVATION",
                q,
                0,
                q,
                end_at + timedelta(minutes=10),
                w.next_ref("RSV"),
                "Customer order hold",
                wh_actor,
            )
    # A few historical inter-warehouse transfers
    import uuid as _uuid

    for sku, src, dst, q, days_ago in [
        ("ELEC-MOUSE-WL", "WH-NORTH", "WH-WEST", 20, 40),
        ("HLTH-SANIT-500", "WH-NORTH", "WH-SOUTH", 60, 25),
    ]:
        a, b = by_key[(sku, src)], by_key[(sku, dst)]
        if a.stock - a.reserved >= q:
            g = _uuid.uuid4()
            at = end_at - timedelta(hours=1)
            w.ledger(a, "TRANSFER_OUT", q, -q, 0, at, f"TRF-{days_ago}", "Rebalance stock", wh_actor, g)
            w.ledger(b, "TRANSFER_IN", q, q, 0, at, f"TRF-{days_ago}", "Rebalance stock", wh_actor, g)
    # Outstanding-PO scenario: an open CONFIRMED order covering the gap (suppresses duplicate recs)
    for s in series:
        if s.spec.scenario == "outstanding_po":
            recent = s.demand_log[-28:]
            rate = sum(recent) / len(recent)
            po_id += 1
            line_id += 1
            qty = int(math.ceil(rate * (s.lead + 21) / 10) * 10)
            w.pos.append(
                {
                    "id": po_id,
                    "supplier_id": s.supplier_id,
                    "warehouse_id": s.warehouse_id,
                    "order_date": today - timedelta(days=2),
                    "expected": today - timedelta(days=2) + timedelta(days=s.lead),
                    "arrive": None,
                }
            )
            po_lines[po_id].append(
                {
                    "id": line_id,
                    "product_id": s.product_id,
                    "qty": qty,
                    "received": 0,
                    "cost": Decimal(str(s.spec.cost)),
                    "received_on": None,
                }
            )

    # -------------------------------------------------------------------- persist
    async with sm() as session:
        conn = await session.connection()
        raw = (await conn.get_raw_connection()).driver_connection
        assert raw is not None  # asyncpg connection (COPY support)
        await raw.copy_records_to_table(
            "sales",
            records=w.sales,
            columns=[
                "product_id",
                "warehouse_id",
                "sold_at",
                "quantity",
                "unit_price",
                "order_reference",
                "created_at",
            ],
        )
        # PO numbers follow order date; status derived from receipts.
        number_of = {}
        po_rows, line_rows, receipt_rows, rline_rows = [], [], [], []
        receipt_id = 0
        for po in sorted(w.pos, key=lambda p: (p["order_date"], p["id"])):
            lines = po_lines[po["id"]]
            seq = await session.scalar(text("SELECT nextval('purchase_order_number_seq')"))
            number = f"PO-{po['order_date']:%Y}-{seq:06d}"
            number_of[po["id"]] = number
            ordered = sum(ln["qty"] for ln in lines)
            received = sum(ln["received"] for ln in lines)
            status = (
                "RECEIVED" if received == ordered else ("PARTIALLY_RECEIVED" if received else "CONFIRMED")
            )
            received_date = (
                max((ln["received_on"] for ln in lines if ln["received_on"]), default=None)
                if status == "RECEIVED"
                else None
            )
            created = datetime.combine(po["order_date"], time(10, 0), tzinfo=UTC)
            po_rows.append(
                (
                    po["id"],
                    number,
                    po["supplier_id"],
                    po["warehouse_id"],
                    status,
                    po["order_date"],
                    po["expected"],
                    created + timedelta(hours=1),
                    received_date,
                    None,
                    po_actor,
                    created,
                    created,
                )
            )
            for ln in lines:
                line_rows.append(
                    (ln["id"], po["id"], ln["product_id"], ln["qty"], ln["received"], ln["cost"])
                )
            if received:
                receipt_id += 1
                at = datetime.combine(received_date or po["arrive"], time(8, 30), tzinfo=UTC)
                receipt_rows.append((receipt_id, po["id"], f"GRN-{po['id']:06d}", at, wh_actor, None))
                for ln in lines:
                    if ln["received"]:
                        rline_rows.append((receipt_id, ln["id"], ln["product_id"], ln["received"]))
        await raw.copy_records_to_table(
            "purchase_orders",
            records=po_rows,
            columns=[
                "id",
                "po_number",
                "supplier_id",
                "warehouse_id",
                "status",
                "order_date",
                "expected_delivery_date",
                "submitted_at",
                "received_date",
                "notes",
                "created_by_id",
                "created_at",
                "updated_at",
            ],
        )
        await raw.copy_records_to_table(
            "purchase_order_lines",
            records=line_rows,
            columns=[
                "id",
                "purchase_order_id",
                "product_id",
                "quantity_ordered",
                "quantity_received",
                "unit_cost",
            ],
        )
        await raw.copy_records_to_table(
            "purchase_order_receipts",
            records=receipt_rows,
            columns=["id", "purchase_order_id", "receipt_key", "received_at", "received_by_id", "notes"],
        )
        await raw.copy_records_to_table(
            "purchase_order_receipt_lines",
            records=rline_rows,
            columns=["receipt_id", "purchase_order_line_id", "product_id", "quantity"],
        )
        tx_rows = [
            (*t[:8], number_of.get(int(t[8][3:]), t[8]) if t[8] and t[8].startswith("PO#") else t[8], *t[9:])
            for t in w.tx
        ]
        await raw.copy_records_to_table(
            "inventory_transactions",
            records=tx_rows,
            columns=[
                "product_id",
                "warehouse_id",
                "type",
                "quantity",
                "on_hand_delta",
                "reserved_delta",
                "on_hand_after",
                "reserved_after",
                "reference",
                "note",
                "transfer_group",
                "actor_id",
                "created_at",
            ],
        )
        # Per-warehouse planning parameters (warehouses have different demand levels).
        inv_rows = []
        for s in series:
            if not (s.spec.active or s.stock):
                continue
            recent = s.demand_log[-56:]
            daily = sum(recent) / len(recent) if recent else 0.0
            ss = math.ceil(1.65 * math.sqrt(max(daily, 0.1) * s.lead)) if daily else 0
            rop = math.ceil(daily * s.lead) + ss
            inv_rows.append((s.product_id, s.warehouse_id, s.stock, s.reserved, ss, rop, end_at))
        await raw.copy_records_to_table(
            "inventory_items",
            records=inv_rows,
            columns=[
                "product_id",
                "warehouse_id",
                "quantity_on_hand",
                "reserved_quantity",
                "safety_stock",
                "reorder_point",
                "updated_at",
            ],
        )
        for table in ("purchase_orders", "purchase_order_lines", "purchase_order_receipts"):
            await session.execute(
                text(
                    f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM {table}))"  # noqa: S608 - fixed table names
                )
            )
        await session.commit()

        # A few hand-crafted open POs to show every workflow state
        extra = await _workflow_examples(session, prod_ids, sup_ids, wh_ids, po_actor, today)
        await session.commit()

    await get_cache().invalidate(*CacheDomain)
    summary: dict[str, Any] = {
        "warehouses": len(WAREHOUSES),
        "suppliers": len(SUPPLIERS),
        "products": len(PRODUCTS),
        "inventory_items": len(series),
        "sales": len(w.sales),
        "transactions": len(w.tx),
        "purchase_orders": len(w.pos) + extra,
    }
    logger.info("seed data written", extra={**summary, "seconds": round(_time.perf_counter() - started, 1)})
    if run_forecasts:
        t0 = _time.perf_counter()
        result = await ForecastService.forecast_all(
            sm, get_cache(), get_settings().forecast_default_horizon_days
        )
        summary["forecasts"] = result["succeeded"]
        logger.info(
            "seed forecasts generated", extra={**result, "seconds": round(_time.perf_counter() - t0, 1)}
        )
    return summary


async def _workflow_examples(
    session: Any,
    prod: dict[str, int],
    sup: dict[str, int],
    wh: dict[str, int],
    actor: int | None,
    today: date,
) -> int:
    """DRAFT, SUBMITTED, overdue CONFIRMED, PARTIALLY_RECEIVED and CANCELLED examples."""
    examples = [
        (
            "DRAFT",
            "PackRight Packaging",
            "WH-SOUTH",
            [("PKG-TAPE-48", 400), ("PKG-BOX-M", 600)],
            0,
            3,
            "Quarterly top-up (awaiting approval)",
        ),
        (
            "SUBMITTED",
            "Summit Office Supply",
            "WH-NORTH",
            [("OFF-STAPLER", 40), ("OFF-TONER-HP", 30)],
            1,
            5,
            "Sent to supplier",
        ),
        (
            "CONFIRMED",
            "Harbor Home Goods",
            "WH-WEST",
            [("HOME-TOWEL-SET", 80)],
            20,
            14,
            "Supplier confirmed – delivery overdue",
        ),
        (
            "PARTIALLY_RECEIVED",
            "CareWell Distributors",
            "WH-WEST",
            [("HLTH-THERM", 30), ("HLTH-MASK-50", 60)],
            9,
            7,
            "Backorder on masks",
        ),
        (
            "CANCELLED",
            "Northwind Electronics",
            "WH-NORTH",
            [("ELEC-KB-MECH", 25)],
            30,
            10,
            "Cancelled – price dispute",
        ),
    ]
    for status, supplier, code, lines, age, lead, notes in examples:
        order_date = today - timedelta(days=age)
        seq = await session.scalar(text("SELECT nextval('purchase_order_number_seq')"))
        po_id = await session.scalar(
            text(
                "INSERT INTO purchase_orders (po_number, supplier_id, warehouse_id, status, order_date, expected_delivery_date, "
                "submitted_at, notes, created_by_id) VALUES (:n, :s, :w, :st, :od, :ed, :sub, :notes, :a) RETURNING id"
            ),
            {
                "n": f"PO-{order_date:%Y}-{seq:06d}",
                "s": sup[supplier],
                "w": wh[code],
                "st": status,
                "od": order_date,
                "ed": order_date + timedelta(days=lead),
                "sub": None if status == "DRAFT" else datetime.combine(order_date, time(11), tzinfo=UTC),
                "notes": notes,
                "a": actor,
            },
        )
        for i, (sku, qty) in enumerate(lines):
            received = qty if (status == "PARTIALLY_RECEIVED" and i == 0) else 0
            cost = await session.scalar(text("SELECT cost FROM products WHERE id = :p"), {"p": prod[sku]})
            line_id = await session.scalar(
                text(
                    "INSERT INTO purchase_order_lines (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost) "
                    "VALUES (:po, :p, :q, :r, :c) RETURNING id"
                ),
                {"po": po_id, "p": prod[sku], "q": qty, "r": received, "c": cost},
            )
            if received:
                rid = await session.scalar(
                    text(
                        "INSERT INTO purchase_order_receipts (purchase_order_id, receipt_key, received_by_id, notes) "
                        "VALUES (:po, :k, :a, 'Partial delivery') RETURNING id"
                    ),
                    {"po": po_id, "k": f"GRN-P{po_id}", "a": actor},
                )
                await session.execute(
                    text(
                        "INSERT INTO purchase_order_receipt_lines (receipt_id, purchase_order_line_id, product_id, quantity) "
                        "VALUES (:r, :l, :p, :q)"
                    ),
                    {"r": rid, "l": line_id, "p": prod[sku], "q": received},
                )
                row = (
                    await session.execute(
                        text(
                            "UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + :q WHERE product_id = :p AND warehouse_id = :w "
                            "RETURNING quantity_on_hand, reserved_quantity"
                        ),
                        {"q": received, "p": prod[sku], "w": wh[code]},
                    )
                ).one()
                await session.execute(
                    text(
                        "INSERT INTO inventory_transactions (product_id, warehouse_id, type, quantity, on_hand_delta, reserved_delta, "
                        "on_hand_after, reserved_after, reference, note, actor_id) VALUES (:p, :w, 'PURCHASE_RECEIPT', :q, :q, 0, :oh, :rs, "
                        ":ref, 'Partial delivery', :a)"
                    ),
                    {
                        "p": prod[sku],
                        "w": wh[code],
                        "q": received,
                        "oh": row[0],
                        "rs": row[1],
                        "ref": f"PO-{order_date:%Y}-{seq:06d}",
                        "a": actor,
                    },
                )
    return len(examples)


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed demo data")
    parser.add_argument("--reset", action="store_true", help="truncate business tables first")
    parser.add_argument("--skip-forecasts", action="store_true")
    args = parser.parse_args()
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)

    async def run() -> None:
        try:
            summary = await seed(reset=args.reset, run_forecasts=not args.skip_forecasts)
            print("Seed complete:", summary)
        finally:
            await dispose_engine()

    asyncio.run(run())


if __name__ == "__main__":
    main()
