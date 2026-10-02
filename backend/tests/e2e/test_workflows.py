"""The four required end-to-end workflows, driven purely through the HTTP API."""

import io
from datetime import UTC, datetime, timedelta

import pytest

from .helpers import ok, setup_master_data

pytestmark = pytest.mark.e2e
API = "/api/v1"


async def stock(client, h, product_id: int, warehouse_id: int) -> dict:
    page = ok(
        await client.get(
            f"{API}/inventory", params={"product_id": product_id, "warehouse_id": warehouse_id}, headers=h
        )
    )
    return (
        page["items"][0]
        if page["items"]
        else {"quantity_on_hand": 0, "available_quantity": 0, "reserved_quantity": 0}
    )


async def test_workflow_1_purchase_order_receiving_increases_inventory(client, auth) -> None:
    from app.core.security import Role

    admin, buyer, wh = auth(Role.ADMIN), auth(Role.PURCHASING_MANAGER), auth(Role.WAREHOUSE_MANAGER)
    m = await setup_master_data(client, admin)
    assert m["wa"]["code"] == "WH-EAST" and m["product"]["sku"] == "BOLT-M8"

    po = ok(
        await client.post(
            f"{API}/purchase-orders",
            json={
                "supplier_id": m["supplier"]["id"],
                "warehouse_id": m["wa"]["id"],
                "notes": "initial stock",
                "lines": [{"product_id": m["product"]["id"], "quantity_ordered": 500}],
            },
            headers=buyer,
        ),
        201,
    )
    assert po["status"] == "DRAFT" and po["total_amount"] == "200.00"
    for target in ("SUBMITTED", "CONFIRMED"):
        po = ok(
            await client.post(
                f"{API}/purchase-orders/{po['id']}/status", json={"status": target}, headers=buyer
            )
        )
    assert po["status"] == "CONFIRMED" and set(po["allowed_transitions"]) == {
        "CANCELLED",
        "PARTIALLY_RECEIVED",
        "RECEIVED",
    }

    before = await stock(client, admin, m["product"]["id"], m["wa"]["id"])
    line_id = po["lines"][0]["id"]
    r1 = ok(
        await client.post(
            f"{API}/purchase-orders/{po['id']}/receive",
            json={"lines": [{"line_id": line_id, "quantity": 300}], "receipt_reference": "DN-1"},
            headers=wh,
        )
    )
    assert r1["purchase_order"]["status"] == "PARTIALLY_RECEIVED" and not r1["replayed"]
    r2 = ok(
        await client.post(
            f"{API}/purchase-orders/{po['id']}/receive", json={"receipt_reference": "DN-2"}, headers=wh
        )
    )
    assert r2["purchase_order"]["status"] == "RECEIVED" and r2["purchase_order"]["received_date"]

    after = await stock(client, admin, m["product"]["id"], m["wa"]["id"])
    assert after["quantity_on_hand"] - before["quantity_on_hand"] == 500
    ledger = ok(
        await client.get(
            f"{API}/inventory/transactions", params={"reference": po["po_number"]}, headers=admin
        )
    )
    assert ledger["total"] == 2 and {t["type"] for t in ledger["items"]} == {"PURCHASE_RECEIPT"}
    detail = ok(await client.get(f"{API}/purchase-orders/{po['id']}", headers=admin))
    assert [r["receipt_key"] for r in detail["receipts"]] == ["DN-1", "DN-2"]


