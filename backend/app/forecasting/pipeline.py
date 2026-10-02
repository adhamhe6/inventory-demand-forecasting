"""End-to-end forecasting pipeline for a single (product, warehouse) daily demand series.

    history → validate/aggregate → profile → candidate models → holdout backtest
            → select (lowest MAE; RMSE for intermittent) → refit on full history → forecast + intervals

A rolling-origin backtest (3 origins x 14 days when history allows) trains each candidate on
the data before each origin and scores it on the following days. Selection by MAE favours the model that minimises unit error, which is
what drives stock decisions. Ties go to the simpler model (registry order).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import numpy as np
import pandas as pd

from app.forecasting.metrics import evaluate
from app.forecasting.models import MODEL_REGISTRY, ForecastModel, create_model
from app.forecasting.preprocessing import ForecastDataError, profile_series

logger = logging.getLogger(__name__)

PIPELINE_VERSION = "1.0"
INTERVAL_Z = 1.2816  # two-sided 80% normal quantile


@dataclass
class ForecastResult:
    model_name: str
    model_version: str
    dates: list[date]
    predicted: np.ndarray
    lower: np.ndarray
    upper: np.ndarray
    metrics: dict[str, Any]
    details: dict[str, Any] = field(default_factory=dict)

    @property
    def total(self) -> float:
        return float(self.predicted.sum())

    @property
    def avg_daily(self) -> float:
        return float(self.predicted.mean()) if len(self.predicted) else 0.0


def _candidates(profile_pattern: str, n_train: int) -> list[str]:
    if profile_pattern in ("intermittent", "lumpy"):
        names = ["moving_average", "croston", "seasonal_naive"]
    else:
        names = ["moving_average", "seasonal_naive", "holt_winters"]
    return [n for n in names if MODEL_REGISTRY[n].min_history <= n_train]


def run_forecast(
    series: pd.Series,
    horizon: int,
    *,
    model: str = "auto",
    backtest_days: int = 28,
    min_history: int = 14,
) -> ForecastResult:
    """Forecast ``horizon`` days after the last date of a zero-filled daily ``series``."""
    if horizon <= 0:
        raise ForecastDataError("horizon must be positive")
    y = series.to_numpy(dtype=float)
    if np.isnan(y).any() or (y < 0).any():
        raise ForecastDataError("series must be non-negative and contain no NaN")
    last_day = series.index[-1].date() if len(series) else date.today()
    dates = [last_day + timedelta(days=i + 1) for i in range(horizon)]
    profile = profile_series(y)
    details: dict[str, Any] = {"profile": profile.as_dict(), "pipeline_version": PIPELINE_VERSION}

    if len(y) < min_history or profile.pattern == "no_demand":
        # Not enough signal to validate anything: use a transparent baseline, no metrics.
        chosen: ForecastModel = create_model("moving_average")
        pred = chosen.fit_predict(y, horizon)
        sigma = float(y.std()) if len(y) > 1 else float(pred.mean())
        details["selection"] = "insufficient_history" if len(y) < min_history else "no_demand"
        return _result(chosen, dates, pred, sigma, {"holdout_days": 0}, details)

    # Rolling-origin evaluation: `folds` consecutive origins, each forecasting `fold_len` days.
    holdout = min(backtest_days, max(7, len(y) // 4))
    folds = 3 if len(y) - holdout >= 56 else 1
    fold_len = max(7, holdout // 2) if folds > 1 else holdout
    origins = [len(y) - fold_len * k for k in range(folds, 0, -1)]
    test_all = np.concatenate([y[o : o + fold_len] for o in origins])
    names = [model] if model != "auto" else _candidates(profile.pattern, origins[0])
    if not names:
        names = ["moving_average"]

    def backtest(name: str) -> np.ndarray:
        return np.concatenate([create_model(name).fit_predict(y[:o], fold_len) for o in origins])

    scores: dict[str, dict[str, Any]] = {}
    residuals: dict[str, np.ndarray] = {}
    for name in names:
        try:
            fc = backtest(name)
        except Exception as exc:  # a model failing to converge must not fail the pipeline
            logger.warning("forecast candidate failed", extra={"model": name, "error": str(exc)})
            scores[name] = {"error": str(exc)}
            continue
        scores[name] = evaluate(test_all, fc)
        residuals[name] = test_all - fc

    valid = {n: s for n, s in scores.items() if "error" not in s}
    if not valid:
        best_name = "moving_average"
        fc = backtest(best_name)
        valid[best_name] = evaluate(test_all, fc)
        residuals[best_name] = test_all - fc
    else:
        # MAE is minimised by the median, which for intermittent demand is often 0 – a forecast
        # that would never trigger replenishment. Use RMSE (mean-unbiased) for those series.
        criterion = "rmse" if profile.pattern in ("intermittent", "lumpy") else "mae"
        details["selection_metric"] = criterion
        best_name = min(valid, key=lambda n: (valid[n][criterion], names.index(n)))
    details["backtest"] = {"folds": folds, "fold_days": fold_len, "evaluated_days": len(test_all)}

    chosen = create_model(best_name)
    try:
        pred = chosen.fit_predict(y, horizon)
    except Exception:
        logger.exception("refit failed; falling back to moving average", extra={"model": best_name})
        chosen = create_model("moving_average")
        pred = chosen.fit_predict(y, horizon)
    res = residuals[best_name]
    sigma = float(np.std(res, ddof=1)) if len(res) > 1 else 0.0
    metrics = {**valid[best_name], "holdout_days": len(test_all)}
    details["candidates"] = scores
    details["selection"] = "auto" if model == "auto" else "explicit"
    return _result(chosen, dates, pred, sigma, metrics, details)


def _result(
    chosen: ForecastModel,
    dates: list[date],
    pred: np.ndarray,
    sigma: float,
    metrics: dict[str, Any],
    details: dict[str, Any],
) -> ForecastResult:
    width = INTERVAL_Z * max(sigma, 0.0)
    details["interval"] = {"level": 0.8, "method": "empirical holdout residual std", "sigma": round(sigma, 4)}
    return ForecastResult(
        model_name=chosen.name,
        model_version=f"{PIPELINE_VERSION}/{chosen.version}",
        dates=dates,
        predicted=np.round(pred, 4),
        lower=np.round(np.clip(pred - width, 0, None), 4),
        upper=np.round(pred + width, 4),
        metrics=metrics,
        details=details,
    )
