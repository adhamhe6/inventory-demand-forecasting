"""Inventory queries and warehouse stock operations."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import (
    CacheDep,
    CurrentUser,
    IdempotencyKey,
    PageDep,
    SearchQuery,
    SessionDep,
    SortQuery,
    require,
)
from app.api.export import maybe_csv
from app.cache.redis_cache import Cache
from app.core.security import Permission
from app.db.models import TransactionType, User
from app.schemas.common import ERROR_RESPONSES, NOT_FOUND, ErrorResponse, Page
from app.schemas.inventory import (
    InventoryItemRead,
    InventoryItemUpdate,
    StockAdjustment,
    StockMovement,
    StockOperationResult,
    StockStatus,
    StockTransfer,
    TransactionRead,
)
from app.services.common import (
    PageParams,
    get_idempotent_response,
    request_fingerprint,
    store_idempotent_response,
)
from app.services.inventory import InventoryService

router = APIRouter(prefix="/inventory", tags=["Inventory"])

StockOps = Annotated[User, Depends(require(Permission.STOCK_OPERATIONS))]
StockAdjust = Annotated[User, Depends(require(Permission.STOCK_ADJUST))]

OP_RESPONSES: dict[int | str, dict[str, Any]] = {
    **ERROR_RESPONSES,
    **NOT_FOUND,
    409: {"model": ErrorResponse, "description": "Idempotency-Key reused with a different payload"},
    422: {"model": ErrorResponse, "description": "Validation error or INSUFFICIENT_STOCK"},
}


async def run_idempotent(
    session: AsyncSession,
    cache: Cache,
    user: User,
    key: str | None,
    scope: str,
    body: BaseModel,
    op: Callable[[], Awaitable[dict[str, Any]]],
) -> Any:
    """Execute a stock operation exactly once per Idempotency-Key.

    The response is stored in the same DB transaction as the stock change, so either both
    are committed or neither is. A replay returns the stored response verbatim.
    """
    scope = f"{scope}:{user.id}"
    fingerprint = request_fingerprint(body.model_dump(mode="json"))
    record = await get_idempotent_response(session, key, scope, fingerprint)
    if record is not None:
        return JSONResponse(
            record.response_body, status_code=record.status_code, headers={"Idempotent-Replayed": "true"}
        )
    result = StockOperationResult.model_validate(await op()).model_dump(mode="json")
    await store_idempotent_response(session, key, scope, fingerprint, 200, result, user.id)
    await session.commit()
    await InventoryService(session, cache).after_commit()
    return result


@router.get(
    "", response_model=Page[InventoryItemRead], summary="List stock levels", responses=ERROR_RESPONSES
)
async def list_inventory(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    page: PageDep,
    warehouse_id: Annotated[int | None, Query(gt=0)] = None,
    product_id: Annotated[int | None, Query(gt=0)] = None,
    category: Annotated[str | None, Query(max_length=100)] = None,
    status: StockStatus | None = None,
    search: SearchQuery = None,
    sort: SortQuery = None,
    format: Annotated[str, Query(pattern="^(json|csv)$")] = "json",
) -> Any:
    """Warehouse-level stock with effective safety stock / reorder point and a derived status:
    OUT_OF_STOCK (available ≤ 0), CRITICAL (≤ safety stock), LOW_STOCK (≤ reorder point),
    HEALTHY. ``format=csv`` exports all matching rows (up to 10,000)."""
    svc = InventoryService(session, cache)
    if format == "csv":
        items, _total = await svc.list_items(
            PageParams(1, 10_000),
            warehouse_id=warehouse_id,
            product_id=product_id,
            category=category,
            status=status,
            search=search,
            sort=sort,
        )
        return maybe_csv(
            items,
            "inventory",
            [
                "sku",
                "product_name",
                "category",
                "warehouse_code",
                "quantity_on_hand",
                "reserved_quantity",
                "available_quantity",
                "safety_stock",
                "reorder_point",
                "unit_cost",
                "stock_value",
                "status",
            ],
        )
    items, total = await svc.list_items(
        page,
        warehouse_id=warehouse_id,
        product_id=product_id,
        category=category,
        status=status,
        search=search,
        sort=sort,
    )
    return Page.build([InventoryItemRead.model_validate(i) for i in items], total, page.page, page.page_size)


@router.get(
    "/transactions",
    response_model=Page[TransactionRead],
    summary="Inventory ledger (audit trail)",
    responses=ERROR_RESPONSES,
)
async def list_transactions(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    page: PageDep,
    product_id: Annotated[int | None, Query(gt=0)] = None,
    warehouse_id: Annotated[int | None, Query(gt=0)] = None,
    type: TransactionType | None = None,
    reference: Annotated[str | None, Query(max_length=120)] = None,
    sort: SortQuery = None,
) -> Page[TransactionRead]:
    items, total = await InventoryService(session, cache).list_transactions(
        page, product_id=product_id, warehouse_id=warehouse_id, type_=type, reference=reference, sort=sort
    )
    return Page.build([TransactionRead.model_validate(i) for i in items], total, page.page, page.page_size)


@router.get("/{item_id}", response_model=InventoryItemRead, responses={**ERROR_RESPONSES, **NOT_FOUND})
async def get_inventory_item(
    item_id: int, _: CurrentUser, session: SessionDep, cache: CacheDep
) -> InventoryItemRead:
    return InventoryItemRead.model_validate(await InventoryService(session, cache).get_item(item_id))


@router.patch(
    "/{item_id}",
    response_model=InventoryItemRead,
    summary="Set per-warehouse safety stock / reorder point",
    responses={**ERROR_RESPONSES, **NOT_FOUND},
)
async def update_inventory_item(
    item_id: int, body: InventoryItemUpdate, _: StockAdjust, session: SessionDep, cache: CacheDep
) -> InventoryItemRead:
    item = await InventoryService(session, cache).update_item_settings(
        item_id, body.safety_stock, body.reorder_point, body.model_fields_set
    )
    return InventoryItemRead.model_validate(item)


@router.post(
    "/receive", response_model=StockOperationResult, summary="Receive stock (non-PO)", responses=OP_RESPONSES
)
async def receive_stock(
    body: StockMovement,
    user: StockOps,
    session: SessionDep,
    cache: CacheDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Increase on-hand stock, e.g. for goods received without a purchase order.
    For PO deliveries use ``POST /purchase-orders/{id}/receive``."""
    svc = InventoryService(session, cache)
    return await run_idempotent(
        session,
        cache,
        user,
        idempotency_key,
        "inventory.receive",
        body,
        lambda: svc.receive(
            body.product_id,
            body.warehouse_id,
            body.quantity,
            reference=body.reference,
            note=body.note,
            actor_id=user.id,
        ),
    )


