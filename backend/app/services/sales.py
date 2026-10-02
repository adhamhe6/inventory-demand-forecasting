"""Sales recording, listing and streaming CSV import."""

from __future__ import annotations

import csv
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.redis_cache import Cache, CacheDomain
from app.core.errors import AppError, ConflictError
from app.db.models import Product, Sale, TransactionType, Warehouse
from app.schemas.sales import SaleCreate
from app.services.catalog import CatalogService, _ilike_any
from app.services.common import PageParams, apply_sort, paginate
from app.services.inventory import InventoryService

logger = logging.getLogger(__name__)

REQUIRED_COLUMNS = {"sku", "warehouse_code", "sold_at", "quantity", "order_reference"}
OPTIONAL_COLUMNS = {"unit_price"}
BATCH_SIZE = 1000
MAX_REPORTED_ERRORS = 100


class CsvFormatError(AppError):
    code = "INVALID_CSV"


def parse_sold_at(raw: str) -> datetime:
    raw = raw.strip()
    try:
        if len(raw) == 10:
            return datetime.combine(date.fromisoformat(raw), time(12, 0), tzinfo=UTC)
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"invalid sold_at '{raw}' (expected ISO date/datetime)") from exc
    return value if value.tzinfo else value.replace(tzinfo=UTC)


class _CountingLines:
    """Iterates text lines while tracking approximate bytes consumed (for progress).

    ``TextIOWrapper.tell()`` is unusable while the csv module iterates the file.
    """

    def __init__(self, handle: Any) -> None:
        self._handle = handle
        self.consumed = 0

    def __iter__(self) -> _CountingLines:
        return self

    def __next__(self) -> str:
        line: str = next(self._handle)
        self.consumed += len(line.encode("utf-8", "replace"))
        return line


