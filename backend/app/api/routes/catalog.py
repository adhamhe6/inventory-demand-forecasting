"""Products, warehouses and suppliers."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from app.api.dependencies import CacheDep, CurrentUser, PageDep, SearchQuery, SessionDep, SortQuery, require
from app.cache.redis_cache import CacheDomain
from app.core.security import Permission
from app.db.models import EntityStatus, User
from app.schemas.catalog import (
    ProductCreate,
    ProductDetail,
    ProductRead,
    ProductUpdate,
    SupplierCreate,
    SupplierDetail,
    SupplierRead,
    SupplierStats,
    SupplierUpdate,
    WarehouseCreate,
    WarehouseRead,
    WarehouseSummary,
    WarehouseUpdate,
)
from app.schemas.common import CONFLICT, ERROR_RESPONSES, NOT_FOUND, Page
from app.services.catalog import CatalogService
from app.services.common import PageParams
from app.services.inventory import InventoryService

products = APIRouter(prefix="/products", tags=["Products"])
warehouses = APIRouter(prefix="/warehouses", tags=["Warehouses"])
suppliers = APIRouter(prefix="/suppliers", tags=["Suppliers"])

ManageProducts = Annotated[User, Depends(require(Permission.MANAGE_PRODUCTS))]
DeleteProducts = Annotated[User, Depends(require(Permission.DELETE_PRODUCTS))]
ManageWarehouses = Annotated[User, Depends(require(Permission.MANAGE_WAREHOUSES))]
ManageSuppliers = Annotated[User, Depends(require(Permission.MANAGE_SUPPLIERS))]


# --------------------------------------------------------------------------- products
@products.get("", response_model=Page[ProductRead], summary="List products", responses=ERROR_RESPONSES)
async def list_products(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    page: PageDep,
    search: SearchQuery = None,
    category: Annotated[str | None, Query(max_length=100)] = None,
    supplier_id: Annotated[int | None, Query(gt=0)] = None,
    is_active: bool | None = None,
    sort: SortQuery = None,
) -> Page[ProductRead]:
    """Filter by text (SKU/name/category), category, supplier and status. Sortable by
    sku, name, category, price, cost, created_at."""
    items, total = await CatalogService(session, cache).list_products(
        page, search=search, category=category, supplier_id=supplier_id, is_active=is_active, sort=sort
    )
    return Page.build([ProductRead.model_validate(p) for p in items], total, page.page, page.page_size)


@products.get("/categories", response_model=list[str], summary="Distinct product categories")
async def list_categories(_: CurrentUser, session: SessionDep, cache: CacheDep) -> list[str]:
    return await CatalogService(session, cache).list_categories()


@products.post(
    "",
    response_model=ProductRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create product",
    responses={**ERROR_RESPONSES, **CONFLICT},
)
async def create_product(
    body: ProductCreate, _: ManageProducts, session: SessionDep, cache: CacheDep
) -> ProductRead:
    """SKUs are normalised to upper case and must be unique (409 on duplicates)."""
    return ProductRead.model_validate(await CatalogService(session, cache).create_product(body))


@products.get(
    "/{product_id}",
    response_model=ProductDetail,
    summary="Product with stock per warehouse",
    responses={**ERROR_RESPONSES, **NOT_FOUND},
)
async def get_product(product_id: int, _: CurrentUser, session: SessionDep, cache: CacheDep) -> ProductDetail:
    product = await CatalogService(session, cache).get_product(product_id)
    items, _total = await InventoryService(session, cache).list_items(
        PageParams(1, 200), product_id=product_id, sort="warehouse_code"
    )
    stock = [
        {
            "warehouse_id": i["warehouse_id"],
            "warehouse_code": i["warehouse_code"],
            "warehouse_name": i["warehouse_name"],
            "quantity_on_hand": i["quantity_on_hand"],
            "reserved_quantity": i["reserved_quantity"],
            "available_quantity": i["available_quantity"],
        }
        for i in items
    ]
    return ProductDetail(
        **ProductRead.model_validate(product).model_dump(),
        stock=stock,  # type: ignore[arg-type]
        total_on_hand=sum(s["quantity_on_hand"] for s in stock),
        total_available=sum(s["available_quantity"] for s in stock),
    )


@products.patch(
    "/{product_id}",
    response_model=ProductRead,
    summary="Update product",
    responses={**ERROR_RESPONSES, **NOT_FOUND},
)
async def update_product(
    product_id: int, body: ProductUpdate, _: ManageProducts, session: SessionDep, cache: CacheDep
) -> ProductRead:
    return ProductRead.model_validate(await CatalogService(session, cache).update_product(product_id, body))


@products.delete(
    "/{product_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete product",
    responses={**ERROR_RESPONSES, **NOT_FOUND, **CONFLICT},
)
async def delete_product(
    product_id: int, _: DeleteProducts, session: SessionDep, cache: CacheDep
) -> Response:
    """Only products without stock, sales or purchase history can be deleted (409
    ``PRODUCT_IN_USE`` otherwise – deactivate them instead, which preserves history)."""
    await CatalogService(session, cache).delete_product(product_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------- warehouses
@warehouses.get("", response_model=Page[WarehouseRead], summary="List warehouses", responses=ERROR_RESPONSES)
async def list_warehouses(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    page: PageDep,
    search: SearchQuery = None,
    status_: Annotated[EntityStatus | None, Query(alias="status")] = None,
    sort: SortQuery = None,
) -> Page[WarehouseRead]:
    items, total = await CatalogService(session, cache).list_warehouses(
        page, search=search, status=status_, sort=sort
    )
    return Page.build([WarehouseRead.model_validate(w) for w in items], total, page.page, page.page_size)


@warehouses.get("/summary", response_model=list[WarehouseSummary], summary="Stock summary per warehouse")
async def warehouse_summary(_: CurrentUser, session: SessionDep, cache: CacheDep) -> list[WarehouseSummary]:
    rows = await cache.get_or_set(
        "warehouses:summary",
        [CacheDomain.INVENTORY, CacheDomain.CATALOG],
        lambda: CatalogService(session, cache).warehouse_summaries(),
    )
    return [WarehouseSummary.model_validate(r) for r in rows]


@warehouses.post(
    "",
    response_model=WarehouseRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create warehouse",
    responses={**ERROR_RESPONSES, **CONFLICT},
)
async def create_warehouse(
    body: WarehouseCreate, _: ManageWarehouses, session: SessionDep, cache: CacheDep
) -> WarehouseRead:
    return WarehouseRead.model_validate(await CatalogService(session, cache).create_warehouse(body))


@warehouses.get("/{warehouse_id}", response_model=WarehouseRead, responses={**ERROR_RESPONSES, **NOT_FOUND})
async def get_warehouse(
    warehouse_id: int, _: CurrentUser, session: SessionDep, cache: CacheDep
) -> WarehouseRead:
    return WarehouseRead.model_validate(await CatalogService(session, cache).get_warehouse(warehouse_id))


@warehouses.patch(
    "/{warehouse_id}",
    response_model=WarehouseRead,
    summary="Update warehouse",
    responses={**ERROR_RESPONSES, **NOT_FOUND},
)
async def update_warehouse(
    warehouse_id: int, body: WarehouseUpdate, _: ManageWarehouses, session: SessionDep, cache: CacheDep
) -> WarehouseRead:
    return WarehouseRead.model_validate(
        await CatalogService(session, cache).update_warehouse(warehouse_id, body)
    )


# --------------------------------------------------------------------------- suppliers
@suppliers.get("", response_model=Page[SupplierRead], summary="List suppliers", responses=ERROR_RESPONSES)
async def list_suppliers(
    _: CurrentUser,
    session: SessionDep,
    cache: CacheDep,
    page: PageDep,
    search: SearchQuery = None,
    status_: Annotated[EntityStatus | None, Query(alias="status")] = None,
    sort: SortQuery = None,
) -> Page[SupplierRead]:
    items, total = await CatalogService(session, cache).list_suppliers(
        page, search=search, status=status_, sort=sort
    )
    return Page.build([SupplierRead.model_validate(s) for s in items], total, page.page, page.page_size)


@suppliers.post(
    "",
    response_model=SupplierRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create supplier",
    responses={**ERROR_RESPONSES, **CONFLICT},
)
async def create_supplier(
    body: SupplierCreate, _: ManageSuppliers, session: SessionDep, cache: CacheDep
) -> SupplierRead:
    return SupplierRead.model_validate(await CatalogService(session, cache).create_supplier(body))


@suppliers.get(
    "/{supplier_id}",
    response_model=SupplierDetail,
    summary="Supplier with performance statistics",
    responses={**ERROR_RESPONSES, **NOT_FOUND},
)
async def get_supplier(
    supplier_id: int, _: CurrentUser, session: SessionDep, cache: CacheDep
) -> SupplierDetail:
    svc = CatalogService(session, cache)
    supplier = await svc.get_supplier(supplier_id)
    stats = await svc.supplier_stats(supplier_id)
    return SupplierDetail(**SupplierRead.model_validate(supplier).model_dump(), stats=SupplierStats(**stats))


@suppliers.patch(
    "/{supplier_id}",
    response_model=SupplierRead,
    summary="Update supplier",
    responses={**ERROR_RESPONSES, **NOT_FOUND, **CONFLICT},
)
async def update_supplier(
    supplier_id: int, body: SupplierUpdate, _: ManageSuppliers, session: SessionDep, cache: CacheDep
) -> SupplierRead:
    return SupplierRead.model_validate(
        await CatalogService(session, cache).update_supplier(supplier_id, body)
    )
