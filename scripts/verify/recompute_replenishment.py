"""Independent recomputation of replenishment numbers from raw SQL, compared with the API.

    API_URL=http://localhost:8000 python scripts/verify/recompute_replenishment.py

Re-derives d, D_L, ROP, inventory position, order-up-to level and recommended quantity for every
item with a stored forecast (formulas as documented in the README) and diffs them with
/shortages and /restocking. Read-only. Assumes the default 14-day review period.
"""

import json
import math
import os
import pathlib
import subprocess
import sys

import httpx

API = os.environ.get("API_URL", "http://localhost:8000")
ROOT = str(pathlib.Path(__file__).resolve().parents[2])


def sql(q):
    out = subprocess.run(
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
            f"select coalesce(json_agg(t),'[]') from ({q}) t",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    ).stdout
    return json.loads(out)


items = sql("""select i.id, i.product_id pid, i.warehouse_id wid, i.available_quantity avail,
  coalesce(i.safety_stock,p.safety_stock) ss, coalesce(i.reorder_point,p.reorder_point) srop, p.min_stock,
  coalesce(s.lead_time_days, p.lead_time_days) lead
  from inventory_items i join products p on p.id=i.product_id join warehouses w on w.id=i.warehouse_id
  left join suppliers s on s.id=p.supplier_id where p.is_active and w.status='ACTIVE'""")
inbound = {
    (r["pid"], r["wid"]): r["q"]
    for r in sql("""select l.product_id pid, po.warehouse_id wid, sum(l.quantity_ordered-l.quantity_received) q
  from purchase_order_lines l join purchase_orders po on po.id=l.purchase_order_id
  where po.status in ('DRAFT','SUBMITTED','CONFIRMED','PARTIALLY_RECEIVED') group by 1,2""")
}
pts = {}
for (
    r
) in sql("""select r.product_id pid, r.warehouse_id wid, array_agg(fp.predicted order by fp.forecast_date) pts
  from (select distinct on (product_id, warehouse_id) * from forecast_runs order by product_id, warehouse_id, generated_at desc, id desc) r
  join forecast_points fp on fp.run_id=r.id and fp.forecast_date >= (now() at time zone 'utc')::date group by 1,2"""):
    pts[(r["pid"], r["wid"])] = r["pts"]
c = httpx.Client(base_url=f"{API}/api/v1", timeout=60)
h = {
    "Authorization": "Bearer "
    + c.post("/auth/login", json={"email": "analyst@demo.example", "password": "DemoPass123!"}).json()[
        "access_token"
    ]
}
api = {}
page = 1
while True:
    b = c.get("/shortages", params={"min_risk": "NONE", "page_size": 200, "page": page}, headers=h).json()
    api.update({x["inventory_item_id"]: x for x in b["items"]})
    if page >= b["pages"]:
        break
    page += 1
recs = {
    x["inventory_item_id"]: x
    for x in c.get("/restocking", params={"page_size": 200}, headers=h).json()["items"]
}
mism, checked, fc = [], 0, 0
for it in items:
    k = (it["pid"], it["wid"])
    p = pts.get(k)
    if not p:
        continue  # historical-average fallback items: skip (different source)
    fc += 1
    d = sum(p) / len(p)
    L = it["lead"]
    dl = sum(p[:L]) + max(0, L - len(p)) * d
    rop = max(it["srop"], it["min_stock"], dl + it["ss"])
    S = rop + max(d * 14, 1.0)
    ip = it["avail"] + inbound.get(k, 0)
    qty = max(math.ceil(S - ip), 1) if ip <= rop else 0
    a = api.get(it["id"])
    checked += 1
    if a is None:
        mism.append((it["id"], "missing from /shortages"))
        continue
    for name, mine, theirs in (
        ("rop", round(rop, 2), a["reorder_point"]),
        ("D_L", round(dl, 2), a["demand_during_lead_time"]),
        ("d", round(d, 3), a["avg_daily_demand"]),
        ("IP", ip, a["available_quantity"] + a["inbound_quantity"]),
    ):
        if abs(mine - theirs) > 0.011:
            mism.append((it["id"], name, mine, theirs))
    got = recs.get(it["id"], {}).get("recommended_quantity", 0)
    if it["id"] in recs and abs(recs[it["id"]]["order_up_to_level"] - round(S, 2)) > 0.011:
        mism.append((it["id"], "S", round(S, 2), recs[it["id"]]["order_up_to_level"]))
    if got != qty:
        mism.append((it["id"], "qty", qty, got))
print(
    f"items with forecasts recomputed: {fc}/{len(items)}; restocking rows: {len(recs)}; mismatches: {len(mism)}"
)
for m in mism[:15]:
    print("  ", m)
sys.exit(1 if mism else 0)
