"""ARQ worker entrypoint: ``arq app.workers.worker.WorkerSettings``.

Why ARQ: the API is asyncio-native (FastAPI + asyncpg). ARQ is a small asyncio job queue on
Redis, so the worker reuses the exact same async services, sessions and cache code. Celery
would add a sync-first runtime, a separate broker abstraction and more operational surface
for no benefit at this scale. CPU-heavy model fitting runs in a thread (``asyncio.to_thread``)
so the worker's event loop keeps heart-beating.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from arq import cron
from arq.connections import RedisSettings
from redis.exceptions import RedisError
from sqlalchemy import select, update

from app.cache.redis_cache import close_redis, get_cache
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.db.database import dispose_engine, get_sessionmaker
from app.db.models import Job, JobStatus, JobType
from app.services.jobs import JobService
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
QUEUED_GRACE_SECONDS = 600
# A running job refreshes its heartbeat every HEARTBEAT_INTERVAL; it is considered dead once the
# key has expired. ARQ's own ``arq:in-progress`` marker is *not* a liveness signal: it is set
# with the job timeout (1 h) as TTL, so it outlives a crashed worker by up to an hour.
HEARTBEAT_INTERVAL_SECONDS = 10
HEARTBEAT_TTL_SECONDS = 45


def heartbeat_key(job_id: str) -> str:
    return f"job:heartbeat:{job_id}"


async def reap_stale_jobs(ctx: dict[str, Any]) -> None:
    """Fail jobs whose work can no longer happen, so none stays "in progress" forever.

    * RUNNING jobs whose heartbeat key has expired (the executing worker refreshes it every few
      seconds) or that exceeded the job timeout. Checking a per-job heartbeat rather than "all
      RUNNING jobs" keeps this safe with several worker replicas.
    * QUEUED jobs older than QUEUED_GRACE_SECONDS whose ARQ job key is gone: the queue lost them
      (e.g. Redis restarted without persistence), so no worker will ever start them. Left alone they
      would also block their dedupe key, and with it every later run of the same job.

    If Redis is unreachable nothing is reaped: absence of evidence is not evidence of a dead worker.
    """
    now = datetime.now(UTC)
    redis = ctx["redis"]
    async with ctx["sessionmaker"]() as session:
        candidates = (
            await session.execute(
                select(Job.id, Job.status, Job.started_at).where(
                    (
                        (Job.status == JobStatus.RUNNING)
                        & (Job.started_at < now - timedelta(seconds=ORPHAN_GRACE_SECONDS))
                    )
                    | (
                        (Job.status == JobStatus.QUEUED)
                        & (Job.created_at < now - timedelta(seconds=QUEUED_GRACE_SECONDS))
                    )
                )
            )
        ).all()
        dead_running: list[str] = []
        lost_queued: list[str] = []
        try:
            for job_id, status, started_at in candidates:
                if status == JobStatus.RUNNING:
                    timed_out = started_at < now - timedelta(seconds=JOB_TIMEOUT_SECONDS + 60)
                    if timed_out or not await redis.exists(heartbeat_key(job_id)):
                        dead_running.append(job_id)
                elif not await redis.exists(f"arq:job:{job_id}"):
                    lost_queued.append(job_id)
        except RedisError:
            logger.warning("reaper skipped: redis unavailable")
            return
        for ids, status, message in (
            (dead_running, JobStatus.RUNNING, "The worker stopped while this job was running; please retry"),
            (lost_queued, JobStatus.QUEUED, "The job queue lost this job before it started; please retry"),
        ):
            if ids:
                await session.execute(
                    update(Job)
                    .where(Job.id.in_(ids), Job.status == status)
                    .values(status=JobStatus.FAILED, error=message, finished_at=now)
                )
        if dead_running or lost_queued:
            await session.commit()
            logger.warning("failed orphaned jobs", extra={"running": dead_running, "queued": lost_queued})


async def shutdown(ctx: dict[str, Any]) -> None:
    await dispose_engine()
    await close_redis()
    logger.info("worker stopped")


async def run_job(ctx: dict[str, Any], job_id: str) -> None:
    redis = ctx["redis"]
    key = heartbeat_key(job_id)

    async def touch() -> None:
        with contextlib.suppress(RedisError):
            await redis.set(key, b"1", ex=HEARTBEAT_TTL_SECONDS)

    async def beat() -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
            await touch()

    await touch()  # alive before the job is marked RUNNING

    heartbeat = asyncio.create_task(beat())
    try:
        await execute_job(job_id, ctx["sessionmaker"], ctx["cache"])
    finally:
        heartbeat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat
        with contextlib.suppress(RedisError):
            await redis.delete(key)


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
    # Enqueue through ARQ (not inline) so it runs on a worker with a heartbeat like any other job.
    try:
        await ctx["redis"].enqueue_job("run_job", job.id, _job_id=job.id)
    except RedisError:
        # Never leave a QUEUED row nobody will run: it would block the dedupe key for later runs.
        async with ctx["sessionmaker"]() as session:
            await JobService(session).mark_failed(job.id, "Job queue unavailable; please retry later")
        logger.exception("nightly forecast could not be enqueued")


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
