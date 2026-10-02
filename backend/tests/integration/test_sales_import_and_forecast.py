from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.cache.redis_cache import get_cache
from app.db.database import get_sessionmaker
from app.db.models import ForecastRun, Sale
from app.services.forecasting import KEEP_RUNS_PER_ITEM, ForecastService
from app.services.sales import CsvFormatError, SalesService

pytestmark = pytest.mark.integration


def write_csv(tmp_path: Path, lines: list[str]) -> Path:
    p = tmp_path / "sales.csv"
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


async def do_import(path: Path) -> dict:
    async with get_sessionmaker()() as s:
        return await SalesService(s, get_cache()).import_csv(path)


async def test_import_validates_dedupes_and_reports(catalog: dict, tmp_path: Path) -> None:
    path = write_csv(
        tmp_path,
        [
            "sku,warehouse_code,sold_at,quantity,order_reference,unit_price",
            "SKU-1,WH-A,2025-01-01,3,SO-1,4.99",
            "sku-1,wh-a,2025-01-02T10:00:00Z,2,SO-2,",
            "SKU-1,WH-A,2025-01-02,2,SO-2,",  # duplicate key (same order/product/warehouse)
            "SKU-404,WH-A,2025-01-02,1,SO-3,",  # unknown sku
            "SKU-2,WH-B,not-a-date,1,SO-4,",
            "SKU-2,WH-B,2025-01-03,-5,SO-5,",
            "SKU-2,WH-B,2025-01-03,1,SO-6,1.00,EXTRA",  # too many fields
        ],
    )
    r = await do_import(path)
    assert (r["total_rows"], r["inserted"], r["duplicates"], r["invalid"]) == (7, 2, 1, 4)
    assert [e["line"] for e in r["errors"]] == [5, 6, 7, 8]
    # Re-importing the same file adds nothing.
    r2 = await do_import(path)
    assert r2["inserted"] == 0 and r2["duplicates"] == 3


async def test_import_rejects_missing_columns(catalog: dict, tmp_path: Path) -> None:
    path = write_csv(tmp_path, ["sku,quantity", "SKU-1,3"])
    with pytest.raises(CsvFormatError, match="missing required column"):
        await do_import(path)


async def test_import_handles_binary_garbage(catalog: dict, tmp_path: Path) -> None:
    p = tmp_path / "bad.csv"
    p.write_bytes(b"sku,warehouse_code,sold_at,quantity,order_reference\n\xff\xfe\x00garbage")
    with pytest.raises(CsvFormatError):
        await do_import(p)


async def test_import_streams_large_files_in_batches(catalog: dict, tmp_path: Path) -> None:
    lines = ["sku,warehouse_code,sold_at,quantity,order_reference"]
    start = date(2024, 1, 1)
    lines += [f"SKU-1,WH-A,{start + timedelta(days=i % 365)},1,BULK-{i}" for i in range(2500)]
    r = await do_import(write_csv(tmp_path, lines))
    assert r["inserted"] == 2500 and r["invalid"] == 0
    async with get_sessionmaker()() as s:
        assert await s.scalar(select(func.count()).select_from(Sale)) == 2500


async def seed_sales(catalog: dict, days: int = 120) -> None:
    async with get_sessionmaker()() as s:
        today = datetime.now(UTC).date()
        for i in range(days):
            d = today - timedelta(days=days - i)
            s.add(
                Sale(
                    product_id=catalog["p1"].id,
                    warehouse_id=catalog["wa"].id,
                    sold_at=datetime(d.year, d.month, d.day, 12, tzinfo=UTC),
                    quantity=5 + (i % 7),
                    unit_price=5,
                    order_reference=f"H-{i}",
                )
            )
        await s.commit()


async def test_forecast_item_persists_run_points_and_prunes(catalog: dict) -> None:
    await seed_sales(catalog)
    for _ in range(KEEP_RUNS_PER_ITEM + 2):
        async with get_sessionmaker()() as s:
            run = await ForecastService(s, get_cache()).forecast_item(catalog["p1"].id, catalog["wa"].id, 14)
    async with get_sessionmaker()() as s:
        latest = await ForecastService(s, get_cache()).latest_for_item(catalog["p1"].id, catalog["wa"].id)
        count = await s.scalar(select(func.count()).select_from(ForecastRun))
    assert latest is not None and latest["id"] == run.id
    assert len(latest["points"]) == 14 and latest["points"][0]["date"] == datetime.now(UTC).date()
    assert 7 < latest["avg_daily_demand"] < 10  # true mean is 8
    assert latest["metrics"]["mae"] is not None
    assert count == KEEP_RUNS_PER_ITEM


async def test_forecast_all_isolated_failures(catalog: dict) -> None:
    await seed_sales(catalog, 60)
    result = await ForecastService.forecast_all(get_sessionmaker(), get_cache(), 7)
    assert result["succeeded"] == result["items"] >= 1 and result["failed"] == 0
