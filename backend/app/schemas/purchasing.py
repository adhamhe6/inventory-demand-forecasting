from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.db.models.enums import PurchaseOrderStatus
from app.schemas.common import ORMModel


class POLineCreate(BaseModel):
    product_id: int = Field(gt=0)
    quantity_ordered: int = Field(gt=0, le=1_000_000)
    unit_cost: Decimal | None = Field(
        default=None, ge=0, max_digits=12, decimal_places=2, description="Defaults to the product cost"
    )


class PurchaseOrderCreate(BaseModel):
    supplier_id: int = Field(gt=0)
    warehouse_id: int = Field(gt=0)
    expected_delivery_date: date | None = Field(
        default=None, description="Defaults to today + supplier lead time"
    )
    notes: str | None = Field(default=None, max_length=2000)
    lines: list[POLineCreate] = Field(min_length=1, max_length=200)

    @field_validator("lines")
    @classmethod
    def _unique_products(cls, lines: list[POLineCreate]) -> list[POLineCreate]:
        ids = [line.product_id for line in lines]
        if len(ids) != len(set(ids)):
            raise ValueError("Each product may appear only once per purchase order")
        return lines


class PurchaseOrderUpdate(BaseModel):
    """Only DRAFT orders can be edited. Supplying ``lines`` replaces all lines."""

    expected_delivery_date: date | None = None
    notes: str | None = Field(default=None, max_length=2000)
    lines: list[POLineCreate] | None = Field(default=None, min_length=1, max_length=200)

    @field_validator("lines")
    @classmethod
    def _unique_products(cls, lines: list[POLineCreate] | None) -> list[POLineCreate] | None:
        if lines is not None:
            ids = [line.product_id for line in lines]
            if len(ids) != len(set(ids)):
                raise ValueError("Each product may appear only once per purchase order")
        return lines


class POStatusChange(BaseModel):
    status: PurchaseOrderStatus = Field(
        description="Target status. Allowed: SUBMITTED, CONFIRMED, CANCELLED (receiving uses /receive)"
    )
    note: str | None = Field(default=None, max_length=1000)


class ReceiveLine(BaseModel):
    line_id: int = Field(gt=0, description="Purchase order line id")
    quantity: int = Field(gt=0, le=1_000_000)


class ReceivePurchaseOrder(BaseModel):
    lines: list[ReceiveLine] | None = Field(
        default=None, description="Lines to receive. Omit to receive all outstanding quantities."
    )
    receipt_reference: str | None = Field(
        default=None,
        max_length=100,
        description="Delivery note / GRN number. Used as idempotency key: re-sending the same "
        "reference returns the original receipt instead of receiving twice.",
    )
    notes: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def _unique(self) -> ReceivePurchaseOrder:
        if self.lines is not None:
            ids = [line.line_id for line in self.lines]
            if len(ids) != len(set(ids)):
                raise ValueError("Each line may appear only once per receipt")
            if not ids:
                raise ValueError("lines must not be empty when provided")
        return self


class POLineRead(ORMModel):
    id: int
    product_id: int
    sku: str
    product_name: str
    quantity_ordered: int
    quantity_received: int
    quantity_outstanding: int
    unit_cost: Decimal
    line_total: Decimal


class ReceiptLineRead(BaseModel):
    purchase_order_line_id: int
    product_id: int
    sku: str
    quantity: int


class ReceiptRead(BaseModel):
    id: int
    receipt_key: str
    received_at: datetime
    received_by_id: int | None
    notes: str | None
    lines: list[ReceiptLineRead]


class PurchaseOrderSummary(BaseModel):
    id: int
    po_number: str
    supplier_id: int
    supplier_name: str
    warehouse_id: int
    warehouse_code: str
    status: PurchaseOrderStatus
    order_date: date
    expected_delivery_date: date | None
    received_date: date | None
    total_amount: Decimal
    total_units: int
    received_units: int
    line_count: int
    created_at: datetime


class PurchaseOrderRead(PurchaseOrderSummary):
    notes: str | None
    submitted_at: datetime | None
    lines: list[POLineRead]
    receipts: list[ReceiptRead]
    allowed_transitions: list[PurchaseOrderStatus]


class ReceiveResult(BaseModel):
    purchase_order: PurchaseOrderRead
    receipt: ReceiptRead
    replayed: bool = Field(description="True when this receipt_reference was already processed")
