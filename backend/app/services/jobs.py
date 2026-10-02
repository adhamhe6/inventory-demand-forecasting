"""Background job bookkeeping and dispatch.

Job state lives in PostgreSQL (durable, queryable, survives Redis restarts); Redis/ARQ is
only the delivery mechanism. ``dedupe_key`` + a partial unique index guarantee at most one
QUEUED/RUNNING job per logical task (e.g. the same item forecast clicked twice).
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any, Protocol

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError, ServiceUnavailableError
from app.db.models import Job, JobStatus, JobType
from app.services.common import PageParams, apply_sort, paginate

logger = logging.getLogger(__name__)


class JobDispatcher(Protocol):
    async def dispatch(self, job_id: str) -> None: ...


def job_to_dict(job: Job) -> dict[str, Any]:
    return {
        "id": job.id,
        "type": job.type,
        "status": job.status,
        "params": job.params,
        "result": job.result,
        "error": job.error,
        "progress": job.progress,
        "created_at": job.created_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
    }


class JobService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def submit(
        self,
        dispatcher: JobDispatcher,
        type_: JobType,
        params: dict[str, Any],
        *,
        dedupe_key: str | None,
        user_id: int | None,
    ) -> tuple[Job, bool]:
        """Create + enqueue a job. Returns (job, created); created=False means de-duplicated."""
        if dedupe_key:
            existing = await self._active_by_key(dedupe_key)
            if existing:
                return existing, False
        job = Job(
            id=uuid.uuid4().hex,
            type=type_,
            status=JobStatus.QUEUED,
            params=params,
            dedupe_key=dedupe_key,
            created_by_id=user_id,
            progress=0,
        )
        self.session.add(job)
        try:
            await self.session.commit()
        except IntegrityError:
            await self.session.rollback()
            existing = await self._active_by_key(dedupe_key or "")
            if existing:
                return existing, False
            raise
        logger.info("job queued", extra={"job_id": job.id, "job_type": type_.value})
        try:
            await dispatcher.dispatch(job.id)
        except ServiceUnavailableError:
            await self.mark_failed(job.id, "Job queue unavailable; please retry later")
            raise
        await self.session.refresh(job)
        return job, True

    async def _active_by_key(self, key: str) -> Job | None:
        return await self.session.scalar(
            select(Job).where(Job.dedupe_key == key, Job.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]))
        )

    async def get(self, job_id: str) -> Job:
        job = await self.session.get(Job, job_id, populate_existing=True)
        if job is None:
            raise NotFoundError(f"Job {job_id} not found")
        return job

    async def list(
        self, page: PageParams, *, type_: JobType | None, status: JobStatus | None, user_id: int | None
    ) -> tuple[list[Job], int]:
        stmt = select(Job)
        if type_:
            stmt = stmt.where(Job.type == type_)
        if status:
            stmt = stmt.where(Job.status == status)
        if user_id:
            stmt = stmt.where(Job.created_by_id == user_id)
        stmt = apply_sort(stmt, None, {"id": Job.id, "created_at": Job.created_at}, "-created_at")
        rows, total = await paginate(self.session, stmt, page)
        return [r[0] for r in rows], total

    async def mark_running(self, job_id: str) -> bool:
        """QUEUED → RUNNING. Returns False if the job is not runnable (already done/claimed)."""
        res = await self.session.execute(
            update(Job)
            .where(Job.id == job_id, Job.status == JobStatus.QUEUED)
            .values(status=JobStatus.RUNNING, started_at=datetime.now(UTC), progress=0)
        )
        await self.session.commit()
        return bool(res.rowcount)  # type: ignore[attr-defined]

    async def set_progress(self, job_id: str, progress: int) -> None:
        await self.session.execute(
            update(Job).where(Job.id == job_id).values(progress=max(0, min(progress, 100)))
        )
        await self.session.commit()

    async def mark_succeeded(self, job_id: str, result: dict[str, Any]) -> None:
        await self.session.execute(
            update(Job)
            .where(Job.id == job_id)
            .values(status=JobStatus.SUCCEEDED, result=result, progress=100, finished_at=datetime.now(UTC))
        )
        await self.session.commit()

    async def mark_failed(self, job_id: str, error: str, result: dict[str, Any] | None = None) -> None:
        await self.session.execute(
            update(Job)
            .where(Job.id == job_id)
            .values(status=JobStatus.FAILED, error=error[:2000], result=result, finished_at=datetime.now(UTC))
        )
        await self.session.commit()
