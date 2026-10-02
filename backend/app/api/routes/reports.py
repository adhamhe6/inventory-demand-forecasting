from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query

from app.api.dependencies import CacheDep, CurrentUser, PageDep, SessionDep, SortQuery
from app.api.export import maybe_csv
from app.cache.redis_cache import CacheDomain
from app.core.errors import AppError
from app.schemas.common import ERROR_RESPONSES, Page
from app.schemas.inventory import InventoryItemRead, StockStatus
from app.services.common import PageParams
from app.services.inventory import InventoryService
from app.services.reports import ReportService

router = APIRouter(prefix="/reports", tags=["Reports & Dashboard"])
Fmt = Annotated[str, Query(pattern="^(json|csv)$")]


def _range(date_from: date | None, date_to: date | None, default_days: int = 90) -> tuple[date, date]:
    end = date_to or datetime.now(UTC).date()
    start = date_from or end - timedelta(days=default_days - 1)
    if start > end:
        raise AppError("date_from must be on or before date_to", code="INVALID_DATE_RANGE")
    if (end - start).days > 3 * 366:
        raise AppError("Date range may not exceed 3 years", code="INVALID_DATE_RANGE")
    return start, end


@router.get("/dashboard", summary="Executive dashboard (KPIs + chart series)", responses=ERROR_RESPONSES)
async def dashboard(_: CurrentUser, session: SessionDep, cache: CacheDep) -> dict[str, Any]:
    """All numbers are computed from live data; the payload is cached in Redis and
    invalidated by any write to inventory, sales, purchasing, forecasts or catalog."""
    return await ReportService(session, cache).dashboard()


@router.get(
    "/low-stock",
    response_model=Page[InventoryItemRead],
    summary="Low / critical / out-of-stock items",
    responses=ERROR_RESPONSES,
)
async def low_stock(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    page: PageDep,
    warehouse_id: Annotated[int | None, Query(gt=0)] = None,
    sort: SortQuery = None,
    format: Fmt = "json",
) -> Any:
    """Items at or below their reorder point, most severe first (OUT_OF_STOCK, CRITICAL, LOW_STOCK)."""
    statuses = [StockStatus.OUT_OF_STOCK, StockStatus.CRITICAL, StockStatus.LOW_STOCK]
    svc = InventoryService(session, cache)
    sort = sort or "status,available_quantity"
    if format == "csv":
        items, _t = await svc.list_items(
            PageParams(1, 10_000), warehouse_id=warehouse_id, statuses=statuses, sort=sort
        )
        return maybe_csv(
            items,
            "low-stock",
            [
                "sku",
                "product_name",
                "warehouse_code",
                "quantity_on_hand",
                "reserved_quantity",
                "available_quantity",
                "safety_stock",
                "reorder_point",
                "status",
            ],
        )
    items, total = await svc.list_items(page, warehouse_id=warehouse_id, statuses=statuses, sort=sort)
    return Page.build([InventoryItemRead.model_validate(i) for i in items], total, page.page, page.page_size)


@router.get(
    "/inventory-value", summary="Inventory valuation by warehouse or category", responses=ERROR_RESPONSES
)
async def inventory_value(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    group_by: Literal["warehouse", "category"] = "warehouse",
    format: Fmt = "json",
) -> Any:
    svc = ReportService(session, cache)
    rows = await cache.get_or_set(
        "reports:inventory_value",
        [CacheDomain.INVENTORY, CacheDomain.CATALOG],
        lambda: svc.inventory_value(group_by),
        params={"g": group_by},
    )
    if format == "csv":
        return maybe_csv(
            rows, "inventory-value", ["group", "products", "units", "cost_value", "retail_value"]
        )
    return {
        "group_by": group_by,
        "rows": rows,
        "total_cost_value": round(sum(r["cost_value"] for r in rows), 2),
        "total_retail_value": round(sum(r["retail_value"] for r in rows), 2),
    }


