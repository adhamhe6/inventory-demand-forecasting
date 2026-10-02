import pytest

from app.schemas.forecasting import RiskLevel
from app.services.replenishment import classify, lead_time_demand, recommended_quantity


def test_lead_time_demand_uses_forecast_then_extends_with_rate() -> None:
    assert lead_time_demand([1, 2, 3], 2.0, 2) == 3
    assert lead_time_demand([1, 2, 3], 2.0, 5) == 6 + 2 * 2
    assert lead_time_demand([], 2.5, 4) == 10
    assert lead_time_demand([1, 2], 1.0, 0) == 0


@pytest.mark.parametrize(
    ("available", "inbound", "d_l", "ss", "rop", "review", "d", "expected"),
    [
        (0, 50, 20, 5, 25, 14, 1, RiskLevel.CRITICAL),  # out of stock now
        (10, 0, 20, 5, 25, 14, 1, RiskLevel.CRITICAL),  # runs out before replenishment
        (22, 0, 20, 5, 25, 14, 1, RiskLevel.HIGH),  # safety stock breached in lead time
        (25, 0, 20, 5, 25, 14, 1, RiskLevel.MEDIUM),  # at reorder point
        (35, 0, 20, 5, 25, 14, 1, RiskLevel.LOW),  # within one review period of ROP
        (100, 0, 20, 5, 25, 14, 1, RiskLevel.NONE),
        (5, 30, 20, 5, 25, 14, 1, RiskLevel.LOW),  # inbound PO covers lead-time demand + safety stock
        (50, 0, 0, 0, 10, 0, 0, RiskLevel.NONE),  # no demand, above static ROP
    ],
)
def test_classify(
    available: int,
    inbound: int,
    d_l: float,
    ss: int,
    rop: float,
    review: float,
    d: float,
    expected: RiskLevel,
) -> None:
    assert classify(available, inbound, d_l, ss, rop, review, d) == expected


def test_recommended_quantity_orders_up_to_target() -> None:
    assert recommended_quantity(ip=10, rop=25, order_up_to=60) == 50
    assert recommended_quantity(ip=26, rop=25, order_up_to=60) == 0  # above ROP: no order
    assert recommended_quantity(ip=25, rop=25, order_up_to=25.2) == 1  # at least one unit
