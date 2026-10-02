"""Purchase orders, their lines and receiving history."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Sequence,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.database import Base, TimestampMixin
from app.db.models.catalog import Product, Supplier, Warehouse
from app.db.models.enums import PurchaseOrderStatus, str_enum

# Human-friendly PO numbers (PO-YYYY-001001). Created in migration 0001.
PO_NUMBER_SEQ = Sequence("purchase_order_number_seq", start=1001, metadata=Base.metadata)


class PurchaseOrder(TimestampMixin, Base):
    __tablename__ = "purchase_orders"
    __table_args__ = (
        CheckConstraint(
            "expected_delivery_date IS NULL OR expected_delivery_date >= order_date",
            name="expected_after_order",
        ),
        Index("ix_purchase_orders_supplier_id", "supplier_id"),
        Index("ix_purchase_orders_status", "status"),
        Index("ix_purchase_orders_warehouse_id", "warehouse_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    po_number: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id", ondelete="RESTRICT"), nullable=False)
    warehouse_id: Mapped[int] = mapped_column(
        ForeignKey("warehouses.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[PurchaseOrderStatus] = mapped_column(
        str_enum(PurchaseOrderStatus, "purchase_order_status"),
        nullable=False,
        default=PurchaseOrderStatus.DRAFT,
    )
    order_date: Mapped[date] = mapped_column(Date, nullable=False, server_default=func.current_date())
    expected_delivery_date: Mapped[date | None] = mapped_column(Date)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    received_date: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    supplier: Mapped[Supplier] = relationship(lazy="raise")
    warehouse: Mapped[Warehouse] = relationship(lazy="raise")
    lines: Mapped[list[PurchaseOrderLine]] = relationship(
        back_populates="purchase_order",
        lazy="raise",
        cascade="all, delete-orphan",
        order_by="PurchaseOrderLine.id",
    )
    receipts: Mapped[list[PurchaseOrderReceipt]] = relationship(
        back_populates="purchase_order", lazy="raise", order_by="PurchaseOrderReceipt.id"
    )


class PurchaseOrderLine(Base):
    __tablename__ = "purchase_order_lines"
    __table_args__ = (
        UniqueConstraint("purchase_order_id", "product_id", name="uq_po_lines_po_product"),
        CheckConstraint("quantity_ordered > 0", name="quantity_ordered_positive"),
        CheckConstraint("quantity_received >= 0", name="quantity_received_non_negative"),
        CheckConstraint("quantity_received <= quantity_ordered", name="received_within_ordered"),
        CheckConstraint("unit_cost >= 0", name="unit_cost_non_negative"),
        Index("ix_purchase_order_lines_product_id", "product_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    purchase_order_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_orders.id", ondelete="CASCADE"), nullable=False
    )
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="RESTRICT"), nullable=False)
    quantity_ordered: Mapped[int] = mapped_column(Integer, nullable=False)
    quantity_received: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unit_cost: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    purchase_order: Mapped[PurchaseOrder] = relationship(back_populates="lines", lazy="raise")
    product: Mapped[Product] = relationship(lazy="raise")


class PurchaseOrderReceipt(Base):
    """One receiving event (a delivery). ``receipt_key`` makes receiving idempotent."""

    __tablename__ = "purchase_order_receipts"
    __table_args__ = (UniqueConstraint("purchase_order_id", "receipt_key", name="uq_po_receipts_po_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    purchase_order_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_orders.id", ondelete="CASCADE"), nullable=False
    )
    receipt_key: Mapped[str] = mapped_column(String(100), nullable=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    received_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    notes: Mapped[str | None] = mapped_column(Text)

    purchase_order: Mapped[PurchaseOrder] = relationship(back_populates="receipts", lazy="raise")
    lines: Mapped[list[PurchaseOrderReceiptLine]] = relationship(
        lazy="raise", cascade="all, delete-orphan", order_by="PurchaseOrderReceiptLine.id"
    )


class PurchaseOrderReceiptLine(Base):
    __tablename__ = "purchase_order_receipt_lines"
    __table_args__ = (CheckConstraint("quantity > 0", name="quantity_positive"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    receipt_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_order_receipts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    purchase_order_line_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_order_lines.id", ondelete="CASCADE"), nullable=False
    )
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="RESTRICT"), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
