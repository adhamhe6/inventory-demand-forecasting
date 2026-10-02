"""Live checks against a running Docker Compose stack with the demo seed. Prints PASS/FAIL per check.

    API_URL=http://localhost:8000 python scripts/verify/live_checks.py

Needs: httpx, docker compose (run from anywhere; it uses this repo's compose project), the demo
seed (demo accounts) and FIRST_ADMIN_* = the .env.example defaults. It writes data (stock moves,
a PO, imported sales, forecast jobs), so run it against a demo stack, never production.
"""

import os
import pathlib
import subprocess
import sys
import time
import uuid

import httpx

API = os.environ.get("API_URL", "http://localhost:8000")
B = f"{API}/api/v1"
ROOT = str(pathlib.Path(__file__).resolve().parents[2])
results = []


def check(name, cond, info=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""), flush=True)


def redis(*args):
    return subprocess.run(
        ["docker", "compose", "exec", "-T", "redis", "redis-cli", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    ).stdout.strip()


def sql(q):
    return subprocess.run(
        [
            "docker",
            "compose",
            "exec",
            "-T",
            "postgres",
            "psql",
            "-U",
            "inventory",
            "-d",
            "inventory",
            "-tAc",
            q,
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    ).stdout.strip()


c = httpx.Client(base_url=B, timeout=60)


def login(email, pw="DemoPass123!"):
    r = c.post("/auth/login", json={"email": email, "password": pw})
    r.raise_for_status()
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


ADMIN = login("admin@example.com", "ChangeMe123!")
WH = login("warehouse@demo.example")
PUR = login("purchasing@demo.example")
AN = login("analyst@demo.example")
INV = login("inventory@demo.example")

# ---------- health / meta / swagger ----------
check("health ready", c.get(f"{API}/health/ready").status_code == 200)
m = c.get("/meta").json()
check(
    "meta public & non-sensitive",
    m["demo_mode"] is True and not any(k in str(m).lower() for k in ("secret", "password", "database_url")),
    m,
)
r = c.post("/auth/token", data={"username": "analyst@demo.example", "password": "DemoPass123!"})
check("oauth2 /auth/token form login", r.status_code == 200 and r.json()["token_type"].lower() == "bearer")
check(
    "openapi declares OAuth2 password flow",
    "password" in str(c.get(f"{API}/openapi.json").json()["components"]["securitySchemes"]),
)

# ---------- authz matrix ----------
item = c.get("/inventory", params={"page_size": 200, "sort": "-quantity_on_hand"}, headers=ADMIN).json()[
    "items"
][0]
pid, wid = item["product_id"], item["warehouse_id"]
mv = {"product_id": pid, "warehouse_id": wid, "quantity": 1}
matrix = [
    ("anon GET /inventory", lambda: c.get("/inventory"), 401),
    ("bad token", lambda: c.get("/inventory", headers={"Authorization": "Bearer x.y.z"}), 401),
    ("analyst issue", lambda: c.post("/inventory/issue", json=mv, headers=AN), 403),
    (
        "analyst create PO",
        lambda: c.post(
            "/purchase-orders",
            json={
                "supplier_id": 1,
                "warehouse_id": wid,
                "lines": [{"product_id": pid, "quantity_ordered": 1}],
            },
            headers=AN,
        ),
        403,
    ),
    ("warehouse list users", lambda: c.get("/users", headers=WH), 403),
    (
        "purchasing adjust stock",
        lambda: c.post("/inventory/adjust", json={**mv, "quantity_delta": 1, "reason": "x"}, headers=PUR),
        403,
    ),
    (
        "inventory mgr create user",
        lambda: c.post(
            "/users",
            json={"email": "z@z.example", "full_name": "Z", "password": "Abcdefgh12", "role": "ADMIN"},
            headers=INV,
        ),
        403,
    ),
    ("analyst reads reports", lambda: c.get("/reports/dashboard", headers=AN), 200),
    ("analyst reads restocking", lambda: c.get("/restocking", headers=AN), 200),
]
for name, fn, want in matrix:
    r = fn()
    check(f"authz: {name} -> {want}", r.status_code == want, r.status_code)

# ---------- malformed input ----------
bad = [
    (
        "non-JSON body",
        lambda: c.post(
            "/inventory/issue", content=b"{not json", headers={**WH, "Content-Type": "application/json"}
        ),
        422,
    ),
    ("negative qty", lambda: c.post("/inventory/issue", json={**mv, "quantity": -5}, headers=WH), 422),
    ("page_size too big", lambda: c.get("/inventory", params={"page_size": 10_000}, headers=AN), 422),
    ("sort injection", lambda: c.get("/inventory", params={"sort": "id;DROP TABLE users"}, headers=AN), 400),
    (
        "unknown product",
        lambda: c.post("/inventory/issue", json={**mv, "product_id": 999999}, headers=WH),
        404,
    ),
    ("over-issue", lambda: c.post("/inventory/issue", json={**mv, "quantity": 1_000_000}, headers=WH), 422),
    (
        "bad forecast model",
        lambda: c.post(
            "/forecasts/run", json={"product_id": pid, "warehouse_id": wid, "model": "magic"}, headers=AN
        ),
        422,
    ),
    ("restocking bad sort", lambda: c.get("/restocking", params={"sort": "password"}, headers=AN), 400),
]
for name, fn, want in bad:
    r = fn()
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    check(
        f"input: {name} -> {want}",
        r.status_code == want and "error" in body and "request_id" in body,
        f"{r.status_code} {body.get('error', {}).get('code')}",
    )

# ---------- Idempotency-Key replay + cache invalidation ----------
c.get("/reports/dashboard", headers=AN)
before_keys = int(redis("EVAL", "return #redis.call('keys','cache:v1:*')", "0") or 0)
v_before = int(redis("GET", "cache:ver:inventory") or 0)
oh_before = c.get(f"/inventory/{item['id']}", headers=AN).json()["quantity_on_hand"]
key = str(uuid.uuid4())
r1 = c.post(
    "/inventory/receive",
    json={**mv, "quantity": 7, "reference": "LIVE-IDEM"},
    headers={**WH, "Idempotency-Key": key},
)
r2 = c.post(
    "/inventory/receive",
    json={**mv, "quantity": 7, "reference": "LIVE-IDEM"},
    headers={**WH, "Idempotency-Key": key},
)
oh_after = c.get(f"/inventory/{item['id']}", headers=AN).json()["quantity_on_hand"]
check(
    "idempotency-key replay applies once",
    r1.status_code in (200, 201) and r2.json() == r1.json() and oh_after == oh_before + 7,
    f"{oh_before}->{oh_after}",
)
r3 = c.post("/inventory/receive", json={**mv, "quantity": 8}, headers={**WH, "Idempotency-Key": key})
check("idempotency-key reuse with different body -> 409/422", r3.status_code in (409, 422), r3.status_code)
check("cache keys populated", before_keys > 0, before_keys)
v_after = int(redis("GET", "cache:ver:inventory") or 0)
check("write bumps cache:ver:inventory", v_after > v_before, f"{v_before}->{v_after}")
d = c.get("/reports/dashboard", headers=AN).json()
check(
    "dashboard reflects new stock after invalidation",
    d["kpis"]["total_units"] == int(sql("select sum(quantity_on_hand) from inventory_items")),
    d["kpis"]["total_units"],
)


# cache miss -> hit, measured with Redis keyspace stats
def stat(k):
    lines = redis("INFO", "stats").splitlines()
    return int(next(line.split(":")[1] for line in lines if line.startswith(k + ":")))


redis("INCR", "cache:ver:inventory")  # invalidate as a write would
h0, m0 = stat("keyspace_hits"), stat("keyspace_misses")
t = time.perf_counter()
c.get("/restocking", headers=AN)
cold = time.perf_counter() - t
h1, m1 = stat("keyspace_hits"), stat("keyspace_misses")
t = time.perf_counter()
c.get("/restocking", headers=AN)
warm = time.perf_counter() - t
h2, m2 = stat("keyspace_hits"), stat("keyspace_misses")
ver = redis("GET", "cache:ver:inventory")
keys = redis("KEYS", f"cache:v1:replenishment:analysis:*inventory={ver}:*")
check(
    "after invalidation: first read recomputes + stores new-version key, second read hits",
    bool(keys) and h2 > h1 and warm < cold,
    f"misses +{m1 - m0}/+{m2 - m1} hits +{h2 - h1}; cold {cold * 1000:.0f}ms warm {warm * 1000:.0f}ms",
)
# ---------- reserve / release / transfer invariants ----------
wh2 = next(w["id"] for w in c.get("/warehouses", headers=AN).json()["items"] if w["id"] != wid)
c.post("/inventory/reserve", json={**mv, "quantity": 3}, headers=WH)
it = c.get(f"/inventory/{item['id']}", headers=AN).json()
r = c.post("/inventory/release", json={**mv, "quantity": it["reserved_quantity"] + 1}, headers=WH)
check(
    "release more than reserved -> 422 business rule",
    r.status_code == 422 and r.json()["error"]["code"] != "VALIDATION_ERROR",
    r.json()["error"]["code"],
)
r = c.post(
    "/inventory/transfer",
    json={"product_id": pid, "from_warehouse_id": wid, "to_warehouse_id": wh2, "quantity": 2},
    headers=WH,
)
check("transfer ok", r.status_code in (200, 201), r.text[:200])
snap = sql(
    f"select string_agg(quantity_on_hand::text, ',' order by warehouse_id) from inventory_items where product_id={pid}"
)
nled = sql("select count(*) from inventory_transactions")
r = c.post(
    "/inventory/transfer",
    json={"product_id": pid, "from_warehouse_id": wid, "to_warehouse_id": wh2, "quantity": 10**6},
    headers=WH,
)
check(
    "transfer over available -> 422 and nothing moved (atomic)",
    r.status_code == 422
    and snap
    == sql(
        f"select string_agg(quantity_on_hand::text, ',' order by warehouse_id) from inventory_items where product_id={pid}"
    )
    and nled == sql("select count(*) from inventory_transactions"),
    f"{r.status_code} {snap}",
)

# ---------- PO receive idempotency ----------
sup = c.get("/suppliers", headers=AN).json()["items"][0]["id"]
po = c.post(
    "/purchase-orders",
    json={"supplier_id": sup, "warehouse_id": wid, "lines": [{"product_id": pid, "quantity_ordered": 10}]},
    headers=PUR,
).json()
for s in ("SUBMITTED", "CONFIRMED"):
    c.post(f"/purchase-orders/{po['id']}/status", json={"status": s}, headers=PUR)
line = po["lines"][0]["id"]
oh0 = c.get(f"/inventory/{item['id']}", headers=AN).json()["quantity_on_hand"]
ra = c.post(
    f"/purchase-orders/{po['id']}/receive",
    json={"lines": [{"line_id": line, "quantity": 4}], "receipt_reference": "GRN-LIVE-1"},
    headers=WH,
)
rb = c.post(
    f"/purchase-orders/{po['id']}/receive",
    json={"lines": [{"line_id": line, "quantity": 4}], "receipt_reference": "GRN-LIVE-1"},
    headers=WH,
)
oh1 = c.get(f"/inventory/{item['id']}", headers=AN).json()["quantity_on_hand"]
check(
    "PO receipt replay with same GRN applies once",
    ra.status_code == 200 and rb.status_code == 200 and oh1 == oh0 + 4,
    f"{oh0}->{oh1} {ra.status_code}/{rb.status_code}",
)
r = c.post(
    f"/purchase-orders/{po['id']}/receive", json={"lines": [{"line_id": line, "quantity": 7}]}, headers=WH
)
check("over-receive -> 422 business rule", r.status_code == 422, r.json()["error"]["code"])
r = c.post(f"/purchase-orders/{po['id']}/status", json={"status": "DRAFT"}, headers=PUR)
check("illegal status transition rejected", r.status_code in (409, 422), r.status_code)
c.post(f"/purchase-orders/{po['id']}/receive", json={}, headers=WH)
check(
    "receive remaining -> RECEIVED",
    c.get(f"/purchase-orders/{po['id']}", headers=AN).json()["status"] == "RECEIVED",
)


# ---------- CSV import job, re-upload dedupe, malformed failure ----------
def wait(job_id, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        j = c.get(f"/jobs/{job_id}", headers=AN).json()
        if j["status"] in ("SUCCEEDED", "FAILED"):
            return j
        time.sleep(1)
    return j


sku = item["sku"]
wcode = item["warehouse_code"]
RUN = uuid.uuid4().hex[:6]
csv = (
    "sku,warehouse_code,sold_at,quantity,order_reference,unit_price\n"
    + "".join(f"{sku},{wcode},2026-09-{d:02d}T10:00:00Z,1,LIVE-IMP-{RUN}-{d},9.99\n" for d in range(1, 6))
    + "NOPE,XX,bad-date,-1,,\n"
)


def up(body, name="s.csv"):
    return c.post("/sales/import", files={"file": (name, body, "text/csv")}, headers=INV)


j1 = wait(up(csv.encode()).json()["id"])
check("import job ran in worker", j1["status"] == "SUCCEEDED", j1.get("result"))
res = j1["result"] or {}
check(
    "import counts 5 inserted, 1 rejected row with reason",
    res.get("inserted") == 5 and res.get("invalid") == 1 and res["errors"][0]["line"] == 7,
    res,
)
j2 = wait(up(csv.encode()).json()["id"])
check(
    "re-import is idempotent (0 inserted, 5 duplicates)",
    (j2["result"] or {}).get("inserted") == 0 and (j2["result"] or {}).get("duplicates") == 5,
    j2.get("result"),
)
r = up(b"\x00\x01\x02binary", "x.csv")
jb = wait(r.json()["id"]) if r.status_code in (200, 201, 202) else None
check(
    "binary upload rejected (400 or FAILED job)",
    r.status_code == 400 or (jb and jb["status"] == "FAILED"),
    r.status_code if jb is None else jb["error"],
)
jh = wait(up(b"foo,bar\n1,2\n").json()["id"])
check("wrong header -> FAILED job with message", jh["status"] == "FAILED" and jh["error"], jh.get("error"))
r = up(b"a" * 10, "x.txt")
check("non-csv extension -> 400", r.status_code in (400, 415, 422), r.status_code)

# ---------- forecasting job dedupe + real results ----------
fa = c.post("/forecasts/run-all", json={"horizon_days": 30}, headers=AN)
fb = c.post("/forecasts/run-all", json={"horizon_days": 30}, headers=AN)
check(
    "run-all dedupes while active", fa.json()["id"] == fb.json()["id"], f"{fa.status_code}/{fb.status_code}"
)
jf = wait(fa.json()["id"], 600)
check("run-all job succeeded", jf["status"] == "SUCCEEDED", jf.get("result"))
passed = sum(ok for _, ok in results)
print("summary", passed, "/", len(results))
sys.exit(0 if passed == len(results) else 1)
