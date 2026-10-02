"""Job implementations, shared by the ARQ worker and the inline (test) dispatcher."""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.cache.redis_cache import Cache
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.logging import job_id_ctx
from app.db.models import JobType
from app.services.forecasting import ForecastService
from app.services.jobs import JobService
from app.services.sales import SalesService

logger = logging.getLogger(__name__)


async def execute_job(job_id: str, sessionmaker: async_sessionmaker[AsyncSession], cache: Cache) -> None:
    """Run a job by id. Never raises: failures are recorded on the job row and logged."""
    token = job_id_ctx.set(job_id)
    started = time.perf_counter()
    try:
        async with sessionmaker() as session:
            jobs = JobService(session)
            if not await jobs.mark_running(job_id):
                logger.warning("job not runnable (already started or finished); skipping")
                return
            job = await jobs.get(job_id)
            job_type, params = job.type, dict(job.params)
        logger.info("job started", extra={"job_type": job_type.value})

        async def progress(pct: int, *_: Any) -> None:
            async with sessionmaker() as s:
                await JobService(s).set_progress(job_id, pct)

        try:
            result = await _run(job_type, params, job_id, sessionmaker, cache, progress)
        except AppError as exc:
            # Expected, user-facing failure (e.g. malformed CSV, unknown product).
            async with sessionmaker() as session:
                await JobService(session).mark_failed(
                    job_id, exc.message, {"code": exc.code, "details": exc.details}
                )
            logger.warning("job failed", extra={"error": exc.message, "code": exc.code})
            return
        except Exception as exc:
            async with sessionmaker() as session:
                await JobService(session).mark_failed(job_id, f"Internal error: {type(exc).__name__}")
            logger.exception("job crashed")
            return
        async with sessionmaker() as session:
            await JobService(session).mark_succeeded(job_id, result)
        logger.info("job succeeded", extra={"duration_ms": round((time.perf_counter() - started) * 1000)})
    finally:
        job_id_ctx.reset(token)


async def _run(
    job_type: JobType,
    params: dict[str, Any],
    job_id: str,
    sessionmaker: async_sessionmaker[AsyncSession],
    cache: Cache,
    progress: Any,
) -> dict[str, Any]:
    if job_type == JobType.FORECAST_ITEM:
        async with sessionmaker() as session:
            run = await ForecastService(session, cache).forecast_item(
                params["product_id"],
                params["warehouse_id"],
                params["horizon_days"],
                params.get("model", "auto"),
                job_id=job_id,
            )
            return {
                "forecast_run_id": run.id,
                "model_name": run.model_name,
                "total_predicted": run.total_predicted,
            }
    if job_type == JobType.FORECAST_ALL:
        return await ForecastService.forecast_all(
            sessionmaker,
            cache,
            params["horizon_days"],
            params.get("warehouse_id"),
            job_id=job_id,
            progress=progress,
        )
    if job_type == JobType.IMPORT_SALES:
        path = Path(get_settings().import_dir) / params["file_id"]
        try:
            async with sessionmaker() as session:
                return await SalesService(session, cache).import_csv(path, progress)
        finally:
            path.unlink(missing_ok=True)  # uploaded file is single-use
    raise AppError(f"Unsupported job type {job_type}")
