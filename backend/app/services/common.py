"""Shared query helpers: pagination, safe sorting and idempotency records."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy import ColumnElement, Select, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, ConflictError
from app.db.models import IdempotencyRecord


@dataclass(frozen=True)
class PageParams:
    page: int = 1
    page_size: int = 25

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size


def apply_sort(
    stmt: Select[Any],
    sort: str | None,
    allowed: dict[str, ColumnElement[Any] | Any],
    default: str,
) -> Select[Any]:
    """Apply ``sort=field`` / ``sort=-field`` using an allow-list (never raw user SQL).

    Multiple fields can be comma separated. A stable tiebreaker on the first allowed column
    keeps pagination deterministic.
    """
    spec = sort or default
    order = []
    for part in [p.strip() for p in spec.split(",") if p.strip()]:
        desc = part.startswith("-")
        name = part.lstrip("-+")
        if name not in allowed:
            raise AppError(
                f"Cannot sort by '{name}'",
                code="INVALID_SORT",
                details={"allowed": sorted(allowed)},
            )
        col = allowed[name]
        order.append(col.desc().nulls_last() if desc else col.asc().nulls_last())
    if "id" in allowed:
        order.append(allowed["id"].asc())
    return stmt.order_by(*order)


async def paginate(session: AsyncSession, stmt: Select[Any], params: PageParams) -> tuple[list[Any], int]:
    total = await session.scalar(select(func.count()).select_from(stmt.order_by(None).subquery()))
    rows = (await session.execute(stmt.limit(params.page_size).offset(params.offset))).all()
    return list(rows), int(total or 0)


def request_fingerprint(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


async def get_idempotent_response(
    session: AsyncSession, key: str | None, scope: str, fingerprint: str
) -> IdempotencyRecord | None:
    """Return the stored record for a replayed request, or None if it is new.

    Reusing a key with a *different* payload is a client bug and is rejected.
    """
    if not key:
        return None
    record = await session.get(IdempotencyRecord, {"key": key, "scope": scope})
    if record is None:
        return None
    if record.request_hash != fingerprint:
        raise ConflictError(
            "Idempotency-Key was already used with a different request payload",
            code="IDEMPOTENCY_KEY_REUSED",
        )
    return record


async def store_idempotent_response(
    session: AsyncSession,
    key: str | None,
    scope: str,
    fingerprint: str,
    status_code: int,
    body: Any,
    user_id: int | None,
) -> None:
    """Persist the response in the caller's transaction (commit makes effect + record atomic).

    ON CONFLICT DO NOTHING + rowcount check detects a concurrent duplicate request: the
    loser raises, its transaction rolls back, and no business effect is applied twice.
    """
    if not key:
        return
    stmt = (
        pg_insert(IdempotencyRecord)
        .values(
            key=key,
            scope=scope,
            request_hash=fingerprint,
            status_code=status_code,
            response_body=json.loads(json.dumps(body, default=str)),
            user_id=user_id,
        )
        .on_conflict_do_nothing()
    )
    result = await session.execute(stmt)
    if result.rowcount == 0:  # type: ignore[attr-defined]
        raise ConflictError(
            "A request with this Idempotency-Key is already being processed",
            code="IDEMPOTENCY_IN_PROGRESS",
        )
