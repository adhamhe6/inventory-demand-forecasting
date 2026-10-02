from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import CheckConstraint, Date, DateTime, Float, ForeignKey, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.database import Base
from app.db.models.catalog import Product, Warehouse


class ForecastRun(Base):
    """A stored forecast for one (product, warehouse) produced by one model run."""

    __tablename__ = "forecast_runs"
    __table_args__ = (
        CheckConstraint("horizon_days > 0", name="horizon_positive"),
        # "Latest forecast per item" lookups.
        Index("ix_forecast_runs_item_generated", "product_id", "warehouse_id", "generated_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id", ondelete="CASCADE"), nullable=False)
    horizon_days: Mapped[int] = mapped_column(Integer, nullable=False)
    model_name: Mapped[str] = mapped_column(String(50), nullable=False)
    model_version: Mapped[str] = mapped_column(String(20), nullable=False)
    generated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    history_start: Mapped[date | None] = mapped_column(Date)
    history_end: Mapped[date | None] = mapped_column(Date)
    history_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_predicted: Mapped[float] = mapped_column(Float, nullable=False)
    avg_daily_demand: Mapped[float] = mapped_column(Float, nullable=False)
    # {"mae":..,"rmse":..,"wape":..,"mape":..,"bias":..,"holdout_days":..}
    metrics: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    # Candidate scores from model selection + data characteristics, for explainability.
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    job_id: Mapped[str | None] = mapped_column(String(64))

    points: Mapped[list[ForecastPoint]] = relationship(
        lazy="raise", cascade="all, delete-orphan", order_by="ForecastPoint.forecast_date"
    )
    product: Mapped[Product] = relationship(lazy="raise")
    warehouse: Mapped[Warehouse] = relationship(lazy="raise")


class ForecastPoint(Base):
    __tablename__ = "forecast_points"

    run_id: Mapped[int] = mapped_column(ForeignKey("forecast_runs.id", ondelete="CASCADE"), primary_key=True)
    forecast_date: Mapped[date] = mapped_column(Date, primary_key=True)
    predicted: Mapped[float] = mapped_column(Float, nullable=False)
    lower: Mapped[float] = mapped_column(Float, nullable=False)
    upper: Mapped[float] = mapped_column(Float, nullable=False)
