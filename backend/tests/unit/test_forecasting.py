from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from app.forecasting.metrics import evaluate, mape_nonzero, wape
from app.forecasting.models import (
    MODEL_REGISTRY,
    Croston,
    HoltWinters,
    MovingAverage,
    SeasonalNaive,
    create_model,
)
from app.forecasting.pipeline import run_forecast
from app.forecasting.preprocessing import ForecastDataError, build_daily_series, profile_series

START = date(2025, 1, 1)


def series_from(values: np.ndarray, start: date = START) -> pd.Series:
    obs = [(start + timedelta(days=i), float(v)) for i, v in enumerate(values) if v]
    return build_daily_series(obs, start, start + timedelta(days=len(values) - 1))


# ------------------------------------------------------------------ preprocessing
def test_build_daily_series_zero_fills_and_sums_same_day() -> None:
    s = build_daily_series(
        [(START, 2), (START, 3), (START + timedelta(days=3), 1)], START, START + timedelta(days=4)
    )
    assert s.tolist() == [5, 0, 0, 1, 0]


@pytest.mark.parametrize("obs", [[(START, -1)], [(START, "abc")]])
def test_build_daily_series_rejects_bad_quantities(obs: list) -> None:
    with pytest.raises(ForecastDataError):
        build_daily_series(obs, START, START)


def test_build_daily_series_rejects_inverted_range() -> None:
    with pytest.raises(ForecastDataError):
        build_daily_series([], START, START - timedelta(days=1))


@pytest.mark.parametrize(
    ("values", "pattern"),
    [
        (np.full(60, 10.0), "smooth"),
        (np.tile([0, 0, 0, 0, 5, 0, 0], 10).astype(float), "intermittent"),
        (np.zeros(30), "no_demand"),
    ],
)
def test_profile_classifies_demand_patterns(values: np.ndarray, pattern: str) -> None:
    assert profile_series(values).pattern == pattern


# ------------------------------------------------------------------ metrics
def test_metrics_basic() -> None:
    m = evaluate(np.array([10.0, 20.0]), np.array([12.0, 18.0]))
    assert m["mae"] == 2.0
    assert m["rmse"] == 2.0
    assert m["wape"] == pytest.approx(4 / 30, abs=1e-4)
    assert m["bias"] == 0.0


def test_mape_ignores_zero_actual_days_and_wape_handles_all_zero() -> None:
    actual = np.array([0.0, 10.0, 0.0])
    pred = np.array([5.0, 8.0, 1.0])
    assert mape_nonzero(actual, pred) == pytest.approx(0.2)
    assert mape_nonzero(np.zeros(3), pred) is None
    assert wape(np.zeros(3), pred) is None


def test_evaluate_rejects_mismatched_shapes() -> None:
    with pytest.raises(ValueError, match="equal shape"):
        evaluate(np.array([1.0]), np.array([1.0, 2.0]))


# ------------------------------------------------------------------ models
def test_moving_average_flat_forecast() -> None:
    pred = MovingAverage(window=4).fit(np.array([1, 2, 3, 4, 5, 6.0])).predict(3)
    assert pred.tolist() == [4.5, 4.5, 4.5]


def test_seasonal_naive_preserves_weekday_phase() -> None:
    week = np.array([1, 2, 3, 4, 5, 6, 7.0])
    y = np.tile(week, 5)[:-2]  # history ends mid-week (phase shift)
    pred = SeasonalNaive().fit(y).predict(7)
    # next value continues the cycle exactly where history stopped
    assert pred.tolist() == [6, 7, 1, 2, 3, 4, 5]


def test_croston_rate_matches_intermittent_mean() -> None:
    y = np.tile([0, 0, 0, 4.0], 30)  # 1 unit/day on average
    rate = Croston(alpha=0.1).fit(y).predict(1)[0]
    assert 0.8 < rate < 1.05  # SBA deliberately shades the rate down slightly


def test_holt_winters_tracks_trend_and_season() -> None:
    t = np.arange(140)
    y = 20 + 0.1 * t + 5 * np.sin(2 * np.pi * t / 7)
    pred = HoltWinters().fit(y).predict(7)
    assert pred.mean() == pytest.approx((20 + 0.1 * np.arange(140, 147)).mean(), rel=0.08)


def test_forecasts_are_never_negative() -> None:
    y = np.array([10, 8, 6, 4, 2, 0, 0, 0] * 10, dtype=float)
    for name in MODEL_REGISTRY:
        assert (create_model(name).fit_predict(y, 14) >= 0).all(), name


def test_unknown_model_raises() -> None:
    with pytest.raises(ValueError, match="Unknown"):
        create_model("prophet")


# ------------------------------------------------------------------ pipeline
def test_pipeline_selects_by_backtest_and_reports_metrics() -> None:
    rng = np.random.default_rng(0)
    t = np.arange(200)
    y = rng.poisson(10 * np.array([1.4, 1.2, 1, 1, 1, 0.5, 0.4])[t % 7])
    result = run_forecast(series_from(y), 30)
    assert len(result.predicted) == 30
    assert result.dates[0] == START + timedelta(days=200)
    assert set(result.details["candidates"]) == {"moving_average", "seasonal_naive", "holt_winters"}
    # weekly seasonality must beat the flat baseline
    assert result.model_name in {"seasonal_naive", "holt_winters"}
    assert result.metrics["holdout_days"] == 42 and result.metrics["mae"] > 0
    assert (result.lower <= result.predicted).all() and (result.predicted <= result.upper).all()


def test_pipeline_uses_croston_candidates_for_intermittent_demand() -> None:
    y = np.tile([0, 0, 0, 0, 0, 3, 0, 0, 0, 2.0], 20)
    result = run_forecast(series_from(y), 14)
    assert "croston" in result.details["candidates"]
    assert result.details["selection_metric"] == "rmse"
    assert result.avg_daily > 0  # never collapses to a useless zero forecast


def test_pipeline_short_history_falls_back_to_baseline() -> None:
    result = run_forecast(series_from(np.array([3, 4, 5.0])), 7)
    assert result.model_name == "moving_average"
    assert result.details["selection"] == "insufficient_history"
    assert result.avg_daily == pytest.approx(4.0)


def test_pipeline_no_demand_returns_zero_forecast() -> None:
    result = run_forecast(series_from(np.zeros(60)), 7)
    assert result.total == 0
    assert result.details["selection"] == "no_demand"


def test_pipeline_explicit_model() -> None:
    result = run_forecast(series_from(np.full(90, 5.0)), 10, model="moving_average")
    assert result.model_name == "moving_average"
    assert result.details["selection"] == "explicit"
    assert result.total == pytest.approx(50.0)


def test_pipeline_rejects_bad_horizon() -> None:
    with pytest.raises(ForecastDataError):
        run_forecast(series_from(np.full(30, 1.0)), 0)
