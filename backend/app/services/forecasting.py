"""Bridges stored sales history and the pure forecasting pipeline; persists results."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import Select, delete, func, select, union
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from app.cache.redis_cache import Cache, CacheDomain
from app.core.config import get_settings
from app.core.errors import NotFoundError
from app.db.models import (
    EntityStatus,
    ForecastPoint,
    ForecastRun,
    InventoryItem,
    Product,
    Sale,
    Warehouse,
)
from app.forecasting.pipeline import ForecastResult, run_forecast
from app.forecasting.preprocessing import build_daily_series
from app.services.catalog import _ilike_any
from app.services.common import PageParams, apply_sort, paginate
from app.services.sales import SalesService

logger = logging.getLogger(__name__)
KEEP_RUNS_PER_ITEM = 5


def today_utc() -> date:
    return datetime.now(UTC).date()


def latest_runs_subquery() -> Any:
    """Latest forecast run id per (product, warehouse) using DISTINCT ON."""
    return (
        select(ForecastRun.id)
        .distinct(ForecastRun.product_id, ForecastRun.warehouse_id)
        .order_by(
            ForecastRun.product_id,
            ForecastRun.warehouse_id,
            ForecastRun.generated_at.desc(),
            ForecastRun.id.desc(),
        )
        .subquery()
    )


class ForecastService:
    def __init__(self, session: AsyncSession, cache: Cache) -> None:
        self.session = session
        self.cache = cache
        self.settings = get_settings()

    async def history(
        self, product_id: int, warehouse_id: int, days: int | None = None
    ) -> tuple[date, date, list[tuple[date, float]]]:
        """Return (start, end, daily observations) for the item's usable history window.

        The window ends yesterday (last complete UTC day) and starts at the later of
        ``end - history_days`` and the item's first recorded sale (no leading fake zeros).
        """
        end = today_utc() - timedelta(days=1)
        start = end - timedelta(days=(days or self.settings.forecast_history_days) - 1)
        first_sale = await self.session.scalar(
            select(func.min(Sale.sold_at)).where(
                Sale.product_id == product_id, Sale.warehouse_id == warehouse_id
            )
        )
        if first_sale is not None:
            start = max(start, first_sale.astimezone(UTC).date())
        if start > end:
            start = end
        obs = await SalesService(self.session, self.cache).daily_totals(product_id, warehouse_id, start, end)
        return start, end, obs

    async def forecast_item(
        self, product_id: int, warehouse_id: int, horizon: int, model: str = "auto", job_id: str | None = None
    ) -> ForecastRun:
        product = await self.session.get(Product, product_id)
        if product is None:
            raise NotFoundError(f"Product {product_id} not found", code="PRODUCT_NOT_FOUND")
        if await self.session.get(Warehouse, warehouse_id) is None:
            raise NotFoundError(f"Warehouse {warehouse_id} not found", code="WAREHOUSE_NOT_FOUND")
        start, end, obs = await self.history(product_id, warehouse_id)
        series = build_daily_series(obs, start, end)
        # CPU-bound (statsmodels); keep the event loop responsive.
        result: ForecastResult = await asyncio.to_thread(
            run_forecast,
            series,
            horizon,
            model=model,
            backtest_days=self.settings.forecast_backtest_days,
            min_history=self.settings.forecast_min_history_days,
        )
        run = ForecastRun(
            product_id=product_id,
            warehouse_id=warehouse_id,
            horizon_days=horizon,
            model_name=result.model_name,
            model_version=result.model_version,
            history_start=start if obs else None,
            history_end=end,
            history_days=len(series),
            total_predicted=round(result.total, 4),
            avg_daily_demand=round(result.avg_daily, 4),
            metrics=result.metrics,
            details=result.details,
            job_id=job_id,
            points=[
                ForecastPoint(forecast_date=d, predicted=float(p), lower=float(lo), upper=float(hi))
                for d, p, lo, hi in zip(
                    result.dates, result.predicted, result.lower, result.upper, strict=True
                )
            ],
        )
        self.session.add(run)
        await self.session.flush()
        await self._prune(product_id, warehouse_id)
        await self.session.commit()
        await self.cache.invalidate(CacheDomain.FORECASTS)
        logger.info(
            "forecast stored",
            extra={
                "run_id": run.id,
                "product_id": product_id,
                "warehouse_id": warehouse_id,
                "model": result.model_name,
                "mae": result.metrics.get("mae"),
                "horizon": horizon,
            },
        )
        return run

    async def _prune(self, product_id: int, warehouse_id: int) -> None:
        keep = (
            select(ForecastRun.id)
            .where(ForecastRun.product_id == product_id, ForecastRun.warehouse_id == warehouse_id)
            .order_by(ForecastRun.generated_at.desc(), ForecastRun.id.desc())
            .limit(KEEP_RUNS_PER_ITEM)
        )
        await self.session.execute(
            delete(ForecastRun).where(
                ForecastRun.product_id == product_id,
                ForecastRun.warehouse_id == warehouse_id,
                ForecastRun.id.not_in(keep),
            )
        )

    async def forecastable_items(self, warehouse_id: int | None = None) -> list[tuple[int, int]]:
        """Active (product, warehouse) pairs that have stock records or recent sales."""
        since = datetime.now(UTC) - timedelta(days=self.settings.forecast_history_days)
        pairs = union(
            select(InventoryItem.product_id, InventoryItem.warehouse_id),
            select(Sale.product_id, Sale.warehouse_id).where(Sale.sold_at >= since).distinct(),
        ).subquery()
        stmt = (
            select(pairs.c.product_id, pairs.c.warehouse_id)
            .join(Product, Product.id == pairs.c.product_id)
            .join(Warehouse, Warehouse.id == pairs.c.warehouse_id)
            .where(Product.is_active.is_(True), Warehouse.status == EntityStatus.ACTIVE)
            .order_by(pairs.c.product_id, pairs.c.warehouse_id)
        )
        if warehouse_id:
            stmt = stmt.where(pairs.c.warehouse_id == warehouse_id)
        return [(r[0], r[1]) for r in (await self.session.execute(stmt)).all()]

    @staticmethod
    async def forecast_all(
        sessionmaker: async_sessionmaker[AsyncSession],
        cache: Cache,
        horizon: int,
        warehouse_id: int | None = None,
        job_id: str | None = None,
        progress: Callable[[int], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        """Forecast every item, each in its own transaction; one failure doesn't stop the batch."""
        async with sessionmaker() as session:
            items = await ForecastService(session, cache).forecastable_items(warehouse_id)
        ok, failed, models = 0, [], {}  # type: ignore[var-annotated]
        for idx, (pid, wid) in enumerate(items, start=1):
            try:
                async with sessionmaker() as session:
                    run = await ForecastService(session, cache).forecast_item(
                        pid, wid, horizon, job_id=job_id
                    )
                    models[run.model_name] = models.get(run.model_name, 0) + 1
                ok += 1
            except Exception as exc:
                logger.exception("forecast failed for item", extra={"product_id": pid, "warehouse_id": wid})
                failed.append({"product_id": pid, "warehouse_id": wid, "error": str(exc)[:300]})
            if progress and (idx % 5 == 0 or idx == len(items)):
                await progress(int(idx * 100 / max(len(items), 1)))
        return {
            "items": len(items),
            "succeeded": ok,
            "failed": len(failed),
            "failures": failed[:20],
            "models": models,
        }

    # ------------------------------------------------------------------ reads
    async def get_run(self, run_id: int) -> dict[str, Any]:
        run = await self.session.scalar(
            select(ForecastRun)
            .options(
                selectinload(ForecastRun.points),
                selectinload(ForecastRun.product),
                selectinload(ForecastRun.warehouse),
            )
            .where(ForecastRun.id == run_id)
        )
        if run is None:
            raise NotFoundError(f"Forecast {run_id} not found")
        return self._run_dict(run, with_points=True)

    async def latest_for_item(self, product_id: int, warehouse_id: int) -> dict[str, Any] | None:
        run = await self.session.scalar(
            select(ForecastRun)
            .options(
                selectinload(ForecastRun.points),
                selectinload(ForecastRun.product),
                selectinload(ForecastRun.warehouse),
            )
            .where(ForecastRun.product_id == product_id, ForecastRun.warehouse_id == warehouse_id)
            .order_by(ForecastRun.generated_at.desc(), ForecastRun.id.desc())
            .limit(1)
        )
        return self._run_dict(run, with_points=True) if run else None

    @staticmethod
    def _run_dict(run: ForecastRun, *, with_points: bool) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": run.id,
            "product_id": run.product_id,
            "sku": run.product.sku,
            "product_name": run.product.name,
            "warehouse_id": run.warehouse_id,
            "warehouse_code": run.warehouse.code,
            "horizon_days": run.horizon_days,
            "model_name": run.model_name,
            "model_version": run.model_version,
            "generated_at": run.generated_at,
            "total_predicted": run.total_predicted,
            "avg_daily_demand": run.avg_daily_demand,
            "history_days": run.history_days,
            "metrics": run.metrics,
        }
        if with_points:
            data.update(
                history_start=run.history_start,
                history_end=run.history_end,
                details=run.details,
                points=[
                    {"date": p.forecast_date, "predicted": p.predicted, "lower": p.lower, "upper": p.upper}
                    for p in run.points
                ],
            )
        return data

    async def list_latest(
        self,
        page: PageParams,
        *,
        warehouse_id: int | None,
        product_id: int | None,
        model_name: str | None,
        search: str | None,
        sort: str | None,
    ) -> tuple[list[dict[str, Any]], int]:
        latest = latest_runs_subquery()
        stmt: Select[Any] = (
            select(ForecastRun)
            .join(latest, latest.c.id == ForecastRun.id)
            .join(Product, Product.id == ForecastRun.product_id)
            .join(Warehouse, Warehouse.id == ForecastRun.warehouse_id)
            .options(selectinload(ForecastRun.product), selectinload(ForecastRun.warehouse))
        )
        if warehouse_id:
            stmt = stmt.where(ForecastRun.warehouse_id == warehouse_id)
        if product_id:
            stmt = stmt.where(ForecastRun.product_id == product_id)
        if model_name:
            stmt = stmt.where(ForecastRun.model_name == model_name)
        if search:
            stmt = stmt.where(_ilike_any(search, Product.sku, Product.name))
        stmt = apply_sort(
            stmt,
            sort,
            {
                "id": ForecastRun.id,
                "generated_at": ForecastRun.generated_at,
                "sku": Product.sku,
                "total_predicted": ForecastRun.total_predicted,
                "avg_daily_demand": ForecastRun.avg_daily_demand,
                "mae": ForecastRun.metrics["mae"].as_float(),
                "wape": ForecastRun.metrics["wape"].as_float(),
            },
            "-total_predicted",
        )
        rows, total = await paginate(self.session, stmt, page)
        return [self._run_dict(r[0], with_points=False) for r in rows], total

    async def history_points(self, product_id: int, warehouse_id: int, days: int) -> list[dict[str, Any]]:
        start, end, obs = await self.history(product_id, warehouse_id, days)
        series = build_daily_series(obs, start, end)
        return [{"date": ts.date(), "quantity": float(v)} for ts, v in series.items()]
