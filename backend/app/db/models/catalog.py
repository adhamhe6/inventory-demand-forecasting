"""Master data: suppliers, warehouses, products."""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Index, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.database import Base, TimestampMixin
from app.db.models.enums import EntityStatus, str_enum


class Supplier(TimestampMixin, Base):
    __tablename__ = "suppliers"
    __table_args__ = (CheckConstraint("lead_time_days >= 0", name="lead_time_non_negative"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    contact_name: Mapped[str | None] = mapped_column(String(200))
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(50))
    address: Mapped[str | None] = mapped_column(Text)
    payment_terms: Mapped[str | None] = mapped_column(String(100))
    lead_time_days: Mapped[int] = mapped_column(Integer, nullable=False, default=7)
    status: Mapped[EntityStatus] = mapped_column(
        str_enum(EntityStatus, "supplier_status"), nullable=False, default=EntityStatus.ACTIVE
    )


class Warehouse(TimestampMixin, Base):
    __tablename__ = "warehouses"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    location: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[EntityStatus] = mapped_column(
        str_enum(EntityStatus, "warehouse_status"), nullable=False, default=EntityStatus.ACTIVE
    )


class Product(TimestampMixin, Base):
    __tablename__ = "products"
    __table_args__ = (
        CheckConstraint("cost >= 0", name="cost_non_negative"),
        CheckConstraint("price >= 0", name="price_non_negative"),
        CheckConstraint("min_stock >= 0", name="min_stock_non_negative"),
        CheckConstraint("reorder_point >= 0", name="reorder_point_non_negative"),
        CheckConstraint("safety_stock >= 0", name="safety_stock_non_negative"),
        CheckConstraint("lead_time_days >= 0", name="lead_time_non_negative"),
        Index("ix_products_category", "category"),
        Index("ix_products_supplier_id", "supplier_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    sku: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(100), nullable=False, default="General")
    unit: Mapped[str] = mapped_column(String(20), nullable=False, default="pcs")
    cost: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    min_stock: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reorder_point: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    safety_stock: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lead_time_days: Mapped[int] = mapped_column(Integer, nullable=False, default=7)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id", ondelete="SET NULL"))

    supplier: Mapped[Supplier | None] = relationship(lazy="raise")
