"""ARQ worker entrypoint: ``arq app.workers.worker.WorkerSettings``.

Why ARQ: the API is asyncio-native (FastAPI + asyncpg). ARQ is a small asyncio job queue on
Redis, so the worker reuses the exact same async services, sessions and cache code. Celery
would add a sync-first runtime, a separate broker abstraction and more operational surface
for no benefit at this scale. CPU-heavy model fitting runs in a thread (``asyncio.to_thread``)
so the worker's event loop keeps heart-beating.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from arq import cron
from arq.connections import RedisSettings
from sqlalchemy import select, update

from app.cache.redis_cache import close_redis, get_cache
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.db.database import dispose_engine, get_sessionmaker
from app.db.models import Job, JobStatus, JobType
from app.workers.tasks import execute_job

logger = logging.getLogger(__name__)
settings = get_settings()
JOB_TIMEOUT_SECONDS = 60 * 60


async def startup(ctx: dict[str, Any]) -> None:
    configure_logging(settings.log_level, settings.log_json)
    ctx["sessionmaker"] = get_sessionmaker()
    ctx["cache"] = get_cache()
    await reap_stale_jobs(ctx)
    logger.info("worker started")


async def reap_stale_jobs(ctx: dict[str, Any]) -> None:
    """Fail jobs stuck in RUNNING longer than the job timeout (their worker died).

    ARQ kills jobs at ``job_timeout``, so anything RUNNING beyond it can never finish. Using
    the timeout (not "all RUNNING jobs") keeps this safe with several worker replicas.
    """
    cutoff = datetime.now(UTC) - timedelta(seconds=JOB_TIMEOUT_SECONDS + 60)
    async with ctx["sessionmaker"]() as session:
        res = await session.execute(
            update(Job)
            .where(Job.status == JobStatus.RUNNING, Job.started_at < cutoff)
            .values(
                status=JobStatus.FAILED,
                error="Job timed out or its worker stopped",
                finished_at=datetime.now(UTC),
            )
        )
        await session.commit()
    if res.rowcount:
        logger.warning("marked stale jobs as failed", extra={"count": res.rowcount})


async def shutdown(ctx: dict[str, Any]) -> None:
    await dispose_engine()
    await close_redis()
    logger.info("worker stopped")


async def run_job(ctx: dict[str, Any], job_id: str) -> None:
    await execute_job(job_id, ctx["sessionmaker"], ctx["cache"])


async def nightly_forecast(ctx: dict[str, Any]) -> None:
    """Scheduled refresh of all forecasts (creates a tracked FORECAST_ALL job)."""
    async with ctx["sessionmaker"]() as session:
        active = await session.scalar(
            select(Job.id).where(
                Job.dedupe_key == "forecast_all:all", Job.status.in_([JobStatus.QUEUED, JobStatus.RUNNING])
            )
        )
        if active:
            logger.info("nightly forecast skipped; one already active")
            return
        job = Job(
            id=uuid.uuid4().hex,
            type=JobType.FORECAST_ALL,
            status=JobStatus.QUEUED,
            params={
                "horizon_days": settings.forecast_default_horizon_days,
                "warehouse_id": None,
                "trigger": "cron",
            },
            dedupe_key="forecast_all:all",
        )
        session.add(job)
        await session.commit()
    await execute_job(job.id, ctx["sessionmaker"], ctx["cache"])


class WorkerSettings:
    functions = [run_job]
    cron_jobs = [
        cron(nightly_forecast, hour={settings.nightly_forecast_hour_utc}, minute={0}, run_at_startup=False),
        cron(reap_stale_jobs, minute=set(range(0, 60, 10)), run_at_startup=False),
    ]
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    max_jobs = 4
    job_timeout = JOB_TIMEOUT_SECONDS
    max_tries = 1  # failures are recorded on the job row; users retry explicitly
    keep_result = 3600
    health_check_interval = 30
