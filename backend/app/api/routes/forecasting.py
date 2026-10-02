"""Forecasts, stock-risk analysis, restocking recommendations and background jobs."""

from __future__ import annotations

from collections import Counter
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status

from app.api.dependencies import (
    CacheDep,
    CurrentUser,
    DispatcherDep,
    PageDep,
    SearchQuery,
    SessionDep,
    SortQuery,
    require,
)
from app.api.export import maybe_csv
from app.cache.redis_cache import CacheDomain
from app.core.errors import NotFoundError
from app.core.security import Permission
from app.db.models import JobStatus, JobType, User
from app.schemas.common import ERROR_RESPONSES, NOT_FOUND, Page
from app.schemas.forecasting import (
    CreatedPurchaseOrders,
    CreatePOsFromRecommendations,
    ForecastAllRequest,
    ForecastRequest,
    ForecastRunRead,
    ForecastRunSummary,
    ForecastWithHistory,
    JobRead,
    RestockPage,
    RiskLevel,
    StockRiskPage,
)
from app.services.catalog import CatalogService
from app.services.forecasting import ForecastService
from app.services.jobs import JobService, job_to_dict
from app.services.replenishment import RISK_ORDER, ReplenishmentService

forecasts = APIRouter(prefix="/forecasts", tags=["Demand Forecasting"])
shortages = APIRouter(prefix="/shortages", tags=["Stock Risk"])
restocking = APIRouter(prefix="/restocking", tags=["Restocking"])
jobs = APIRouter(prefix="/jobs", tags=["Background Jobs"])

RunForecasts = Annotated[User, Depends(require(Permission.RUN_FORECASTS))]
ManagePO = Annotated[User, Depends(require(Permission.MANAGE_PURCHASE_ORDERS))]


# --------------------------------------------------------------------------- forecasts
@forecasts.post(
    "/run",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Forecast one product in one warehouse (background job)",
    responses={**ERROR_RESPONSES, **NOT_FOUND},
)
async def run_forecast(
    body: ForecastRequest, user: RunForecasts, session: SessionDep, cache: CacheDep, dispatcher: DispatcherDep
) -> JobRead:
    """Queues a FORECAST_ITEM job and returns it immediately (202). Poll
    ``GET /jobs/{id}``; when SUCCEEDED, ``result.forecast_run_id`` points at the stored forecast.
    Identical requests while one is in flight return the existing job."""
    await CatalogService(session, cache).ensure_active(body.product_id, body.warehouse_id)
    job, _ = await JobService(session).submit(
        dispatcher,
        JobType.FORECAST_ITEM,
        body.model_dump(),
        dedupe_key=f"forecast:{body.product_id}:{body.warehouse_id}:{body.horizon_days}:{body.model}",
        user_id=user.id,
    )
    return JobRead.model_validate(job_to_dict(job))


@forecasts.post(
    "/run-all",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Forecast every active item (background job)",
    responses=ERROR_RESPONSES,
)
async def run_all_forecasts(
    body: ForecastAllRequest, user: RunForecasts, session: SessionDep, dispatcher: DispatcherDep
) -> JobRead:
    job, _ = await JobService(session).submit(
        dispatcher,
        JobType.FORECAST_ALL,
        body.model_dump(),
        dedupe_key=f"forecast_all:{body.warehouse_id or 'all'}",
        user_id=user.id,
    )
    return JobRead.model_validate(job_to_dict(job))


@forecasts.get(
    "", response_model=Page[ForecastRunSummary], summary="Latest forecast per item", responses=ERROR_RESPONSES
)
async def list_forecasts(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    page: PageDep,
    warehouse_id: Annotated[int | None, Query(gt=0)] = None,
    product_id: Annotated[int | None, Query(gt=0)] = None,
    model_name: Annotated[str | None, Query(max_length=50)] = None,
    search: SearchQuery = None,
    sort: SortQuery = None,
) -> Page[ForecastRunSummary]:
    """Sortable by generated_at, sku, total_predicted, avg_daily_demand, mae, wape."""
    items, total = await ForecastService(session, cache).list_latest(
        page,
        warehouse_id=warehouse_id,
        product_id=product_id,
        model_name=model_name,
        search=search,
        sort=sort,
    )
    return Page.build([ForecastRunSummary.model_validate(i) for i in items], total, page.page, page.page_size)


