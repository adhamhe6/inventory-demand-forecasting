"""Failure scenarios, authorization, idempotency and resilience at the API level."""

import io

import pytest
from sqlalchemy.exc import OperationalError

from app.core.security import Role

from .helpers import err, ok, setup_master_data

pytestmark = pytest.mark.e2e
API = "/api/v1"


async def test_health_and_docs(client) -> None:
    assert ok(await client.get("/health")) == {"status": "ok"}
    ready = ok(await client.get("/health/ready"))
    assert ready["checks"] == {"database": "ok", "redis": "ok"}
    spec = ok(await client.get("/openapi.json"))
    assert "/api/v1/purchase-orders/{po_id}/receive" in spec["paths"]
    assert (await client.get("/docs")).status_code == 200


async def test_login_flow_and_bad_credentials(client, users) -> None:
    r = ok(
        await client.post(
            f"{API}/auth/login", json={"email": "ADMIN@test.example", "password": "Password123!"}
        )
    )
    assert r["token_type"] == "bearer" and r["user"]["role"] == "ADMIN" and "password_hash" not in r["user"]
    me = ok(await client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {r['access_token']}"}))
    assert me["email"] == "admin@test.example"
    err(
        await client.post(f"{API}/auth/login", json={"email": "admin@test.example", "password": "nope"}),
        401,
        "INVALID_CREDENTIALS",
    )
    err(
        await client.post(f"{API}/auth/login", json={"email": "ghost@test.example", "password": "nope"}),
        401,
        "INVALID_CREDENTIALS",
    )


async def test_login_is_rate_limited(client, users, monkeypatch) -> None:
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "login_rate_limit_attempts", 3)
    for _ in range(3):
        err(
            await client.post(f"{API}/auth/login", json={"email": "admin@test.example", "password": "x"}), 401
        )
    err(
        await client.post(f"{API}/auth/login", json={"email": "admin@test.example", "password": "x"}),
        429,
        "RATE_LIMITED",
    )


async def test_unauthenticated_and_invalid_tokens(client, users) -> None:
    err(await client.get(f"{API}/products"), 401, "UNAUTHORIZED")
    err(await client.get(f"{API}/products", headers={"Authorization": "Bearer not.a.jwt"}), 401)
    err(await client.get(f"{API}/products", headers={"Authorization": "Basic abc"}), 401)


async def test_deactivated_user_token_is_rejected(client, auth, users) -> None:
    h = auth(Role.ANALYST)
    ok(await client.get(f"{API}/products", headers=h))
    ok(
        await client.patch(
            f"{API}/users/{users[Role.ANALYST].id}", json={"is_active": False}, headers=auth(Role.ADMIN)
        )
    )
    err(await client.get(f"{API}/products", headers=h), 401)


async def test_user_patch_guards(client, auth, users) -> None:
    admin = users[Role.ADMIN].id
    analyst = users[Role.ANALYST].id
    h = auth(Role.ADMIN)
    # Explicit nulls are a validation error, not a NOT NULL violation surfacing as 409.
    for field in ("full_name", "role", "is_active"):
        err(
            await client.patch(f"{API}/users/{analyst}", json={field: None}, headers=h),
            422,
            "VALIDATION_ERROR",
        )
    # An admin cannot lock themselves out.
    err(await client.patch(f"{API}/users/{admin}", json={"is_active": False}, headers=h), 422, "SELF_LOCKOUT")
    err(await client.patch(f"{API}/users/{admin}", json={"role": "ANALYST"}, headers=h), 422, "SELF_LOCKOUT")
    assert (
        ok(await client.patch(f"{API}/users/{admin}", json={"full_name": "Root"}, headers=h))["role"]
        == "ADMIN"
    )


