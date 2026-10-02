from __future__ import annotations

from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Response, status

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
from app.core.security import Permission
from app.db.models import PurchaseOrderStatus, User
from app.schemas.common import CONFLICT, ERROR_RESPONSES, NOT_FOUND, Page
from app.schemas.purchasing import (
    POStatusChange,
    PurchaseOrderCreate,
    PurchaseOrderRead,
    PurchaseOrderSummary,
    PurchaseOrderUpdate,
    ReceivePurchaseOrder,
    ReceiveResult,
)
from app.services.common import PageParams
from app.services.purchasing import PurchasingService

router = APIRouter(prefix="/purchase-orders", tags=["Purchase Orders"])
ManagePO = Annotated[User, Depends(require(Permission.MANAGE_PURCHASE_ORDERS))]
ReceivePO = Annotated[User, Depends(require(Permission.RECEIVE_PURCHASE_ORDERS))]


@router.get(
    "", response_model=Page[PurchaseOrderSummary], summary="List purchase orders", responses=ERROR_RESPONSES
)
async def list_purchase_orders(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    page: PageDep,
    status_: Annotated[
        list[PurchaseOrderStatus] | None, Query(alias="status", description="Repeatable")
    ] = None,
    supplier_id: Annotated[int | None, Query(gt=0)] = None,
    warehouse_id: Annotated[int | None, Query(gt=0)] = None,
    product_id: Annotated[int | None, Query(gt=0)] = None,
    date_from: date | None = None,
    date_to: date | None = None,
    search: SearchQuery = None,
    sort: SortQuery = None,
    format: Annotated[str, Query(pattern="^(json|csv)$")] = "json",
) -> Any:
    svc = PurchasingService(session, cache)
    kwargs = dict(
        statuses=status_,
        supplier_id=supplier_id,
        warehouse_id=warehouse_id,
        product_id=product_id,
        date_from=date_from,
        date_to=date_to,
        search=search,
        sort=sort,
    )
    if format == "csv":
        items, _t = await svc.list(PageParams(1, 10_000), **kwargs)  # type: ignore[arg-type]
        return maybe_csv(
            items,
            "purchase-orders",
            [
                "po_number",
                "supplier_name",
                "warehouse_code",
                "status",
                "order_date",
                "expected_delivery_date",
                "received_date",
                "total_units",
                "received_units",
                "total_amount",
            ],
        )
    items, total = await svc.list(page, **kwargs)  # type: ignore[arg-type]
    return Page.build(
        [PurchaseOrderSummary.model_validate(i) for i in items], total, page.page, page.page_size
    )


@router.post(
    "",
    response_model=PurchaseOrderRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a DRAFT purchase order",
    responses={**ERROR_RESPONSES},
)
async def create_purchase_order(
    body: PurchaseOrderCreate, user: ManagePO, session: SessionDep, cache: CacheDep
) -> PurchaseOrderRead:
    """Line unit cost defaults to the product cost; expected delivery defaults to today +
    supplier lead time."""
    return PurchaseOrderRead.model_validate(await PurchasingService(session, cache).create(body, user.id))


@router.get("/{po_id}", response_model=PurchaseOrderRead, responses={**ERROR_RESPONSES, **NOT_FOUND})
async def get_purchase_order(
    po_id: int, _: CurrentUser, session: SessionDep, cache: CacheDep
) -> PurchaseOrderRead:
    """Includes lines, receiving history and the statuses it may transition to."""
    return PurchaseOrderRead.model_validate(await PurchasingService(session, cache).get(po_id))


@router.patch(
    "/{po_id}",
    response_model=PurchaseOrderRead,
    summary="Edit a DRAFT purchase order",
    responses={**ERROR_RESPONSES, **NOT_FOUND, **CONFLICT},
)
async def update_purchase_order(
    po_id: int, body: PurchaseOrderUpdate, _: ManagePO, session: SessionDep, cache: CacheDep
) -> PurchaseOrderRead:
    return PurchaseOrderRead.model_validate(await PurchasingService(session, cache).update(po_id, body))


@router.delete(
    "/{po_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a DRAFT purchase order",
    responses={**ERROR_RESPONSES, **NOT_FOUND, **CONFLICT},
)
async def delete_purchase_order(po_id: int, _: ManagePO, session: SessionDep, cache: CacheDep) -> Response:
    await PurchasingService(session, cache).delete_draft(po_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{po_id}/status",
    response_model=PurchaseOrderRead,
    summary="Change status (submit / confirm / cancel)",
    responses={**ERROR_RESPONSES, **NOT_FOUND, **CONFLICT},
)
async def change_purchase_order_status(
    po_id: int, body: POStatusChange, user: ManagePO, session: SessionDep, cache: CacheDep
) -> PurchaseOrderRead:
    """Allowed manual transitions: DRAFT→SUBMITTED|CANCELLED, SUBMITTED→CONFIRMED|CANCELLED,
    CONFIRMED→CANCELLED. Invalid transitions return 409 ``INVALID_STATE_TRANSITION``."""
    return PurchaseOrderRead.model_validate(
        await PurchasingService(session, cache).change_status(po_id, body.status, user.id)
    )


@router.post(
    "/{po_id}/receive",
    response_model=ReceiveResult,
    summary="Receive goods (full or partial)",
    responses={**ERROR_RESPONSES, **NOT_FOUND, **CONFLICT},
)
async def receive_purchase_order(
    po_id: int,
    body: ReceivePurchaseOrder,
    user: ReceivePO,
    session: SessionDep,
    cache: CacheDep,
    idempotency_key: IdempotencyKey = None,
) -> ReceiveResult:
    """Increases warehouse stock, writes PURCHASE_RECEIPT ledger entries, updates received
    quantities and moves the PO to PARTIALLY_RECEIVED/RECEIVED – all in one transaction.

    **Idempotent**: provide ``receipt_reference`` (or an ``Idempotency-Key`` header). Re-sending
    the same reference returns the original receipt with ``replayed=true`` and does not add
    stock again. Over-receiving returns 422 ``OVER_RECEIPT``."""
    po, receipt, replayed = await PurchasingService(session, cache).receive(
        po_id,
        body.lines,
        receipt_key=body.receipt_reference or idempotency_key,
        notes=body.notes,
        actor_id=user.id,
    )
    return ReceiveResult(
        purchase_order=PurchaseOrderRead.model_validate(po), receipt=receipt, replayed=replayed
    )  # type: ignore[arg-type]