@router.post("/issue", response_model=StockOperationResult, summary="Issue stock", responses=OP_RESPONSES)
async def issue_stock(
    body: StockMovement,
    user: StockOps,
    session: SessionDep,
    cache: CacheDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Decrease on-hand stock (e.g. internal consumption). Only *available* stock
    (on hand − reserved) can be issued; otherwise 422 ``INSUFFICIENT_STOCK``."""
    svc = InventoryService(session, cache)
    return await run_idempotent(
        session,
        cache,
        user,
        idempotency_key,
        "inventory.issue",
        body,
        lambda: svc.issue(
            body.product_id,
            body.warehouse_id,
            body.quantity,
            reference=body.reference,
            note=body.note,
            actor_id=user.id,
        ),
    )


@router.post(
    "/return", response_model=StockOperationResult, summary="Customer return", responses=OP_RESPONSES
)
async def return_stock(
    body: StockMovement,
    user: StockOps,
    session: SessionDep,
    cache: CacheDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    svc = InventoryService(session, cache)
    return await run_idempotent(
        session,
        cache,
        user,
        idempotency_key,
        "inventory.return",
        body,
        lambda: svc.return_stock(
            body.product_id,
            body.warehouse_id,
            body.quantity,
            reference=body.reference,
            note=body.note,
            actor_id=user.id,
        ),
    )


@router.post(
    "/adjust",
    response_model=StockOperationResult,
    summary="Adjust stock (cycle count, damage…)",
    responses=OP_RESPONSES,
)
async def adjust_stock(
    body: StockAdjustment,
    user: StockAdjust,
    session: SessionDep,
    cache: CacheDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Signed correction of on-hand stock with a mandatory reason. A negative adjustment
    cannot take on-hand below the reserved quantity."""
    svc = InventoryService(session, cache)
    return await run_idempotent(
        session,
        cache,
        user,
        idempotency_key,
        "inventory.adjust",
        body,
        lambda: svc.adjust(
            body.product_id,
            body.warehouse_id,
            body.quantity_change,
            reference=body.reference,
            note=body.note,
            actor_id=user.id,
        ),
    )


@router.post(
    "/transfer",
    response_model=StockOperationResult,
    summary="Transfer stock between warehouses",
    responses=OP_RESPONSES,
)
async def transfer_stock(
    body: StockTransfer,
    user: StockOps,
    session: SessionDep,
    cache: CacheDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Atomic: the source decrease and destination increase commit in one DB transaction
    (linked by a shared ``transfer_group``) – both happen or neither does."""
    svc = InventoryService(session, cache)
    return await run_idempotent(
        session,
        cache,
        user,
        idempotency_key,
        "inventory.transfer",
        body,
        lambda: svc.transfer(
            body.product_id,
            body.from_warehouse_id,
            body.to_warehouse_id,
            body.quantity,
            reference=body.reference,
            note=body.note,
            actor_id=user.id,
        ),
    )


@router.post("/reserve", response_model=StockOperationResult, summary="Reserve stock", responses=OP_RESPONSES)
async def reserve_stock(
    body: StockMovement,
    user: StockOps,
    session: SessionDep,
    cache: CacheDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    """Move units from available to reserved (on hand unchanged)."""
    svc = InventoryService(session, cache)
    return await run_idempotent(
        session,
        cache,
        user,
        idempotency_key,
        "inventory.reserve",
        body,
        lambda: svc.reserve(
            body.product_id,
            body.warehouse_id,
            body.quantity,
            reference=body.reference,
            note=body.note,
            actor_id=user.id,
        ),
    )


@router.post(
    "/release", response_model=StockOperationResult, summary="Release a reservation", responses=OP_RESPONSES
)
async def release_stock(
    body: StockMovement,
    user: StockOps,
    session: SessionDep,
    cache: CacheDep,
    idempotency_key: IdempotencyKey = None,
) -> Any:
    svc = InventoryService(session, cache)
    return await run_idempotent(
        session,
        cache,
        user,
        idempotency_key,
        "inventory.release",
        body,
        lambda: svc.release(
            body.product_id,
            body.warehouse_id,
            body.quantity,
            reference=body.reference,
            note=body.note,
            actor_id=user.id,
        ),
    )
