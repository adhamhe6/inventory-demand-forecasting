from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import ORMModel


class SaleCreate(BaseModel):
    product_id: int = Field(gt=0)
    warehouse_id: int = Field(gt=0)
    quantity: int = Field(gt=0, le=1_000_000)
    unit_price: Decimal | None = Field(
        default=None, ge=0, max_digits=12, decimal_places=2, description="Defaults to product price"
    )
    order_reference: str = Field(min_length=1, max_length=100, examples=["SO-100045"])
    sold_at: datetime | None = Field(default=None, description="Defaults to now")
    issue_stock: bool = Field(
        default=True,
        description="Deduct the sold quantity from warehouse stock (records a SALE transaction). "
        "Set false to record historical/back-dated sales that are already reflected in stock.",
    )

    @field_validator("sold_at")
    @classmethod
    def _not_future(cls, v: datetime | None) -> datetime | None:
        if v is None:
            return v
        if v.tzinfo is None:
            v = v.replace(tzinfo=UTC)
        if v > datetime.now(UTC) + timedelta(minutes=5):
            raise ValueError("sold_at cannot be in the future")
        return v


class SaleRead(ORMModel):
    id: int
    product_id: int
    sku: str
    product_name: str
    warehouse_id: int
    warehouse_code: str
    sold_at: datetime
    quantity: int
    unit_price: Decimal
    revenue: Decimal
    order_reference: str
    created_at: datetime
