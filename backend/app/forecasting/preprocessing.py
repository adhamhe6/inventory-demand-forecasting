"""Data validation, aggregation and demand-pattern characterisation."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date

import numpy as np
import pandas as pd


class ForecastDataError(ValueError):
    """Input history is unusable (e.g. negative quantities, inverted date range)."""


@dataclass(frozen=True)
class SeriesProfile:
    n_days: int
    total: float
    mean: float
    zero_ratio: float
    adi: float | None  # average inter-demand interval (days between non-zero demand)
    cv2: float | None  # squared coefficient of variation of non-zero demand sizes
    pattern: str  # smooth | erratic | intermittent | lumpy | no_demand

    def as_dict(self) -> dict[str, object]:
        return {
            "n_days": self.n_days,
            "total": round(self.total, 3),
            "mean": round(self.mean, 4),
            "zero_ratio": round(self.zero_ratio, 4),
            "adi": None if self.adi is None else round(self.adi, 3),
            "cv2": None if self.cv2 is None else round(self.cv2, 3),
            "pattern": self.pattern,
        }


def build_daily_series(observations: Iterable[tuple[date, float]], start: date, end: date) -> pd.Series:
    """Aggregate (day, quantity) observations into a continuous daily series.

    Days without sales are real zero-demand days, so the series is zero-filled. Multiple
    observations on the same day are summed.
    """
    if end < start:
        raise ForecastDataError("history end is before history start")
    index = pd.date_range(start, end, freq="D")
    obs = list(observations)
    if not obs:
        return pd.Series(np.zeros(len(index)), index=index, dtype="float64")
    frame = pd.DataFrame(obs, columns=["day", "qty"])
    frame["qty"] = pd.to_numeric(frame["qty"], errors="coerce")
    if frame["qty"].isna().any():
        raise ForecastDataError("history contains non-numeric quantities")
    if (frame["qty"] < 0).any():
        raise ForecastDataError("history contains negative quantities")
    frame["day"] = pd.to_datetime(frame["day"])
    daily = frame.groupby("day")["qty"].sum()
    return daily.reindex(index, fill_value=0.0).astype("float64")


def profile_series(y: np.ndarray) -> SeriesProfile:
    """Classify demand using the Syntetos-Boylan ADI/CV² scheme."""
    n = len(y)
    total = float(y.sum())
    nonzero = y[y > 0]
    zero_ratio = float((y == 0).mean()) if n else 1.0
    if len(nonzero) == 0:
        return SeriesProfile(n, total, 0.0, zero_ratio, None, None, "no_demand")
    adi = n / len(nonzero)
    cv2 = float((nonzero.std() / nonzero.mean()) ** 2) if len(nonzero) > 1 else 0.0
    if adi < 1.32:
        pattern = "smooth" if cv2 < 0.49 else "erratic"
    else:
        pattern = "intermittent" if cv2 < 0.49 else "lumpy"
    return SeriesProfile(n, total, total / n if n else 0.0, zero_ratio, adi, cv2, pattern)
