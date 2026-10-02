"""CSV export helper for report/list endpoints."""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from typing import Any

from fastapi.responses import StreamingResponse

_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _safe(value: Any) -> Any:
    """Neutralise spreadsheet formula injection (CSV injection) in text cells."""
    if isinstance(value, str) and value.startswith(_FORMULA_PREFIXES):
        return "'" + value
    return value


def maybe_csv(rows: Iterable[dict[str, Any]], name: str, columns: Sequence[str]) -> StreamingResponse:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=list(columns), extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({c: _safe(row.get(c)) for c in columns})
    filename = f"{name}-{datetime.now(UTC):%Y%m%d}.csv"
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
