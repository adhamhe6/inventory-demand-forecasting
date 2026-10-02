"""Warehouse-level stock and the append-only inventory ledger."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    Computed,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.database import Base
from app.db.models.catalog import Product, Warehouse
from app.db.models.enums import TransactionType, str_enum


class InventoryItem(Base):
    """Stock of one product in one warehouse.

    ``available_quantity`` is a stored generated column, so it can never drift from
    ``quantity_on_hand - reserved_quantity``. CHECK constraints make negative stock and
    over-reservation impossible even if application code had a bug.
    """

    __tablename__ = "inventory_items"
    __table_args__ = (
        UniqueConstraint("product_id", "warehouse_id", name="uq_inventory_items_product_warehouse"),
        CheckConstraint("quantity_on_hand >= 0", name="on_hand_non_negative"),
        CheckConstraint("reserved_quantity >= 0", name="reserved_non_negative"),
        CheckConstraint("reserved_quantity <= quantity_on_hand", name="reserved_within_on_hand"),
        CheckConstraint("safety_stock IS NULL OR safety_stock >= 0", name="safety_stock_non_negative"),
        CheckConstraint("reorder_point IS NULL OR reorder_point >= 0", name="reorder_point_non_negative"),
        Index("ix_inventory_items_warehouse_id", "warehouse_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="RESTRICT"), nullable=False)
    warehouse_id: Mapped[int] = mapped_column(
        ForeignKey("warehouses.id", ondelete="RESTRICT"), nullable=False
    )
    quantity_on_hand: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reserved_quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    available_quantity: Mapped[int] = mapped_column(
        Integer, Computed("quantity_on_hand - reserved_quantity", persisted=True)
    )
    # Optional per-warehouse overrides; fall back to the product-level values when NULL.
    safety_stock: Mapped[int | None] = mapped_column(Integer)
    reorder_point: Mapped[int | None] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    product: Mapped[Product] = relationship(lazy="raise")
    warehouse: Mapped[Warehouse] = relationship(lazy="raise")


class InventoryTransaction(Base):
    """Immutable ledger entry. Every stock change writes exactly one row per affected item."""

    __tablename__ = "inventory_transactions"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        Index("ix_inventory_transactions_product_wh_created", "product_id", "warehouse_id", "created_at"),
        Index("ix_inventory_transactions_created_at", "created_at"),
        Index("ix_inventory_transactions_transfer_group", "transfer_group"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="RESTRICT"), nullable=False)
    warehouse_id: Mapped[int] = mapped_column(
        ForeignKey("warehouses.id", ondelete="RESTRICT"), nullable=False
    )
    type: Mapped[TransactionType] = mapped_column(
        str_enum(TransactionType, "transaction_type"), nullable=False
    )
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    on_hand_delta: Mapped[int] = mapped_column(Integer, nullable=False)
    reserved_delta: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    on_hand_after: Mapped[int] = mapped_column(Integer, nullable=False)
    reserved_after: Mapped[int] = mapped_column(Integer, nullable=False)
    reference: Mapped[str | None] = mapped_column(String(120))
    note: Mapped[str | None] = mapped_column(Text)
    transfer_group: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    product: Mapped[Product] = relationship(lazy="raise")
    warehouse: Mapped[Warehouse] = relationship(lazy="raise")
