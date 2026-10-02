"""Job dispatchers: ARQ (production) and inline (tests / no-worker mode)."""

from __future__ import annotations

import logging

from arq.connections import ArqRedis
from redis.exceptions import RedisError

from app.cache.redis_cache import get_cache
from app.core.errors import ServiceUnavailableError
from app.db.database import get_sessionmaker
from app.workers.tasks import execute_job

logger = logging.getLogger(__name__)


class ArqDispatcher:
    def __init__(self, pool: ArqRedis | None) -> None:
        self.pool = pool

    async def dispatch(self, job_id: str) -> None:
        if self.pool is None:
            raise ServiceUnavailableError("Job queue is not connected")
        try:
            # _job_id makes enqueueing idempotent at the queue level as well.
            await self.pool.enqueue_job("run_job", job_id, _job_id=job_id)
        except (RedisError, OSError) as exc:
            logger.error("failed to enqueue job", extra={"job_id": job_id, "error": str(exc)})
            raise ServiceUnavailableError("Job queue unavailable") from exc


class InlineDispatcher:
    """Executes the job immediately in-process. Used by tests (JOB_BACKEND=inline)."""

    async def dispatch(self, job_id: str) -> None:
        await execute_job(job_id, get_sessionmaker(), get_cache())