class SalesService:
    def __init__(self, session: AsyncSession, cache: Cache) -> None:
        self.session = session
        self.cache = cache

    @staticmethod
    def _to_dict(sale: Sale, sku: str, product_name: str, warehouse_code: str) -> dict[str, Any]:
        return {
            "id": sale.id,
            "product_id": sale.product_id,
            "sku": sku,
            "product_name": product_name,
            "warehouse_id": sale.warehouse_id,
            "warehouse_code": warehouse_code,
            "sold_at": sale.sold_at,
            "quantity": sale.quantity,
            "unit_price": sale.unit_price,
            "revenue": (sale.unit_price * sale.quantity).quantize(Decimal("0.01")),
            "order_reference": sale.order_reference,
            "created_at": sale.created_at,
        }

    async def list(
        self,
        page: PageParams,
        *,
        product_id: int | None = None,
        warehouse_id: int | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
        search: str | None = None,
        sort: str | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        stmt: Select[Any] = (
            select(
                Sale, Product.sku, Product.name.label("product_name"), Warehouse.code.label("warehouse_code")
            )
            .join(Product, Product.id == Sale.product_id)
            .join(Warehouse, Warehouse.id == Sale.warehouse_id)
        )
        if product_id:
            stmt = stmt.where(Sale.product_id == product_id)
        if warehouse_id:
            stmt = stmt.where(Sale.warehouse_id == warehouse_id)
        if date_from:
            stmt = stmt.where(Sale.sold_at >= datetime.combine(date_from, time.min, tzinfo=UTC))
        if date_to:
            stmt = stmt.where(
                Sale.sold_at < datetime.combine(date_to + timedelta(days=1), time.min, tzinfo=UTC)
            )
        if search:
            stmt = stmt.where(_ilike_any(search, Sale.order_reference, Product.sku, Product.name))
        stmt = apply_sort(
            stmt,
            sort,
            {
                "id": Sale.id,
                "sold_at": Sale.sold_at,
                "quantity": Sale.quantity,
                "revenue": Sale.quantity * Sale.unit_price,
                "sku": Product.sku,
            },
            "-sold_at",
        )
        rows, total = await paginate(self.session, stmt, page)
        return [self._to_dict(r[0], r.sku, r.product_name, r.warehouse_code) for r in rows], total

    async def create(self, data: SaleCreate, actor_id: int | None) -> dict[str, Any]:
        """Record a sale; optionally issue stock in the same DB transaction."""
        product, warehouse = await CatalogService(self.session, self.cache).ensure_active(
            data.product_id, data.warehouse_id
        )
        if data.issue_stock:
            await InventoryService(self.session, self.cache).issue(
                data.product_id,
                data.warehouse_id,
                data.quantity,
                reference=data.order_reference,
                note="Sale",
                actor_id=actor_id,
                type_=TransactionType.SALE,
            )
        sale = Sale(
            product_id=product.id,
            warehouse_id=warehouse.id,
            sold_at=data.sold_at or datetime.now(UTC),
            quantity=data.quantity,
            unit_price=data.unit_price if data.unit_price is not None else product.price,
            order_reference=data.order_reference,
        )
        self.session.add(sale)
        try:
            await self.session.flush()
        except IntegrityError as exc:
            await self.session.rollback()
            raise ConflictError(
                f"Sale {data.order_reference} for this product and warehouse already exists",
                code="DUPLICATE_SALE",
            ) from exc
        await self.session.refresh(sale)
        return self._to_dict(sale, product.sku, product.name, warehouse.code)

    async def after_commit(self, *, stock_changed: bool) -> None:
        domains = [CacheDomain.SALES] + ([CacheDomain.INVENTORY] if stock_changed else [])
        await self.cache.invalidate(*domains)

    # ------------------------------------------------------------------ CSV import
    async def import_csv(
        self,
        path: Path,
        progress: Callable[[int, int], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        """Stream a CSV file into ``sales`` in batches.

        * Rows are read lazily (constant memory regardless of file size).
        * Each batch is validated, then inserted with ``ON CONFLICT DO NOTHING`` on the
          (order_reference, product, warehouse) key – re-importing a file is a no-op.
        * Each batch commits, so a failure late in a huge file keeps earlier progress and a
          re-run resumes safely thanks to the de-duplication key.
        * Invalid rows are skipped and reported (first 100) with their line numbers.
        """
        products = dict((await self.session.execute(select(Product.sku, Product.id))).tuples().all())
        warehouses = dict((await self.session.execute(select(Warehouse.code, Warehouse.id))).tuples().all())
        prices = dict((await self.session.execute(select(Product.id, Product.price))).tuples().all())
        total_bytes = max(path.stat().st_size, 1)
        stats = {"total_rows": 0, "inserted": 0, "duplicates": 0, "invalid": 0}
        errors: list[dict[str, Any]] = []
        now = datetime.now(UTC) + timedelta(minutes=5)

        def record_error(line: int, msg: str, raw: dict[str, Any] | None) -> None:
            stats["invalid"] += 1
            if len(errors) < MAX_REPORTED_ERRORS:
                safe_raw = {str(k)[:50]: str(v)[:100] for k, v in (raw or {}).items() if k is not None}
                errors.append({"line": line, "error": msg, "raw": safe_raw})

        try:
            handle = path.open("r", encoding="utf-8-sig", newline="")
        except OSError as exc:
            raise CsvFormatError(f"Cannot open import file: {exc}") from exc
        with handle:
            source = _CountingLines(handle)
            reader = csv.DictReader(source)
            header = {h.strip().lower() for h in (reader.fieldnames or []) if h}
            missing = REQUIRED_COLUMNS - header
            if missing:
                raise CsvFormatError(
                    f"CSV is missing required column(s): {', '.join(sorted(missing))}",
                    details={"required": sorted(REQUIRED_COLUMNS), "optional": sorted(OPTIONAL_COLUMNS)},
                )
            batch: list[dict[str, Any]] = []
            try:
                for raw in reader:
                    line = reader.line_num
                    stats["total_rows"] += 1
                    row = {
                        (k or "").strip().lower(): (v or "").strip() for k, v in raw.items() if k is not None
                    }
                    if None in raw:
                        record_error(line, "row has more fields than the header", row)
                        continue
                    try:
                        batch.append(self._validate_row(row, products, warehouses, prices, now))
                    except ValueError as exc:
                        record_error(line, str(exc), row)
                        continue
                    if len(batch) >= BATCH_SIZE:
                        await self._insert_batch(batch, stats)
                        batch = []
                        if progress:
                            await progress(
                                min(99, int(source.consumed * 100 / total_bytes)), stats["total_rows"]
                            )
            except (csv.Error, UnicodeDecodeError) as exc:
                raise CsvFormatError(
                    f"Malformed CSV near line {reader.line_num}: {exc}", details={**stats}
                ) from exc
            if batch:
                await self._insert_batch(batch, stats)
        if stats["inserted"]:
            await self.cache.invalidate(CacheDomain.SALES)
        logger.info("sales import finished", extra={**stats})
        return {**stats, "errors": errors, "errors_truncated": stats["invalid"] > len(errors)}

    @staticmethod
    def _validate_row(
        row: dict[str, str],
        products: dict[str, int],
        warehouses: dict[str, int],
        prices: dict[int, Decimal],
        now: datetime,
    ) -> dict[str, Any]:
        sku = row.get("sku", "").upper()
        if not sku:
            raise ValueError("sku is required")
        product_id = products.get(sku)
        if product_id is None:
            raise ValueError(f"unknown sku '{sku}'")
        code = row.get("warehouse_code", "").upper()
        warehouse_id = warehouses.get(code)
        if warehouse_id is None:
            raise ValueError(f"unknown warehouse_code '{code}'")
        try:
            quantity = int(row.get("quantity", ""))
        except ValueError:
            raise ValueError(f"quantity must be an integer, got '{row.get('quantity')}'") from None
        if quantity <= 0 or quantity > 1_000_000:
            raise ValueError("quantity must be between 1 and 1,000,000")
        sold_at = parse_sold_at(row.get("sold_at", ""))
        if sold_at > now:
            raise ValueError("sold_at is in the future")
        ref = row.get("order_reference", "")
        if not ref or len(ref) > 100:
            raise ValueError("order_reference is required (max 100 chars)")
        price_raw = row.get("unit_price", "")
        if price_raw:
            try:
                unit_price = Decimal(price_raw).quantize(Decimal("0.01"))
            except InvalidOperation:
                raise ValueError(f"unit_price must be a number, got '{price_raw}'") from None
            if unit_price < 0 or unit_price >= Decimal("1e10"):
                raise ValueError("unit_price out of range")
        else:
            unit_price = prices[product_id]
        return {
            "product_id": product_id,
            "warehouse_id": warehouse_id,
            "sold_at": sold_at,
            "quantity": quantity,
            "unit_price": unit_price,
            "order_reference": ref,
        }

    async def _insert_batch(self, batch: list[dict[str, Any]], stats: dict[str, int]) -> None:
        result = await self.session.execute(
            pg_insert(Sale)
            .values(batch)
            .on_conflict_do_nothing(constraint="uq_sales_order_product_warehouse")
            .returning(Sale.id)
        )
        inserted = len(result.all())
        await self.session.commit()
        stats["inserted"] += inserted
        stats["duplicates"] += len(batch) - inserted

    async def daily_totals(
        self, product_id: int, warehouse_id: int, start: date, end: date
    ) -> list[tuple[date, float]]:
        """Daily sold quantity for one item in [start, end] (UTC days)."""
        day = func.date(func.timezone("UTC", Sale.sold_at))
        rows = (
            await self.session.execute(
                select(day, func.sum(Sale.quantity))
                .where(
                    Sale.product_id == product_id,
                    Sale.warehouse_id == warehouse_id,
                    Sale.sold_at >= datetime.combine(start, time.min, tzinfo=UTC),
                    Sale.sold_at < datetime.combine(end + timedelta(days=1), time.min, tzinfo=UTC),
                )
                .group_by(day)
                .order_by(day)
            )
        ).all()
        return [(r[0], float(r[1])) for r in rows]