@pytest.mark.parametrize(
    ("role", "method", "path", "body"),
    [
        (Role.ANALYST, "post", "/products", {"sku": "X1", "name": "x", "cost": "1", "price": "1"}),
        (
            Role.WAREHOUSE_MANAGER,
            "post",
            "/purchase-orders",
            {"supplier_id": 1, "warehouse_id": 1, "lines": [{"product_id": 1, "quantity_ordered": 1}]},
        ),
        (
            Role.PURCHASING_MANAGER,
            "post",
            "/inventory/adjust",
            {"product_id": 1, "warehouse_id": 1, "quantity_change": 1, "note": "abc"},
        ),
        (Role.ANALYST, "post", "/inventory/receive", {"product_id": 1, "warehouse_id": 1, "quantity": 1}),
        (Role.INVENTORY_MANAGER, "get", "/users", None),
        (Role.INVENTORY_MANAGER, "delete", "/products/1", None),
        (Role.WAREHOUSE_MANAGER, "post", "/forecasts/run", {"product_id": 1, "warehouse_id": 1}),
    ],
)
async def test_role_based_authorization(client, auth, role, method, path, body) -> None:
    kwargs = {"headers": auth(role)}
    if body is not None:
        kwargs["json"] = body
    err(await getattr(client, method)(f"{API}{path}", **kwargs), 403, "FORBIDDEN")


async def test_validation_errors_are_structured(client, auth) -> None:
    body = err(
        await client.post(
            f"{API}/products", json={"sku": "!", "name": "", "cost": "-1", "price": "abc"}, headers=auth()
        ),
        422,
        "VALIDATION_ERROR",
    )
    fields = {d["field"] for d in body["error"]["details"]}
    assert {"sku", "name", "cost", "price"} <= fields
    err(
        await client.get(f"{API}/products", params={"sort": "password_hash"}, headers=auth()),
        400,
        "INVALID_SORT",
    )
    err(await client.get(f"{API}/products", params={"page_size": 1000}, headers=auth()), 422)


async def test_duplicate_sku_and_warehouse_code(client, auth) -> None:
    h = auth()
    await setup_master_data(client, h)
    err(
        await client.post(
            f"{API}/products", json={"sku": "BOLT-M8", "name": "dup", "cost": "1", "price": "1"}, headers=h
        ),
        409,
        "DUPLICATE",
    )
    err(
        await client.post(f"{API}/warehouses", json={"code": "WH-EAST", "name": "dup"}, headers=h),
        409,
        "DUPLICATE",
    )


async def test_invalid_references(client, auth) -> None:
    h = auth()
    m = await setup_master_data(client, h)
    err(
        await client.post(
            f"{API}/inventory/receive",
            json={"product_id": 999, "warehouse_id": m["wa"]["id"], "quantity": 1},
            headers=h,
        ),
        404,
        "PRODUCT_NOT_FOUND",
    )
    err(
        await client.post(
            f"{API}/inventory/receive",
            json={"product_id": m["product"]["id"], "warehouse_id": 999, "quantity": 1},
            headers=h,
        ),
        404,
        "WAREHOUSE_NOT_FOUND",
    )
    err(
        await client.post(
            f"{API}/purchase-orders",
            json={
                "supplier_id": m["supplier"]["id"],
                "warehouse_id": m["wa"]["id"],
                "lines": [{"product_id": 999, "quantity_ordered": 1}],
            },
            headers=h,
        ),
        422,
        "INVALID_REFERENCE",
    )
    err(
        await client.post(
            f"{API}/products",
            json={"sku": "NEW-1", "name": "x", "cost": "1", "price": "1", "supplier_id": 999},
            headers=h,
        ),
        422,
        "INVALID_REFERENCE",
    )
    err(await client.get(f"{API}/products/999", headers=h), 404)


async def test_insufficient_stock_and_invalid_transfer(client, auth) -> None:
    h = auth()
    m = await setup_master_data(client, h)
    body = {"product_id": m["product"]["id"], "warehouse_id": m["wa"]["id"]}
    ok(await client.post(f"{API}/inventory/receive", json={**body, "quantity": 5}, headers=h))
    e = err(
        await client.post(f"{API}/inventory/issue", json={**body, "quantity": 6}, headers=h),
        422,
        "INSUFFICIENT_STOCK",
    )
    assert e["error"]["details"]["available"] == 5
    err(
        await client.post(
            f"{API}/inventory/transfer",
            json={
                "product_id": body["product_id"],
                "from_warehouse_id": m["wa"]["id"],
                "to_warehouse_id": m["wa"]["id"],
                "quantity": 1,
            },
            headers=h,
        ),
        422,
        "VALIDATION_ERROR",
    )
    err(
        await client.post(
            f"{API}/inventory/transfer",
            json={
                "product_id": body["product_id"],
                "from_warehouse_id": m["wb"]["id"],
                "to_warehouse_id": m["wa"]["id"],
                "quantity": 1,
            },
            headers=h,
        ),
        422,
        "INSUFFICIENT_STOCK",
    )
    # inactive warehouse cannot take stock
    ok(await client.patch(f"{API}/warehouses/{m['wb']['id']}", json={"status": "INACTIVE"}, headers=h))
    err(
        await client.post(
            f"{API}/inventory/transfer",
            json={
                "product_id": body["product_id"],
                "from_warehouse_id": m["wa"]["id"],
                "to_warehouse_id": m["wb"]["id"],
                "quantity": 1,
            },
            headers=h,
        ),
        422,
        "WAREHOUSE_INACTIVE",
    )


