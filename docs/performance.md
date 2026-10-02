# Performance review

Measured on the seeded demo dataset (1 year: ~50k sales lines, ~51k ledger rows, 65 stocked
items, ~460 purchase orders) on PostgreSQL 16, using `EXPLAIN (ANALYZE, BUFFERS)` and timed
HTTP requests against the Docker stack.

## Key queries

| Query (where it's used) | Plan | Time |
|---|---|---|
| Daily demand history for one item, 365 days (forecast input) | Bitmap index scan on `ix_sales_product_wh_sold_at` (all three predicates in the index condition) | 2.2 ms |
| Ledger page for one item, newest first (inventory detail) | Index scan backward + `LIMIT 25` | 0.4 ms |
| Latest forecast per item (`DISTINCT ON`) (risk, restocking, reports) | Sort of ~130 rows in memory (runs pruned to 5 per item) | 0.3 ms |
| Sales in a rolling 60-day window (dashboard KPIs) | Index scan on `ix_sales_sold_at` | 2.9 ms |
| Ledger rows by reference (PO traceability, `?reference=`) | **before:** seq scan · **after migration 0002:** index scan on `ix_inventory_transactions_reference` | **6.6 ms → 0.06 ms** |

The reference lookup was the only query whose cost grew linearly with table size, so it is
the only index added after measurement (migration `0002`). Other candidate indexes were
rejected because the planner either already had a better access path or the tables are tiny.

## N+1 queries

All relationships are declared `lazy="raise"`, so a lazy load in request code raises instead
of silently issuing queries. Collections are loaded with explicit joins / `selectinload`.
`tests/e2e/test_query_counts.py` counts SQL statements per request with 3 rows vs 33 rows for
products, purchase orders, inventory, forecasts, restocking and shortages and asserts the
counts are identical (and ≤ 10).

## Caching

Median of 5 warm requests vs. first request after invalidation (Docker stack, local network):

| Endpoint | Cold | Cached |
|---|---|---|
| `GET /reports/dashboard` (≈10 aggregate queries) | 156 ms | 8 ms |
| `GET /restocking` | 59 ms | 10 ms |
| `GET /shortages` | 45 ms | 10 ms |
| `GET /reports/sales-summary?granularity=week` | 90 ms | 10 ms |

Shortages, restocking and the dashboard share one cached replenishment analysis, so the
expensive part is computed once per data change, not per screen.

## Forecasting cost

* Holt-Winters fit on 365 daily points: ~0.14 s; a full auto run (3 candidates × 3 backtest
  origins + refit) ≈ 0.5 s per item.
* `forecast_all` for 65 items: ~30 s in the worker. It runs off the request path, in a
  thread (`asyncio.to_thread`) so the worker event loop stays responsive, each item in its own
  transaction (one failure doesn't abort the batch), with progress reporting.
* Scaling: run more workers (`docker compose up --scale worker=N`); jobs are independent.

## Bulk import

The CSV import streams the upload to disk in 1 MB chunks and inserts in 1,000-row batches
(`INSERT … ON CONFLICT DO NOTHING RETURNING id`), so memory stays flat regardless of file size.
The seed uses PostgreSQL `COPY` for ~100k rows in a few seconds.

Measured on the Docker stack (2026-10-02): a 200,000-row / 12.3 MB CSV was imported through
`POST /sales/import` by the worker in **51 s** (all rows inserted, 0 invalid), worker memory
peaking at **~188 MiB**; re-importing the same rows inserts 0 and reports them as duplicates.
After the import (250k sales rows) `ANALYZE` + `EXPLAIN ANALYZE` of the hot paths:

| Query | Plan | Time |
|---|---|---|
| Daily history for one product × warehouse (forecast input) | Bitmap Index Scan `ix_sales_product_wh_sold_at` | 8.9 ms |
| Latest 25 sales of a product | Index Scan Backward `ix_sales_sold_at` | 0.6 ms |
| 28-day demand per item (fallback demand rate) | Bitmap Index Scan `ix_sales_sold_at` | 1.5 ms |
| Latest 25 ledger rows of an item | Index Scan Backward `ix_inventory_transactions_product_wh_created` | 0.2 ms |
| Sales in the last 30 days (dashboard KPI) | Index Only Scan `ix_sales_sold_at` | 1.2 ms |

`GET /reports/dashboard` answered in 111 ms uncached right after the import.

## Concurrency

Stock operations take row locks in a single statement ordered by id. Tests run 20 concurrent
issues (no overselling) and 20 concurrent opposite-direction transfers (no deadlocks).