async def test_workflow_2_sales_history_to_forecast_to_restocking(client, auth) -> None:
    from app.core.security import Role

    admin, analyst, buyer = auth(Role.ADMIN), auth(Role.ANALYST), auth(Role.PURCHASING_MANAGER)
    m = await setup_master_data(client, admin)
    pid, wid = m["product"]["id"], m["wa"]["id"]

    # Current stock: 60 units (covers ~5 days at ~12/day, lead time is 7 days).
    ok(
        await client.post(
            f"{API}/inventory/receive",
            json={"product_id": pid, "warehouse_id": wid, "quantity": 60},
            headers=admin,
        )
    )

    # 1. Import 120 days of history via CSV (background job; inline in tests).
    today = datetime.now(UTC).date()
    rows = ["sku,warehouse_code,sold_at,quantity,order_reference,unit_price"]
    for i in range(120, 0, -1):
        d = today - timedelta(days=i)
        rows.append(f"BOLT-M8,WH-EAST,{d.isoformat()},{10 + (i % 7)},SO-{i},1.20")
    rows.append("BOLT-M8,WH-EAST,garbage,1,SO-bad,1.20")
    files = {"file": ("history.csv", io.BytesIO("\n".join(rows).encode()), "text/csv")}
    job = ok(await client.post(f"{API}/sales/import", files=files, headers=analyst), 202)
    job = ok(await client.get(f"{API}/jobs/{job['id']}", headers=analyst))
    assert job["status"] == "SUCCEEDED", job
    assert job["result"]["inserted"] == 120 and job["result"]["invalid"] == 1
    assert job["result"]["errors"][0]["line"] == 122

    # 2. Run the forecast (background job) and 3. verify it is stored.
    job = ok(
        await client.post(
            f"{API}/forecasts/run",
            json={"product_id": pid, "warehouse_id": wid, "horizon_days": 30},
            headers=analyst,
        ),
        202,
    )
    job = ok(await client.get(f"{API}/jobs/{job['id']}", headers=analyst))
    assert job["status"] == "SUCCEEDED", job
    run_id = job["result"]["forecast_run_id"]
    item = ok(
        await client.get(
            f"{API}/forecasts/item", params={"product_id": pid, "warehouse_id": wid}, headers=analyst
        )
    )
    assert item["forecast"]["id"] == run_id and len(item["forecast"]["points"]) == 30
    assert 10 < item["forecast"]["avg_daily_demand"] < 16 and len(item["history"]) == 120
    assert item["forecast"]["metrics"]["mae"] is not None
    listed = ok(await client.get(f"{API}/forecasts", headers=analyst))
    assert listed["items"][0]["id"] == run_id

    # 4. Stock risk analysis uses the stored forecast.
    risks = ok(await client.get(f"{API}/shortages", params={"min_risk": "HIGH"}, headers=analyst))["items"]
    risk = next(r for r in risks if r["product_id"] == pid and r["warehouse_id"] == wid)
    assert risk["demand_source"] == "FORECAST" and risk["forecast_run_id"] == run_id
    assert risk["risk_level"] == "CRITICAL"  # 60 units < ~90 units of demand during the 7-day lead time
    assert risk["demand_during_lead_time"] > risk["available_quantity"]

    # 5. A restocking recommendation is generated...
    recs = ok(await client.get(f"{API}/restocking", headers=buyer))["items"]
    rec = next(r for r in recs if r["product_id"] == pid)
    assert rec["recommended_quantity"] > 0 and rec["supplier_id"] == m["supplier"]["id"]
    expected = rec["order_up_to_level"] - rec["inventory_position"]
    assert rec["recommended_quantity"] == pytest.approx(expected, abs=1)

    # ...and turning it into a PO removes the duplicate recommendation.
    created = ok(
        await client.post(
            f"{API}/restocking/purchase-orders",
            json={
                "items": [{"product_id": pid, "warehouse_id": wid, "quantity": rec["recommended_quantity"]}]
            },
            headers=buyer,
        ),
        201,
    )
    assert len(created["purchase_order_ids"]) == 1
    recs_after = ok(await client.get(f"{API}/restocking", headers=buyer))["items"]
    assert not [r for r in recs_after if r["product_id"] == pid]
    risk_after = next(
        r
        for r in ok(await client.get(f"{API}/shortages", params={"min_risk": "NONE"}, headers=buyer))["items"]
        if r["product_id"] == pid
    )
    assert risk_after["inbound_quantity"] == rec["recommended_quantity"]


async def test_workflow_3_transfer_between_warehouses(client, auth) -> None:
    from app.core.security import Role

    admin, wh = auth(Role.ADMIN), auth(Role.WAREHOUSE_MANAGER)
    m = await setup_master_data(client, admin)
    pid, a, b = m["product"]["id"], m["wa"]["id"], m["wb"]["id"]
    ok(
        await client.post(
            f"{API}/inventory/receive",
            json={"product_id": pid, "warehouse_id": a, "quantity": 100},
            headers=wh,
        )
    )
    res = ok(
        await client.post(
            f"{API}/inventory/transfer",
            json={
                "product_id": pid,
                "from_warehouse_id": a,
                "to_warehouse_id": b,
                "quantity": 35,
                "reference": "TRF-1",
            },
            headers=wh,
        )
    )
    assert {t["type"] for t in res["transactions"]} == {"TRANSFER_OUT", "TRANSFER_IN"}
    assert (await stock(client, wh, pid, a))["quantity_on_hand"] == 65
    assert (await stock(client, wh, pid, b))["quantity_on_hand"] == 35


async def test_workflow_4_reserve_and_release(client, auth) -> None:
    from app.core.security import Role

    h = auth(Role.INVENTORY_MANAGER)
    m = await setup_master_data(client, auth(Role.ADMIN))
    body = {"product_id": m["product"]["id"], "warehouse_id": m["wa"]["id"]}
    ok(await client.post(f"{API}/inventory/receive", json={**body, "quantity": 40}, headers=h))
    r = ok(
        await client.post(
            f"{API}/inventory/reserve", json={**body, "quantity": 15, "reference": "SO-9"}, headers=h
        )
    )
    assert (r["items"][0]["available_quantity"], r["items"][0]["reserved_quantity"]) == (25, 15)
    r = ok(await client.post(f"{API}/inventory/release", json={**body, "quantity": 15}, headers=h))
    assert (r["items"][0]["available_quantity"], r["items"][0]["reserved_quantity"]) == (40, 0)
    assert r["items"][0]["quantity_on_hand"] == 40