async def test_invalid_po_transition_and_duplicate_receiving(client, auth) -> None:
    h = auth()
    m = await setup_master_data(client, h)
    po = ok(
        await client.post(
            f"{API}/purchase-orders",
            json={
                "supplier_id": m["supplier"]["id"],
                "warehouse_id": m["wa"]["id"],
                "lines": [{"product_id": m["product"]["id"], "quantity_ordered": 10}],
            },
            headers=h,
        ),
        201,
    )
    err(
        await client.post(f"{API}/purchase-orders/{po['id']}/status", json={"status": "RECEIVED"}, headers=h),
        409,
        "INVALID_STATE_TRANSITION",
    )
    err(
        await client.post(f"{API}/purchase-orders/{po['id']}/receive", json={}, headers=h),
        409,
        "INVALID_STATE_TRANSITION",
    )
    for s in ("SUBMITTED", "CONFIRMED"):
        ok(await client.post(f"{API}/purchase-orders/{po['id']}/status", json={"status": s}, headers=h))
    first = ok(
        await client.post(
            f"{API}/purchase-orders/{po['id']}/receive", json={"receipt_reference": "DN-9"}, headers=h
        )
    )
    again = ok(
        await client.post(
            f"{API}/purchase-orders/{po['id']}/receive", json={"receipt_reference": "DN-9"}, headers=h
        )
    )
    assert again["replayed"] and again["receipt"]["id"] == first["receipt"]["id"]
    inv = ok(await client.get(f"{API}/inventory", params={"product_id": m["product"]["id"]}, headers=h))
    assert inv["items"][0]["quantity_on_hand"] == 10  # received once
    err(
        await client.post(
            f"{API}/purchase-orders/{po['id']}/receive", json={"receipt_reference": "DN-10"}, headers=h
        ),
        409,
    )
    err(await client.delete(f"{API}/purchase-orders/{po['id']}", headers=h), 409)


async def test_idempotency_key_replays_stock_operation(client, auth) -> None:
    h = auth()
    m = await setup_master_data(client, h)
    body = {"product_id": m["product"]["id"], "warehouse_id": m["wa"]["id"], "quantity": 7}
    key = {**h, "Idempotency-Key": "4f8c2d7e-receive-1"}
    r1 = await client.post(f"{API}/inventory/receive", json=body, headers=key)
    r2 = await client.post(f"{API}/inventory/receive", json=body, headers=key)
    assert r1.json() == r2.json() and r2.headers.get("Idempotent-Replayed") == "true"
    inv = ok(await client.get(f"{API}/inventory", params={"product_id": body["product_id"]}, headers=h))
    assert inv["items"][0]["quantity_on_hand"] == 7
    err(
        await client.post(f"{API}/inventory/receive", json={**body, "quantity": 8}, headers=key),
        409,
        "IDEMPOTENCY_KEY_REUSED",
    )


async def test_malformed_csv_import_fails_job_with_reason(client, auth) -> None:
    h = auth(Role.ANALYST)
    files = {"file": ("x.csv", io.BytesIO(b"foo,bar\n1,2\n"), "text/csv")}
    job = ok(await client.post(f"{API}/sales/import", files=files, headers=h), 202)
    job = ok(await client.get(f"{API}/jobs/{job['id']}", headers=h))
    assert job["status"] == "FAILED" and "missing required column" in job["error"]
    err(
        await client.post(
            f"{API}/sales/import", files={"file": ("x.txt", io.BytesIO(b"a"), "text/plain")}, headers=h
        ),
        400,
        "INVALID_FILE_TYPE",
    )
    err(
        await client.post(
            f"{API}/sales/import", files={"file": ("e.csv", io.BytesIO(b""), "text/csv")}, headers=h
        ),
        400,
        "EMPTY_FILE",
    )


