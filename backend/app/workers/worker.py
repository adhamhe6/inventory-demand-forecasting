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


ORPHAN_GRACE_SECONDS = 60


async def reap_stale_jobs(ctx: dict[str, Any]) -> None:
    """Fail RUNNING jobs whose worker is gone, so the UI never shows a job stuck forever.

    A job is orphaned when ARQ no longer holds its in-progress marker
    (``arq:in-progress:<job id>``, kept alive by the executing worker) or when it has exceeded
    the job timeout. Checking the marker rather than "all RUNNING jobs" keeps this safe with
    several worker replicas.
    """
    now = datetime.now(UTC)
    async with ctx["sessionmaker"]() as session:
        running = (
            await session.execute(
                select(Job.id, Job.started_at).where(
                    Job.status == JobStatus.RUNNING,
                    Job.started_at < now - timedelta(seconds=ORPHAN_GRACE_SECONDS),
                )
            )
        ).all()
        orphaned = []
        for job_id, started_at in running:
            timed_out = started_at < now - timedelta(seconds=JOB_TIMEOUT_SECONDS + 60)
            alive = await ctx["redis"].exists(f"arq:in-progress:{job_id}")
            if timed_out or not alive:
                orphaned.append(job_id)
        if orphaned:
            await session.execute(
                update(Job)
                .where(Job.id.in_(orphaned), Job.status == JobStatus.RUNNING)
                .values(
                    status=JobStatus.FAILED,
                    error="The worker stopped while this job was running; please retry",
                    finished_at=now,
                )
            )
            await session.commit()
            logger.warning("marked orphaned jobs as failed", extra={"job_ids": orphaned})


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
    # Enqueue through ARQ (not inline) so the job gets an in-progress marker like any other.
    await ctx["redis"].enqueue_job("run_job", job.id, _job_id=job.id)


class WorkerSettings:
    functions = [run_job]
    cron_jobs = [
        cron(nightly_forecast, hour={settings.nightly_forecast_hour_utc}, minute={0}, run_at_startup=False),
        cron(reap_stale_jobs, minute=set(range(0, 60, 2)), run_at_startup=False),
    ]
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    max_jobs = 4
    job_timeout = JOB_TIMEOUT_SECONDS
    max_tries = 1  # failures are recorded on the job row; users retry explicitly
    keep_result = 3600
    health_check_interval = 30