@forecasts.get(
    "/item",
    response_model=ForecastWithHistory,
    summary="Latest forecast + sales history for charting",
    responses=ERROR_RESPONSES,
)
async def item_forecast(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    product_id: Annotated[int, Query(gt=0)],
    warehouse_id: Annotated[int, Query(gt=0)],
    history_days: Annotated[int, Query(ge=7, le=730)] = 120,
) -> Any:
    """Cached in Redis; invalidated whenever forecasts or sales change."""
    svc = ForecastService(session, cache)

    async def compute() -> dict[str, Any]:
        return {
            "forecast": await svc.latest_for_item(product_id, warehouse_id),
            "history": await svc.history_points(product_id, warehouse_id, history_days),
        }

    data = await cache.get_or_set(
        "forecasts:item",
        [CacheDomain.FORECASTS, CacheDomain.SALES, CacheDomain.CATALOG],  # CATALOG: embeds product name
        compute,
        params={"p": product_id, "w": warehouse_id, "h": history_days},
        serialize=lambda v: ForecastWithHistory.model_validate(v).model_dump(mode="json"),
    )
    return ForecastWithHistory.model_validate(data)


@forecasts.get("/{run_id}", response_model=ForecastRunRead, responses={**ERROR_RESPONSES, **NOT_FOUND})
async def get_forecast(run_id: int, _: CurrentUser, session: SessionDep, cache: CacheDep) -> ForecastRunRead:
    return ForecastRunRead.model_validate(await ForecastService(session, cache).get_run(run_id))


# --------------------------------------------------------------------------- shortages
RISK_CSV = [
    "sku",
    "product_name",
    "warehouse_code",
    "quantity_on_hand",
    "available_quantity",
    "inbound_quantity",
    "safety_stock",
    "lead_time_days",
    "avg_daily_demand",
    "demand_during_lead_time",
    "projected_stock_at_lead_time",
    "days_of_cover",
    "stockout_date",
    "risk_level",
    "reason",
    "recommended_action",
]


RISK_SORTS = {
    "risk",
    "days_of_cover",
    "projected_stock_at_lead_time",
    "available_quantity",
    "demand_during_lead_time",
    "sku",
    "warehouse_code",
    "stockout_date",
    "avg_daily_demand",
}


@shortages.get(
    "", response_model=StockRiskPage, summary="Stock-shortage risk analysis", responses=ERROR_RESPONSES
)
async def list_shortages(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    page: PageDep,
    warehouse_id: Annotated[int | None, Query(gt=0)] = None,
    min_risk: Annotated[RiskLevel, Query(description="Lowest risk level to include")] = RiskLevel.LOW,
    risk_level: Annotated[RiskLevel | None, Query(description="Only this exact risk level")] = None,
    category: Annotated[str | None, Query(max_length=100)] = None,
    search: SearchQuery = None,
    sort: SortQuery = "risk,days_of_cover",
    format: Annotated[str, Query(pattern="^(json|csv)$")] = "json",
) -> Any:
    """Computed from live stock, open POs and the latest stored forecasts (see README →
    *Shortage detection & restocking algorithm*). Default order: severity, then days of cover.
    Sortable by risk, days_of_cover, projected_stock_at_lead_time, available_quantity,
    demand_during_lead_time, avg_daily_demand, stockout_date, sku, warehouse_code.
    `summary` counts every risk level for the current filters (ignoring `min_risk`)."""
    svc = ReplenishmentService(session, cache)
    every = await svc.risks(
        warehouse_id=warehouse_id, min_level=RiskLevel.NONE, category=category, search=search
    )
    threshold = RISK_ORDER[min_risk]
    rows = svc.sort_rows(
        [
            r
            for r in every
            if (
                r["risk_level"] == risk_level.value
                if risk_level
                else RISK_ORDER[RiskLevel(r["risk_level"])] <= threshold
            )
        ],
        sort or "risk",
        RISK_SORTS,
    )
    if format == "csv":
        return maybe_csv(rows, "stock-risk", RISK_CSV)
    counts = Counter(r["risk_level"] for r in every)
    result = Page.build(
        rows[page.offset : page.offset + page.page_size], len(rows), page.page, page.page_size
    )
    return {
        **result.model_dump(),
        "summary": {
            "total_items": len(every),
            "by_risk_level": {lvl.value: counts.get(lvl.value, 0) for lvl in RiskLevel},
        },
    }


