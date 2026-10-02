import pytest

from app.cache.redis_cache import get_cache
from app.core.security import Role

from .helpers import ok, setup_master_data

pytestmark = pytest.mark.e2e
API = "/api/v1"


async def test_dashboard_is_cached_and_invalidated_by_stock_changes(client, auth) -> None:
    h = auth()
    m = await setup_master_data(client, h)
    body = {"product_id": m["product"]["id"], "warehouse_id": m["wa"]["id"]}
    ok(await client.post(f"{API}/inventory/receive", json={**body, "quantity": 100}, headers=h))
    cache = get_cache()
    d1 = ok(await client.get(f"{API}/reports/dashboard", headers=h))
    hits = cache.hits
    d2 = ok(await client.get(f"{API}/reports/dashboard", headers=h))
    assert cache.hits == hits + 1 and d1 == d2  # served from Redis
    assert d1["kpis"]["total_units"] == 100 and d1["kpis"]["inventory_value"] == 40.0
    ok(await client.post(f"{API}/inventory/issue", json={**body, "quantity": 30}, headers=h))
    d3 = ok(await client.get(f"{API}/reports/dashboard", headers=h))
    assert d3["kpis"]["total_units"] == 70  # invalidated, recomputed


async def test_reports_endpoints(client, auth) -> None:
    h = auth(Role.ANALYST)
    m = await setup_master_data(client, auth())
    body = {"product_id": m["product"]["id"], "warehouse_id": m["wa"]["id"]}
    ok(await client.post(f"{API}/inventory/receive", json={**body, "quantity": 10}, headers=auth()))
    ok(
        await client.post(
            f"{API}/sales", json={**body, "quantity": 4, "order_reference": "A"}, headers=auth()
        ),
        201,
    )
    value = ok(await client.get(f"{API}/reports/inventory-value", params={"group_by": "category"}, headers=h))
    assert value["rows"][0]["group"] == "Fasteners" and value["rows"][0]["units"] == 6
    summary = ok(await client.get(f"{API}/reports/sales-summary", params={"granularity": "week"}, headers=h))
    assert summary["totals"]["units"] == 4 and summary["top_products"][0]["sku"] == "BOLT-M8"
    low = ok(await client.get(f"{API}/reports/low-stock", headers=h))
    assert low["items"][0]["status"] == "CRITICAL"  # 6 available <= safety stock 20
    trend = ok(await client.get(f"{API}/reports/inventory-trend", params={"days": 7}, headers=h))
    assert len(trend) == 7 and trend[-1]["units"] == 6
    ok(await client.get(f"{API}/reports/supplier-performance", headers=h))
    po = ok(await client.get(f"{API}/reports/purchase-orders", headers=h))
    assert {s["status"] for s in po["by_status"]} >= {"DRAFT", "RECEIVED"}
    ok(await client.get(f"{API}/reports/forecast-accuracy", headers=h))
    ok(await client.get(f"{API}/warehouses/summary", headers=h))
    r = await client.get(f"{API}/inventory", params={"format": "csv"}, headers=h)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert r.text.splitlines()[0].startswith("sku,product_name")
    r = await client.get(
        f"{API}/reports/sales-summary", params={"date_from": "2025-02-01", "date_to": "2025-01-01"}, headers=h
    )
    assert r.status_code == 400


async def test_forecast_job_dedupe_and_job_listing(client, auth) -> None:
    h = auth()
    m = await setup_master_data(client, h)
    job = ok(
        await client.post(
            f"{API}/forecasts/run",
            json={"product_id": m["product"]["id"], "warehouse_id": m["wa"]["id"]},
            headers=h,
        ),
        202,
    )
    jobs = ok(await client.get(f"{API}/jobs", headers=h))
    assert jobs["items"][0]["id"] == job["id"]
    # no sales history: still succeeds with a zero, clearly-labelled baseline forecast
    done = ok(await client.get(f"{API}/jobs/{job['id']}", headers=h))
    assert done["status"] == "SUCCEEDED" and done["result"]["total_predicted"] == 0
    all_job = ok(await client.post(f"{API}/forecasts/run-all", json={"horizon_days": 7}, headers=h), 202)
    done = ok(await client.get(f"{API}/jobs/{all_job['id']}", headers=h))
    assert done["status"] == "SUCCEEDED" and done["result"]["failed"] == 0