async def test_product_delete_rules(client, auth) -> None:
    h = auth()
    m = await setup_master_data(client, h)
    ok(
        await client.post(
            f"{API}/inventory/receive",
            json={"product_id": m["product"]["id"], "warehouse_id": m["wa"]["id"], "quantity": 1},
            headers=h,
        )
    )
    err(await client.delete(f"{API}/products/{m['product']['id']}", headers=h), 409, "PRODUCT_IN_USE")
    fresh = ok(
        await client.post(
            f"{API}/products", json={"sku": "TMP-1", "name": "tmp", "cost": "1", "price": "2"}, headers=h
        ),
        201,
    )
    assert (await client.delete(f"{API}/products/{fresh['id']}", headers=h)).status_code == 204


async def test_database_failure_returns_503(client, auth) -> None:
    from app.db.database import session_scope
    from app.main import app

    async def broken():
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))
        yield  # pragma: no cover

    app.dependency_overrides[session_scope] = broken
    try:
        body = err(await client.get(f"{API}/products", headers=auth()), 503, "DATABASE_UNAVAILABLE")
        assert "connection refused" not in body["error"]["message"]  # no internals leaked
    finally:
        app.dependency_overrides.clear()


async def test_api_keeps_working_when_redis_is_down(client, auth) -> None:
    from redis.asyncio import Redis

    from app.cache.redis_cache import Cache, get_cache, set_cache

    h = auth()
    m = await setup_master_data(client, h)
    original = get_cache()
    set_cache(Cache(Redis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.2)))
    try:
        ok(await client.get(f"{API}/reports/dashboard", headers=h))
        ok(
            await client.post(
                f"{API}/inventory/receive",
                json={"product_id": m["product"]["id"], "warehouse_id": m["wa"]["id"], "quantity": 3},
                headers=h,
            )
        )
        ok(await client.get(f"{API}/shortages", headers=h))
    finally:
        set_cache(original)


async def test_unexpected_errors_are_safe(client, auth, monkeypatch) -> None:
    from app.services.catalog import CatalogService

    async def boom(*a, **k):
        raise RuntimeError("secret internal detail")

    monkeypatch.setattr(CatalogService, "list_suppliers", boom)
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    async with AsyncClient(
        transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://t"
    ) as c:
        r = await c.get(f"{API}/suppliers", headers=auth())
    body = err(r, 500, "INTERNAL_ERROR")
    assert "secret" not in r.text and body["request_id"]


async def test_successful_logins_do_not_consume_the_rate_limit(client, users, monkeypatch) -> None:
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "login_rate_limit_attempts", 2)
    for _ in range(10):  # many users behind one NAT / repeated sign-ins
        ok(
            await client.post(
                f"{API}/auth/login", json={"email": "admin@test.example", "password": "Password123!"}
            )
        )


async def test_oauth2_token_endpoint_for_swagger(client, users) -> None:
    r = ok(
        await client.post(
            f"{API}/auth/token", data={"username": "admin@test.example", "password": "Password123!"}
        )
    )
    me = ok(await client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {r['access_token']}"}))
    assert me["role"] == "ADMIN"
    err(
        await client.post(f"{API}/auth/token", data={"username": "admin@test.example", "password": "bad"}),
        401,
    )
    spec = ok(await client.get("/openapi.json"))
    scheme = next(iter(spec["components"]["securitySchemes"].values()))
    assert scheme["type"] == "oauth2" and scheme["flows"]["password"]["tokenUrl"] == "/api/v1/auth/token"


async def test_meta_endpoint_is_public_and_non_sensitive(client) -> None:
    meta = ok(await client.get(f"{API}/meta"))
    assert set(meta) == {
        "app_name",
        "version",
        "environment",
        "demo_mode",
        "max_import_file_mb",
        "forecast_interval_level",
        "restock_review_period_days",
    }
    assert meta["forecast_interval_level"] == 0.8 and meta["max_import_file_mb"] > 0
    assert "secret" not in str(meta).lower() and "password" not in str(meta).lower()
