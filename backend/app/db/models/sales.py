from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.database import Base
from app.db.models.catalog import Product, Warehouse


class Sale(Base):
    """A historical/actual sales line. The forecasting pipeline consumes this table.

    ``(order_reference, product_id, warehouse_id)`` is unique so re-importing the same
    file (or retrying a request) cannot double-count demand.
    """

    __tablename__ = "sales"
    __table_args__ = (
        UniqueConstraint(
            "order_reference", "product_id", "warehouse_id", name="uq_sales_order_product_warehouse"
        ),
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("unit_price >= 0", name="unit_price_non_negative"),
        # Serves the forecasting aggregation (product, warehouse, time range) as an index-only-ish scan.
        Index("ix_sales_product_wh_sold_at", "product_id", "warehouse_id", "sold_at"),
        Index("ix_sales_sold_at", "sold_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="RESTRICT"), nullable=False)
    warehouse_id: Mapped[int] = mapped_column(
        ForeignKey("warehouses.id", ondelete="RESTRICT"), nullable=False
    )
    sold_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    order_reference: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    product: Mapped[Product] = relationship(lazy="raise")
    warehouse: Mapped[Warehouse] = relationship(lazy="raise")