async def test_recording_a_sale_issues_stock_atomically(client, auth) -> None:
    from app.core.security import Role

    h = auth(Role.WAREHOUSE_MANAGER)
    m = await setup_master_data(client, auth(Role.ADMIN))
    body = {"product_id": m["product"]["id"], "warehouse_id": m["wa"]["id"]}
    ok(await client.post(f"{API}/inventory/receive", json={**body, "quantity": 5}, headers=h))
    sale = ok(
        await client.post(f"{API}/sales", json={**body, "quantity": 3, "order_reference": "SO-1"}, headers=h),
        201,
    )
    assert sale["unit_price"] == "1.20" and sale["revenue"] == "3.60"
    assert (await stock(client, h, *body.values()))["quantity_on_hand"] == 2
    # Insufficient stock: neither the sale nor the stock movement is recorded.
    r = await client.post(f"{API}/sales", json={**body, "quantity": 3, "order_reference": "SO-2"}, headers=h)
    assert r.status_code == 422 and r.json()["error"]["code"] == "INSUFFICIENT_STOCK"
    assert ok(await client.get(f"{API}/sales", headers=h))["total"] == 1


async def test_open_po_arriving_after_stockout_is_still_a_risk(client, auth) -> None:
    """A big inbound PO doesn't hide a stock-out that happens before it is delivered."""
    from datetime import UTC, datetime, timedelta

    from app.core.security import Role

    h = auth(Role.ADMIN)
    m = await setup_master_data(client, h)
    pid, wid = m["product"]["id"], m["wa"]["id"]
    ok(
        await client.post(
            f"{API}/inventory/receive",
            json={"product_id": pid, "warehouse_id": wid, "quantity": 30},
            headers=h,
        )
    )
    today = datetime.now(UTC).date()
    for i in range(1, 61):  # 10 units/day
        ok(
            await client.post(
                f"{API}/sales",
                json={
                    "product_id": pid,
                    "warehouse_id": wid,
                    "quantity": 10,
                    "order_reference": f"H{i}",
                    "issue_stock": False,
                    "sold_at": f"{today - timedelta(days=i)}T12:00:00Z",
                },
                headers=h,
            ),
            201,
        )
    # Large PO, confirmed, but only due in 6 days; 30 units last ~3 days.
    po = ok(
        await client.post(
            f"{API}/purchase-orders",
            json={
                "supplier_id": m["supplier"]["id"],
                "warehouse_id": wid,
                "expected_delivery_date": str(today + timedelta(days=6)),
                "lines": [{"product_id": pid, "quantity_ordered": 1000}],
            },
            headers=h,
        ),
        201,
    )
    for s in ("SUBMITTED", "CONFIRMED"):
        ok(await client.post(f"{API}/purchase-orders/{po['id']}/status", json={"status": s}, headers=h))
    risk = next(
        r
        for r in ok(await client.get(f"{API}/shortages", params={"min_risk": "NONE"}, headers=h))["items"]
        if r["product_id"] == pid and r["warehouse_id"] == wid
    )
    assert risk["stockout_before_inbound"] is True
    assert risk["risk_level"] in {"HIGH", "CRITICAL"}
    assert "before the next delivery" in risk["reason"]
    # ...but no duplicate reorder is recommended: the inbound covers future demand.
    assert not [
        r for r in ok(await client.get(f"{API}/restocking", headers=h))["items"] if r["product_id"] == pid
    ]


async def test_min_stock_is_a_floor_for_status_and_reorder_point(client, auth) -> None:
    """The product's minimum stock threshold makes stock CRITICAL and triggers reordering
    even when there is no demand history and safety stock / reorder point are lower."""
    from app.core.security import Role

    h = auth(Role.ADMIN)
    m = await setup_master_data(client, h)
    pid, wid = m["product"]["id"], m["wa"]["id"]
    ok(
        await client.patch(
            f"{API}/products/{pid}", json={"min_stock": 80, "safety_stock": 5, "reorder_point": 10}, headers=h
        )
    )
    ok(
        await client.post(
            f"{API}/inventory/receive",
            json={"product_id": pid, "warehouse_id": wid, "quantity": 60},
            headers=h,
        )
    )
    item = ok(
        await client.get(f"{API}/inventory", params={"product_id": pid, "warehouse_id": wid}, headers=h)
    )
    assert item["items"][0]["status"] == "CRITICAL"  # 60 <= min_stock 80
    rec = next(
        r for r in ok(await client.get(f"{API}/restocking", headers=h))["items"] if r["product_id"] == pid
    )
    assert rec["reorder_point"] == 80 and rec["recommended_quantity"] == 21  # up to ROP+1 with no demand
    # Ordering the recommendation clears it: no churn of 1-unit follow-up recommendations.
    ok(
        await client.post(
            f"{API}/restocking/purchase-orders",
            json={
                "items": [{"product_id": pid, "warehouse_id": wid, "quantity": rec["recommended_quantity"]}]
            },
            headers=h,
        ),
        201,
    )
    assert not [
        r for r in ok(await client.get(f"{API}/restocking", headers=h))["items"] if r["product_id"] == pid
    ]
