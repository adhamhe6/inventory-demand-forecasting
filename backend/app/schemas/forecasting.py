from __future__ import annotations

import enum
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, Field

from app.db.models.enums import JobStatus, JobType


class JobRead(BaseModel):
    id: str
    type: JobType
    status: JobStatus
    params: dict[str, Any]
    result: dict[str, Any] | None
    error: str | None
    progress: int = Field(ge=0, le=100)
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class ForecastRequest(BaseModel):
    product_id: int = Field(gt=0)
    warehouse_id: int = Field(gt=0)
    horizon_days: int = Field(default=30, ge=1, le=180)
    model: str = Field(
        default="auto",
        description="auto | moving_average | seasonal_naive | holt_winters | croston",
        pattern=r"^(auto|moving_average|seasonal_naive|holt_winters|croston)$",
    )


class ForecastAllRequest(BaseModel):
    horizon_days: int = Field(default=30, ge=1, le=180)
    warehouse_id: int | None = Field(default=None, gt=0)


class ForecastPointRead(BaseModel):
    date: date
    predicted: float
    lower: float
    upper: float


class HistoryPoint(BaseModel):
    date: date
    quantity: float


class ForecastMetrics(BaseModel):
    mae: float | None = None
    rmse: float | None = None
    wape: float | None = Field(default=None, description="Weighted absolute % error (sum|e|/sum y)")
    mape: float | None = Field(default=None, description="MAPE over non-zero actual days only")
    bias: float | None = Field(default=None, description="Mean(forecast - actual); >0 = over-forecast")
    holdout_days: int | None = None


class ForecastRunSummary(BaseModel):
    id: int
    product_id: int
    sku: str
    product_name: str
    warehouse_id: int
    warehouse_code: str
    horizon_days: int
    model_name: str
    model_version: str
    generated_at: datetime
    total_predicted: float
    avg_daily_demand: float
    history_days: int
    metrics: ForecastMetrics


class ForecastRunRead(ForecastRunSummary):
    history_start: date | None
    history_end: date | None
    details: dict[str, Any]
    points: list[ForecastPointRead]


class ForecastWithHistory(BaseModel):
    forecast: ForecastRunRead | None
    history: list[HistoryPoint]


class RiskLevel(enum.StrEnum):
    NONE = "NONE"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class DemandSource(enum.StrEnum):
    FORECAST = "FORECAST"
    HISTORICAL_AVERAGE = "HISTORICAL_AVERAGE"
    NONE = "NONE"


class StockRiskRead(BaseModel):
    inventory_item_id: int
    product_id: int
    sku: str
    product_name: str
    category: str
    warehouse_id: int
    warehouse_code: str
    warehouse_name: str
    quantity_on_hand: int
    available_quantity: int
    inbound_quantity: int = Field(description="Open purchase order quantity not yet received (incl. drafts)")
    inbound_within_lead_time: int = Field(
        description="Submitted/confirmed PO quantity expected within the lead time"
    )
    next_inbound_date: date | None = Field(
        description="Expected date of the next submitted/confirmed delivery"
    )
    stockout_before_inbound: bool = Field(description="Stock is expected to run out before the next delivery")
    safety_stock: int
    reorder_point: float = Field(
        description="Dynamic reorder point: max(static ROP, lead-time demand + safety stock)"
    )
    lead_time_days: int
    avg_daily_demand: float
    demand_during_lead_time: float
    projected_stock_at_lead_time: float = Field(
        description="available + inbound expected within the lead time - demand during lead time"
    )
    days_of_cover: float | None = Field(description="available / avg daily demand")
    stockout_date: date | None
    demand_source: DemandSource
    forecast_run_id: int | None
    risk_level: RiskLevel
    reason: str
    recommended_action: str


class RestockRecommendation(BaseModel):
    inventory_item_id: int
    product_id: int
    sku: str
    product_name: str
    category: str
    warehouse_id: int
    warehouse_code: str
    warehouse_name: str
    supplier_id: int | None
    supplier_name: str | None
    available_quantity: int
    inbound_quantity: int
    inventory_position: int
    avg_daily_demand: float
    lead_time_days: int
    review_period_days: int
    demand_during_lead_time: float
    safety_stock: int
    reorder_point: float = Field(description="max(static ROP, lead-time demand + safety stock)")
    order_up_to_level: float
    recommended_quantity: int
    unit_cost: float
    estimated_cost: float
    risk_level: RiskLevel
    demand_source: DemandSource
    rationale: str


class CreatePOsFromRecommendations(BaseModel):
    items: list[RecommendationSelection] = Field(min_length=1, max_length=200)


class RecommendationSelection(BaseModel):
    product_id: int = Field(gt=0)
    warehouse_id: int = Field(gt=0)
    quantity: int = Field(gt=0, le=1_000_000)
    supplier_id: int | None = Field(default=None, gt=0, description="Defaults to preferred supplier")


class CreatedPurchaseOrders(BaseModel):
    purchase_order_ids: list[int]
    po_numbers: list[str]


CreatePOsFromRecommendations.model_rebuild()
