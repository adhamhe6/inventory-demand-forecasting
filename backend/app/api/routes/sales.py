from __future__ import annotations

import uuid
from datetime import date
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Query, UploadFile, status

from app.api.dependencies import (
    CacheDep,
    CurrentUser,
    DispatcherDep,
    IdempotencyKey,
    PageDep,
    SearchQuery,
    SessionDep,
    SortQuery,
    require,
)
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.security import Permission
from app.db.models import JobType, User
from app.schemas.common import CONFLICT, ERROR_RESPONSES, ErrorResponse, Page
from app.schemas.forecasting import JobRead
from app.schemas.sales import SaleCreate, SaleRead
from app.services.common import get_idempotent_response, request_fingerprint, store_idempotent_response
from app.services.jobs import JobService, job_to_dict
from app.services.sales import SalesService

router = APIRouter(prefix="/sales", tags=["Sales"])
RecordSales = Annotated[User, Depends(require(Permission.RECORD_SALES))]
ImportSales = Annotated[User, Depends(require(Permission.IMPORT_SALES))]

CHUNK = 1024 * 1024


@router.get("", response_model=Page[SaleRead], summary="List sales", responses=ERROR_RESPONSES)
async def list_sales(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    page: PageDep,
    product_id: Annotated[int | None, Query(gt=0)] = None,
    warehouse_id: Annotated[int | None, Query(gt=0)] = None,
    date_from: date | None = None,
    date_to: date | None = None,
    search: SearchQuery = None,
    sort: SortQuery = None,
) -> Page[SaleRead]:
    items, total = await SalesService(session, cache).list(
        page,
        product_id=product_id,
        warehouse_id=warehouse_id,
        date_from=date_from,
        date_to=date_to,
        search=search,
        sort=sort,
    )
    return Page.build([SaleRead.model_validate(i) for i in items], total, page.page, page.page_size)


@router.post(
    "",
    response_model=SaleRead,
    status_code=status.HTTP_201_CREATED,
    summary="Record a sale",
    responses={**ERROR_RESPONSES, **CONFLICT},
)
async def create_sale(
    body: SaleCreate,
    user: RecordSales,
    session: SessionDep,
    cache: CacheDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Records the sale and (by default) issues stock with a SALE ledger entry in the same
    transaction. Duplicate (order_reference, product, warehouse) → 409 ``DUPLICATE_SALE``."""
    scope = f"sales.create:{user.id}"
    fingerprint = request_fingerprint(body.model_dump(mode="json"))
    record = await get_idempotent_response(session, idempotency_key, scope, fingerprint)
    if record is not None:
        return record.response_body
    svc = SalesService(session, cache)
    sale = SaleRead.model_validate(await svc.create(body, user.id)).model_dump(mode="json")
    await store_idempotent_response(session, idempotency_key, scope, fingerprint, 201, sale, user.id)
    await session.commit()
    await svc.after_commit(stock_changed=body.issue_stock)
    return sale


@router.post(
    "/import",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Import historical sales from CSV (background job)",
    responses={**ERROR_RESPONSES, 413: {"model": ErrorResponse, "description": "File too large"}},
)
async def import_sales(
    user: ImportSales,
    session: SessionDep,
    dispatcher: DispatcherDep,
    file: Annotated[
        UploadFile, File(description="CSV: sku,warehouse_code,sold_at,quantity,order_reference[,unit_price]")
    ],
) -> JobRead:
    """Uploads are streamed to disk in 1 MB chunks (size-limited), stored under a random
    server-side name (the client filename is never used as a path), then processed by the
    worker in batches. Poll ``GET /jobs/{id}`` for progress and the row-level error report.
    Re-importing the same rows is safe: duplicates are skipped and counted."""
    settings = get_settings()
    name = (file.filename or "").lower()
    if not name.endswith(".csv"):
        raise AppError("Only .csv files are accepted", code="INVALID_FILE_TYPE")
    import_dir = Path(settings.import_dir)
    import_dir.mkdir(parents=True, exist_ok=True)
    file_id = f"{uuid.uuid4().hex}.csv"
    target = import_dir / file_id
    limit = settings.max_import_file_mb * 1024 * 1024
    written = 0
    try:
        with target.open("wb") as out:
            while chunk := await file.read(CHUNK):
                written += len(chunk)
                if written > limit:
                    raise AppError(
                        f"File exceeds {settings.max_import_file_mb} MB limit", code="FILE_TOO_LARGE"
                    )
                if written == len(chunk) and b"\x00" in chunk[:4096]:
                    raise AppError("File does not look like a text CSV", code="INVALID_FILE_TYPE")
                out.write(chunk)
    except AppError as exc:
        target.unlink(missing_ok=True)
        if exc.code == "FILE_TOO_LARGE":
            exc.status_code = 413
        raise
    if written == 0:
        target.unlink(missing_ok=True)
        raise AppError("Uploaded file is empty", code="EMPTY_FILE")
    job, _created = await JobService(session).submit(
        dispatcher,
        JobType.IMPORT_SALES,
        {"file_id": file_id, "filename": (file.filename or "")[:200], "size_bytes": written},
        dedupe_key=None,
        user_id=user.id,
    )
    return JobRead.model_validate(job_to_dict(job))
