"""Forecast model strategies.

Every model implements the same tiny interface (``fit`` on a 1-D array of daily demand,
``predict`` *h* days ahead), so the pipeline can backtest and swap them freely. New models
are added by subclassing :class:`ForecastModel` and registering them in ``MODEL_REGISTRY``.
"""

from __future__ import annotations

import warnings
from abc import ABC, abstractmethod
from typing import ClassVar

import numpy as np


class ForecastModel(ABC):
    name: ClassVar[str]
    version: ClassVar[str] = "1.0"
    #: Minimum number of daily observations needed to fit the model meaningfully.
    min_history: ClassVar[int] = 1

    @abstractmethod
    def fit(self, y: np.ndarray) -> ForecastModel: ...

    @abstractmethod
    def predict(self, horizon: int) -> np.ndarray: ...

    def fit_predict(self, y: np.ndarray, horizon: int) -> np.ndarray:
        return np.clip(self.fit(y).predict(horizon), 0.0, None)


class MovingAverage(ForecastModel):
    """Baseline: flat forecast equal to the mean of the last ``window`` days."""

    name = "moving_average"
    min_history = 1

    def __init__(self, window: int = 28) -> None:
        self.window = window
        self._level = 0.0

    def fit(self, y: np.ndarray) -> MovingAverage:
        tail = y[-self.window :] if len(y) else y
        self._level = float(tail.mean()) if len(tail) else 0.0
        return self

    def predict(self, horizon: int) -> np.ndarray:
        return np.full(horizon, self._level)


class SeasonalNaive(ForecastModel):
    """Weekly seasonal average: each weekday = mean of the same weekday over the last
    ``weeks`` weeks. More robust than a pure seasonal-naive copy of last week."""

    name = "seasonal_naive"
    min_history = 14

    def __init__(self, period: int = 7, weeks: int = 4) -> None:
        self.period = period
        self.weeks = weeks
        self._profile = np.zeros(period)
        self._n = 0

    def fit(self, y: np.ndarray) -> SeasonalNaive:
        self._n = len(y)
        usable = min(len(y) // self.period, self.weeks) * self.period
        tail = y[-usable:] if usable else y
        if usable == 0:
            self._profile = np.full(self.period, float(y.mean()) if len(y) else 0.0)
            return self
        # tail starts at position (n - usable); align each value to its phase in the cycle.
        offset = (self._n - usable) % self.period
        profile = np.zeros(self.period)
        for phase in range(self.period):
            vals = tail[(np.arange(usable) + offset) % self.period == phase]
            profile[phase] = vals.mean() if len(vals) else 0.0
        self._profile = profile
        return self

    def predict(self, horizon: int) -> np.ndarray:
        phases = (np.arange(horizon) + self._n) % self.period
        return self._profile[phases]


class HoltWinters(ForecastModel):
    """Additive Holt-Winters with damped trend and weekly seasonality (statsmodels).

    Captures level, (damped) trend and day-of-week effects – the dominant structure of
    retail daily demand – without the data requirements of ML regressors.
    """

    name = "holt_winters"
    version = "1.1"
    min_history = 56  # >= 8 seasonal cycles for stable seasonal initialisation

    def __init__(self, seasonal_periods: int = 7) -> None:
        self.seasonal_periods = seasonal_periods
        self._fitted: object | None = None

    def fit(self, y: np.ndarray) -> HoltWinters:
        from statsmodels.tsa.holtwinters import ExponentialSmoothing

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            model = ExponentialSmoothing(
                y.astype(float),
                trend="add",
                damped_trend=True,
                seasonal="add",
                seasonal_periods=self.seasonal_periods,
                initialization_method="estimated",
            )
            self._fitted = model.fit(optimized=True)
        return self

    def predict(self, horizon: int) -> np.ndarray:
        assert self._fitted is not None, "fit() must be called first"
        return np.asarray(self._fitted.forecast(horizon), dtype=float)  # type: ignore[attr-defined]


class Croston(ForecastModel):
    """Croston's method with the Syntetos-Boylan Approximation (SBA) bias correction.

    Designed for intermittent demand (many zero days): smooths non-zero demand sizes and
    the intervals between them separately; forecast rate = (1 - a/2) * size / interval.
    """

    name = "croston"
    min_history = 14

    def __init__(self, alpha: float = 0.1) -> None:
        self.alpha = alpha
        self._rate = 0.0

    def fit(self, y: np.ndarray) -> Croston:
        nz = np.flatnonzero(y > 0)
        if len(nz) == 0:
            self._rate = 0.0
            return self
        size = float(y[nz[0]])
        interval = float(nz[0] + 1)
        last = nz[0]
        for idx in nz[1:]:
            size += self.alpha * (float(y[idx]) - size)
            interval += self.alpha * (float(idx - last) - interval)
            last = idx
        self._rate = (1 - self.alpha / 2) * size / max(interval, 1.0)
        return self

    def predict(self, horizon: int) -> np.ndarray:
        return np.full(horizon, self._rate)


MODEL_REGISTRY: dict[str, type[ForecastModel]] = {
    m.name: m for m in (MovingAverage, SeasonalNaive, HoltWinters, Croston)
}


def create_model(name: str) -> ForecastModel:
    try:
        return MODEL_REGISTRY[name]()
    except KeyError as exc:
        raise ValueError(f"Unknown forecast model '{name}'") from exc
