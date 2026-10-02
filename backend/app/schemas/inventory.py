from __future__ import annotations

import enum
import uuid
from datetime import datetime

from pydantic import BaseModel, Field, model_validator

from app.db.models.enums import TransactionType
from app.schemas.common import ORMModel


class StockStatus(enum.StrEnum):
    HEALTHY = "HEALTHY"
    LOW_STOCK = "LOW_STOCK"
    CRITICAL = "CRITICAL"
    OUT_OF_STOCK = "OUT_OF_STOCK"


class InventoryItemRead(BaseModel):
    id: int
    product_id: int
    sku: str
    product_name: str
    category: str
    unit: str
    warehouse_id: int
    warehouse_code: str
    warehouse_name: str
    quantity_on_hand: int
    reserved_quantity: int
    available_quantity: int
    safety_stock: int = Field(description="Effective safety stock (warehouse override or product default)")
    reorder_point: int = Field(description="Effective reorder point (warehouse override or product default)")
    unit_cost: float
    stock_value: float
    status: StockStatus
    updated_at: datetime


class InventoryItemUpdate(BaseModel):
    """Per-warehouse planning overrides. ``null`` resets to the product default."""

    safety_stock: int | None = Field(default=None, ge=0)
    reorder_point: int | None = Field(default=None, ge=0)


class _StockOpBase(BaseModel):
    product_id: int = Field(gt=0)
    reference: str | None = Field(default=None, max_length=120, examples=["DOC-2024-001"])
    note: str | None = Field(default=None, max_length=1000)


class StockMovement(_StockOpBase):
    warehouse_id: int = Field(gt=0)
    quantity: int = Field(gt=0, le=1_000_000, description="Positive number of units")


class StockAdjustment(_StockOpBase):
    warehouse_id: int = Field(gt=0)
    quantity_change: int = Field(
        description="Signed change to on-hand quantity (e.g. -3 for damaged goods, +5 for found stock)"
    )
    note: str = Field(min_length=3, max_length=1000, description="Reason for the adjustment (required)")

    @model_validator(mode="after")
    def _non_zero(self) -> StockAdjustment:
        if self.quantity_change == 0:
            raise ValueError("quantity_change must not be zero")
        if abs(self.quantity_change) > 1_000_000:
            raise ValueError("quantity_change is out of range")
        return self


class StockTransfer(_StockOpBase):
    from_warehouse_id: int = Field(gt=0)
    to_warehouse_id: int = Field(gt=0)
    quantity: int = Field(gt=0, le=1_000_000)

    @model_validator(mode="after")
    def _different(self) -> StockTransfer:
        if self.from_warehouse_id == self.to_warehouse_id:
            raise ValueError("Source and destination warehouses must differ")
        return self


class TransactionRead(ORMModel):
    id: int
    product_id: int
    warehouse_id: int
    sku: str | None = None
    product_name: str | None = None
    warehouse_code: str | None = None
    type: TransactionType
    quantity: int
    on_hand_delta: int
    reserved_delta: int
    on_hand_after: int
    reserved_after: int
    reference: str | None
    note: str | None
    transfer_group: uuid.UUID | None
    actor_id: int | None
    actor_name: str | None = None
    created_at: datetime


class StockOperationResult(BaseModel):
    items: list[InventoryItemRead]
    transactions: list[TransactionRead]