# --------------------------------------------------------------------------- restocking
RESTOCK_SORTS = {
    "risk",
    "estimated_cost",
    "recommended_quantity",
    "available_quantity",
    "sku",
    "warehouse_code",
    "supplier_name",
    "avg_daily_demand",
    "lead_time_days",
}


@restocking.get(
    "",
    response_model=RestockPage,
    summary="Restocking recommendations",
    responses=ERROR_RESPONSES,
)
async def list_recommendations(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    page: PageDep,
    warehouse_id: Annotated[int | None, Query(gt=0)] = None,
    supplier_id: Annotated[int | None, Query(gt=0)] = None,
    search: SearchQuery = None,
    sort: SortQuery = "risk,-estimated_cost",
    format: Annotated[str, Query(pattern="^(json|csv)$")] = "json",
) -> Any:
    """Items whose inventory position (available + open PO quantity, drafts included) is at
    or below the dynamic reorder point. Open POs are subtracted, so items already on order are
    not recommended twice. `summary` totals all matching recommendations (not just this page)."""
    svc = ReplenishmentService(session, cache)
    rows = svc.sort_rows(
        await svc.recommendations(warehouse_id=warehouse_id, supplier_id=supplier_id, search=search),
        sort or "risk",
        RESTOCK_SORTS,
    )
    if format == "csv":
        return maybe_csv(
            rows,
            "restocking",
            [
                "sku",
                "product_name",
                "warehouse_code",
                "supplier_name",
                "available_quantity",
                "inbound_quantity",
                "avg_daily_demand",
                "lead_time_days",
                "safety_stock",
                "reorder_point",
                "recommended_quantity",
                "estimated_cost",
                "risk_level",
            ],
        )
    result = Page.build(
        rows[page.offset : page.offset + page.page_size], len(rows), page.page, page.page_size
    )
    return {
        **result.model_dump(),
        "summary": {
            "items": len(rows),
            "total_units": sum(r["recommended_quantity"] for r in rows),
            "total_estimated_cost": round(sum(r["estimated_cost"] for r in rows), 2),
            "critical": sum(1 for r in rows if r["risk_level"] == RiskLevel.CRITICAL.value),
            "without_supplier": sum(1 for r in rows if r["supplier_id"] is None),
        },
    }


@restocking.post(
    "/purchase-orders",
    response_model=CreatedPurchaseOrders,
    status_code=status.HTTP_201_CREATED,
    summary="Create DRAFT purchase orders from recommendations",
    responses=ERROR_RESPONSES,
)
async def create_pos_from_recommendations(
    body: CreatePOsFromRecommendations, user: ManagePO, session: SessionDep, cache: CacheDep
) -> CreatedPurchaseOrders:
    """Selections are grouped into one DRAFT PO per (supplier, warehouse), atomically."""
    ids, numbers = await ReplenishmentService(session, cache).create_purchase_orders(
        [s.model_dump() for s in body.items], user.id
    )
    return CreatedPurchaseOrders(purchase_order_ids=ids, po_numbers=numbers)


# --------------------------------------------------------------------------- jobs
@jobs.get("", response_model=Page[JobRead], summary="List background jobs", responses=ERROR_RESPONSES)
async def list_jobs(
    _: CurrentUser,
    session: SessionDep,
    page: PageDep,
    type: JobType | None = None,
    status_: Annotated[JobStatus | None, Query(alias="status")] = None,
    sort: SortQuery = None,
) -> Page[JobRead]:
    items, total = await JobService(session).list_jobs(
        page, type_=type, status=status_, user_id=None, sort=sort
    )
    return Page.build(
        [JobRead.model_validate(job_to_dict(j)) for j in items], total, page.page, page.page_size
    )


@jobs.get(
    "/{job_id}",
    response_model=JobRead,
    summary="Job status / progress / result",
    responses={**ERROR_RESPONSES, **NOT_FOUND},
)
async def get_job(job_id: str, _: CurrentUser, session: SessionDep) -> JobRead:
    if len(job_id) > 64:
        raise NotFoundError("Job not found")
    return JobRead.model_validate(job_to_dict(await JobService(session).get(job_id)))
