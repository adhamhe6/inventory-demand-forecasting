from datetime import UTC, datetime, timedelta

import pytest

from app.cache.redis_cache import get_redis
from app.db.database import get_sessionmaker
from app.db.models import Job, JobStatus, JobType
from app.workers.worker import reap_stale_jobs

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
    await redis.set("arq:in-progress:alive", b"1", ex=60)
    await reap_stale_jobs({"sessionmaker": get_sessionmaker(), "redis": redis})
    async with get_sessionmaker()() as s:
        statuses = {j: (await s.get(Job, j)).status for j in ("orphan", "alive", "fresh")}
    assert statuses == {"orphan": JobStatus.FAILED, "alive": JobStatus.RUNNING, "fresh": JobStatus.RUNNING}