@router.get(
    "/inventory-trend",
    summary="Daily on-hand units/value reconstructed from the ledger",
    responses=ERROR_RESPONSES,
)
async def inventory_trend(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    days: Annotated[int, Query(ge=7, le=365)] = 90,
    warehouse_id: Annotated[int | None, Query(gt=0)] = None,
) -> list[dict[str, Any]]:
    svc = ReportService(session, cache)
    return await cache.get_or_set(
        "reports:inventory_trend",
        [CacheDomain.INVENTORY, CacheDomain.CATALOG],
        lambda: svc.inventory_trend(days, warehouse_id),
        params={"d": days, "w": warehouse_id},
    )


@router.get("/sales-summary", summary="Sales totals, time series and top products", responses=ERROR_RESPONSES)
async def sales_summary(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    date_from: date | None = None,
    date_to: date | None = None,
    granularity: Literal["day", "week", "month"] = "day",
    warehouse_id: Annotated[int | None, Query(gt=0)] = None,
    category: Annotated[str | None, Query(max_length=100)] = None,
    top: Annotated[int, Query(ge=1, le=100)] = 10,
    format: Fmt = "json",
) -> Any:
    start, end = _range(date_from, date_to)
    data = await ReportService(session, cache).sales_summary(
        start, end, granularity, warehouse_id=warehouse_id, category=category, top=top
    )
    if format == "csv":
        return maybe_csv(data["series"], "sales-summary", ["period", "units", "revenue", "orders"])
    return data


@router.get(
    "/supplier-performance",
    summary="Spend, on-time rate, lead time and fill rate per supplier",
    responses=ERROR_RESPONSES,
)
async def supplier_performance(
    _: CurrentUser, session: SessionDep, cache: CacheDep, format: Fmt = "json"
) -> Any:
    svc = ReportService(session, cache)
    rows = await cache.get_or_set(
        "reports:supplier_performance",
        [CacheDomain.PURCHASING, CacheDomain.CATALOG],
        svc.supplier_performance,
    )
    if format == "csv":
        return maybe_csv(
            rows,
            "supplier-performance",
            [
                "supplier_name",
                "total_purchase_orders",
                "open_purchase_orders",
                "total_spend",
                "on_time_rate",
                "promised_lead_time_days",
                "avg_actual_lead_time_days",
                "fill_rate",
                "overdue_purchase_orders",
            ],
        )
    return rows


@router.get(
    "/purchase-orders", summary="Purchase orders by status + overdue orders", responses=ERROR_RESPONSES
)
async def purchase_order_summary(_: CurrentUser, session: SessionDep, cache: CacheDep) -> dict[str, Any]:
    svc = ReportService(session, cache)
    return await cache.get_or_set(
        "reports:po_summary",
        [CacheDomain.PURCHASING],
        svc.purchase_order_summary,
        params={"d": datetime.now(UTC).date()},
    )


@router.get(
    "/forecast-accuracy", summary="Forecast accuracy by model (latest runs)", responses=ERROR_RESPONSES
)
async def forecast_accuracy(_: CurrentUser, session: SessionDep, cache: CacheDep) -> dict[str, Any]:
    svc = ReportService(session, cache)
    return await cache.get_or_set("reports:forecast_accuracy", [CacheDomain.FORECASTS], svc.forecast_accuracy)


@router.get(
    "/forecast-aggregate", summary="Total predicted demand per day (all items)", responses=ERROR_RESPONSES
)
async def forecast_aggregate(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    days: Annotated[int, Query(ge=1, le=180)] = 30,
    warehouse_id: Annotated[int | None, Query(gt=0)] = None,
) -> list[dict[str, Any]]:
    svc = ReportService(session, cache)
    return await cache.get_or_set(
        "reports:forecast_aggregate",
        [CacheDomain.FORECASTS],
        lambda: svc.forecast_aggregate(days, warehouse_id),
        params={"d": days, "w": warehouse_id, "t": datetime.now(UTC).date()},
    )
