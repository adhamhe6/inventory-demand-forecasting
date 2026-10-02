"""Forecast accuracy metrics.

MAPE is undefined when actual demand is zero (division by zero) and explodes for small
actuals, which is common for daily SKU-level demand. We therefore report:

* **MAE / RMSE** – scale-dependent, always defined; MAE is the model-selection criterion.
* **WAPE** – ``sum|e| / sum|y|``: a volume-weighted percentage error that is robust to zero
  days. ``None`` when the holdout has no demand at all.
* **MAPE** – computed only over days with non-zero actuals and reported for familiarity;
  ``None`` when there are no such days.
* **Bias** – mean(forecast - actual); positive means systematic over-forecasting.
"""

from __future__ import annotations

import numpy as np


def mae(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.mean(np.abs(actual - predicted)))


def rmse(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.sqrt(np.mean((actual - predicted) ** 2)))


def wape(actual: np.ndarray, predicted: np.ndarray) -> float | None:
    denom = float(np.sum(np.abs(actual)))
    if denom == 0:
        return None
    return float(np.sum(np.abs(actual - predicted)) / denom)


def mape_nonzero(actual: np.ndarray, predicted: np.ndarray) -> float | None:
    mask = actual != 0
    if not mask.any():
        return None
    return float(np.mean(np.abs((actual[mask] - predicted[mask]) / actual[mask])))


def bias(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.mean(predicted - actual))


def evaluate(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float | None]:
    if actual.shape != predicted.shape or actual.size == 0:
        raise ValueError("actual and predicted must be non-empty arrays of equal shape")

    def r(x: float | None) -> float | None:
        return None if x is None else round(x, 4)

    return {
        "mae": r(mae(actual, predicted)),
        "rmse": r(rmse(actual, predicted)),
        "wape": r(wape(actual, predicted)),
        "mape": r(mape_nonzero(actual, predicted)),
        "bias": r(bias(actual, predicted)),
    }
