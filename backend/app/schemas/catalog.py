from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

from app.db.models.enums import EntityStatus
from app.schemas.common import ORMModel

_SKU_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$")
_CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{1,19}$")

Money = Decimal


def _strip(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    return v or None


# --------------------------------------------------------------------------- suppliers
class SupplierBase(BaseModel):
    contact_name: str | None = Field(default=None, max_length=200)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=50, pattern=r"^[0-9+()\-.\s]*$")
    address: str | None = Field(default=None, max_length=1000)
    payment_terms: str | None = Field(default=None, max_length=100, examples=["Net 30"])


class SupplierCreate(SupplierBase):
    name: str = Field(min_length=1, max_length=200, examples=["Acme Industrial Supply"])
    lead_time_days: int = Field(default=7, ge=0, le=365)
    status: EntityStatus = EntityStatus.ACTIVE


class SupplierUpdate(SupplierBase):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    lead_time_days: int | None = Field(default=None, ge=0, le=365)
    status: EntityStatus | None = None


class SupplierRead(ORMModel):
    id: int
    name: str
    contact_name: str | None
    email: str | None
    phone: str | None
    address: str | None
    payment_terms: str | None
    lead_time_days: int
    status: EntityStatus
    created_at: datetime
    updated_at: datetime


class SupplierStats(BaseModel):
    total_purchase_orders: int
    open_purchase_orders: int
    total_spend: float
    on_time_rate: float | None = Field(description="Share of received POs delivered on/before expected date")
    avg_actual_lead_time_days: float | None
    product_count: int


class SupplierDetail(SupplierRead):
    stats: SupplierStats


# --------------------------------------------------------------------------- warehouses
class WarehouseCreate(BaseModel):
    code: str = Field(min_length=2, max_length=20, examples=["WH-EAST"])
    name: str = Field(min_length=1, max_length=200)
    location: str | None = Field(default=None, max_length=255)
    status: EntityStatus = EntityStatus.ACTIVE

    @field_validator("code")
    @classmethod
    def _code(cls, v: str) -> str:
        v = v.strip().upper()
        if not _CODE_RE.match(v):
            raise ValueError("Code must be 2-20 chars: A-Z, 0-9, '-' or '_'")
        return v


class WarehouseUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    location: str | None = Field(default=None, max_length=255)
    status: EntityStatus | None = None


class WarehouseRead(ORMModel):
    id: int
    code: str
    name: str
    location: str | None
    status: EntityStatus
    created_at: datetime
    updated_at: datetime


class WarehouseSummary(WarehouseRead):
    product_count: int
    total_units: int
    reserved_units: int
    inventory_value: float
    low_stock_items: int


# --------------------------------------------------------------------------- products
class ProductBase(BaseModel):
    description: str | None = Field(default=None, max_length=5000)
    category: str = Field(default="General", min_length=1, max_length=100)
    unit: str = Field(default="pcs", min_length=1, max_length=20)
    min_stock: int = Field(default=0, ge=0)
    reorder_point: int = Field(default=0, ge=0, description="Static reorder point (units)")
    safety_stock: int = Field(default=0, ge=0, description="Safety stock (units)")
    lead_time_days: int = Field(default=7, ge=0, le=365, description="Fallback when no supplier lead time")
    is_active: bool = True
    supplier_id: int | None = Field(default=None, description="Preferred supplier")


class ProductCreate(ProductBase):
    sku: str = Field(min_length=2, max_length=64, examples=["ELEC-USB-C-01"])
    name: str = Field(min_length=1, max_length=200, examples=["USB-C Cable 1m"])
    cost: Decimal = Field(ge=0, max_digits=12, decimal_places=2, examples=["3.20"])
    price: Decimal = Field(ge=0, max_digits=12, decimal_places=2, examples=["9.99"])

    @field_validator("sku")
    @classmethod
    def _sku(cls, v: str) -> str:
        v = v.strip().upper()
        if not _SKU_RE.match(v):
            raise ValueError("SKU may contain letters, digits, '.', '_' and '-' only")
        return v


class ProductUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    category: str | None = Field(default=None, min_length=1, max_length=100)
    unit: str | None = Field(default=None, min_length=1, max_length=20)
    cost: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    price: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    min_stock: int | None = Field(default=None, ge=0)
    reorder_point: int | None = Field(default=None, ge=0)
    safety_stock: int | None = Field(default=None, ge=0)
    lead_time_days: int | None = Field(default=None, ge=0, le=365)
    is_active: bool | None = None
    supplier_id: int | None = None

    @model_validator(mode="after")
    def _not_empty(self) -> ProductUpdate:
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided")
        return self


class SupplierRef(ORMModel):
    id: int
    name: str
    lead_time_days: int


class ProductRead(ORMModel):
    id: int
    sku: str
    name: str
    description: str | None
    category: str
    unit: str
    cost: Decimal
    price: Decimal
    min_stock: int
    reorder_point: int
    safety_stock: int
    lead_time_days: int
    is_active: bool
    supplier_id: int | None
    supplier: SupplierRef | None = None
    created_at: datetime
    updated_at: datetime


class ProductStockByWarehouse(BaseModel):
    warehouse_id: int
    warehouse_code: str
    warehouse_name: str
    quantity_on_hand: int
    reserved_quantity: int
    available_quantity: int


class ProductDetail(ProductRead):
    stock: list[ProductStockByWarehouse]
    total_on_hand: int
    total_available: int
