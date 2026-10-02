import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from app.cache.redis_cache import get_redis
from app.db.database import get_sessionmaker
from app.db.models import Job, JobStatus, JobType
from app.workers import worker
from app.workers.worker import heartbeat_key, reap_stale_jobs, run_job

pytestmark = pytest.mark.integration


async def test_reaper_fails_only_orphaned_running_jobs(db: None) -> None:
    old = datetime.now(UTC) - timedelta(minutes=5)
    async with get_sessionmaker()() as s:
        s.add_all(
            [
                Job(
                    id="orphan",
                    type=JobType.FORECAST_ALL,
                    status=JobStatus.RUNNING,
                    params={},
                    started_at=old,
                ),
                Job(
                    id="alive", type=JobType.FORECAST_ALL, status=JobStatus.RUNNING, params={}, started_at=old
                ),
                Job(
                    id="fresh",
                    type=JobType.FORECAST_ALL,
                    status=JobStatus.RUNNING,
                    params={},
                    started_at=datetime.now(UTC),
                ),
            ]
        )
        await s.commit()
    redis = get_redis()
    await redis.set(heartbeat_key("alive"), b"1", ex=60)
    # A crashed worker leaves ARQ's in-progress marker behind for up to the job timeout; it must
    # not keep the orphan alive (regression: jobs stayed RUNNING for an hour after a crash).
    await redis.set("arq:in-progress:orphan", b"1", ex=3600)
    await reap_stale_jobs({"sessionmaker": get_sessionmaker(), "redis": redis})
    async with get_sessionmaker()() as s:
        statuses = {j: (await s.get(Job, j)).status for j in ("orphan", "alive", "fresh")}
    assert statuses == {"orphan": JobStatus.FAILED, "alive": JobStatus.RUNNING, "fresh": JobStatus.RUNNING}


async def test_run_job_keeps_a_heartbeat_while_running_and_clears_it(db: None, monkeypatch) -> None:
    redis = get_redis()
    seen: list[int] = []

    async def fake_execute(job_id, sessionmaker, cache) -> None:
        seen.append(await redis.exists(heartbeat_key(job_id)))
        await asyncio.sleep(0.25)  # spans several heartbeat intervals
        seen.append(await redis.exists(heartbeat_key(job_id)))

    monkeypatch.setattr(worker, "execute_job", fake_execute)
    monkeypatch.setattr(worker, "HEARTBEAT_INTERVAL_SECONDS", 0.05)
    await run_job({"redis": redis, "sessionmaker": None, "cache": None}, "hb-job")
    assert seen == [1, 1]
    assert await redis.exists(heartbeat_key("hb-job")) == 0
