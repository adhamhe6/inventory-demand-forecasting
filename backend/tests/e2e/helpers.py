from typing import Any

from httpx import AsyncClient, Response


def ok(resp: Response, status: int = 200) -> Any:
    assert resp.status_code == status, f"{resp.status_code}: {resp.text}"
    return resp.json() if resp.content else None


def err(resp: Response, status: int, code: str | None = None) -> dict:
    assert resp.status_code == status, f"{resp.status_code}: {resp.text}"
    body = resp.json()
    assert set(body) == {"error", "request_id"} and {"code", "message", "details"} <= set(body["error"])
    if code:
        assert body["error"]["code"] == code, body
    return body


async def setup_master_data(client: AsyncClient, h: dict[str, str]) -> dict[str, Any]:
    supplier = ok(
        await client.post(
            "/api/v1/suppliers",
            json={
                "name": "Globex Components",
                "email": "orders@globex.example",
                "lead_time_days": 7,
                "payment_terms": "Net 30",
            },
            headers=h,
        ),
        201,
    )
    wa = ok(
        await client.post(
            "/api/v1/warehouses", json={"code": "wh-east", "name": "East DC", "location": "NYC"}, headers=h
        ),
        201,
    )
    wb = ok(
        await client.post("/api/v1/warehouses", json={"code": "WH-WEST", "name": "West DC"}, headers=h), 201
    )
    product = ok(
        await client.post(
            "/api/v1/products",
            json={
                "sku": "bolt-m8",
                "name": "Hex Bolt M8",
                "category": "Fasteners",
                "cost": "0.40",
                "price": "1.20",
                "reorder_point": 50,
                "safety_stock": 20,
                "lead_time_days": 7,
                "supplier_id": supplier["id"],
            },
            headers=h,
        ),
        201,
    )
    return {"supplier": supplier, "wa": wa, "wb": wb, "product": product}
