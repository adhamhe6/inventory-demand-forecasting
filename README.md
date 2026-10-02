# StockSense — Inventory Management & Demand Forecasting

A full-stack inventory platform for multi-warehouse businesses. It tracks stock, purchasing and sales, **forecasts demand from sales history**, detects **stock-out risk** from live stock + open purchase orders + supplier lead times, and turns that into **restocking recommendations** you can convert into purchase orders in one click.

```
Sales history ─► Forecast ─► Expected demand ─► Inventory position ─► Shortage risk ─► Restocking recommendation ─► Purchase order
```

| | |
|---|---|
| **Backend** | Python 3.11 · FastAPI · Pydantic v2 · SQLAlchemy 2 (async) · Alembic |
| **Data** | PostgreSQL 16 · Redis 7 |
| **Async jobs** | ARQ worker (Redis) with durable job status in PostgreSQL |
| **Forecasting** | pandas · NumPy · statsmodels (Holt-Winters) + Croston-SBA, rolling-origin backtesting |
| **Frontend** | React 19 · TypeScript · Tailwind v4 · Radix/shadcn-style UI · TanStack Query · React Hook Form + zod · Recharts |
| **Quality** | pytest (unit / integration / API e2e) · Vitest + Testing Library · Playwright · Ruff · mypy · oxlint · GitHub Actions |
| **Deploy** | Docker Compose: `postgres`, `redis`, `migrate`, `api`, `worker`, `web` (nginx) |

---

## Quick start

```bash
git clone <repo-url> inventory-demand-forecasting
cd inventory-demand-forecasting
cp .env.example .env          # then set SECRET_KEY to a long random value
docker compose up --build
```

| What | URL |
|---|---|
| Web app | http://localhost:8080 |
| Swagger UI | http://localhost:8000/docs (also proxied at http://localhost:8080/docs) |
| ReDoc | http://localhost:8000/redoc |
| Health | http://localhost:8000/health · readiness: `/health/ready` |

On first start the one-shot **`migrate`** service runs `alembic upgrade head`, creates the first admin (`FIRST_ADMIN_EMAIL` / `FIRST_ADMIN_PASSWORD`) and — with `SEED_DEMO_DATA=true` (the default in `.env.example`) — generates a year of realistic demo data and forecasts (~40 s). `api` and `worker` only start after it completes successfully; every service has a health check.

**Logins.** The bootstrap admin is `FIRST_ADMIN_EMAIL` / `FIRST_ADMIN_PASSWORD` from `.env` (`admin@example.com` / `ChangeMe123!` in `.env.example`). With demo data, one account per role is seeded with password `DemoPass123!`: `admin@`, `inventory@`, `warehouse@`, `purchasing@` and `analyst@demo.example`. The login page offers these one-click demo accounts only when the server reports demo mode (`GET /api/v1/meta`).

**Swagger:** click *Authorize* and enter an email/password (OAuth2 password flow via `POST /auth/token`).

> Behind a TLS-intercepting corporate proxy, image builds need its CA: `docker build --secret id=ca_bundle,src=/path/ca.pem …` (optional BuildKit secret, ignored when absent).

### Common commands

```bash
docker compose exec api alembic upgrade head                     # run migrations
docker compose exec api alembic revision --autogenerate -m "..." # new migration (review it!)
docker compose exec api python -m app.scripts.seed --reset       # re-seed demo data (wipes business data)
docker compose exec api python -m app.scripts.seed --reset --skip-forecasts
docker compose logs -f worker                                    # background job logs
docker compose up -d --scale worker=3                            # more workers
```

---

## Architecture

```mermaid
flowchart LR
    U[Browser<br/>React SPA] -->|HTTPS| N[nginx<br/>static SPA + reverse proxy]
    N -->|/api| A[FastAPI<br/>uvicorn x2]
    A -->|asyncpg| P[(PostgreSQL)]
    A -->|cache · rate limit · enqueue| R[(Redis)]
    W[ARQ worker<br/>forecasting · CSV import · nightly cron] -->|dequeue| R
    W -->|asyncpg| P
    M[migrate<br/>one-shot] -->|alembic + bootstrap| P
```

```
backend/app
├── api/            HTTP layer: routes (thin), dependencies (auth, pagination), CSV export
├── core/           config (env), security (JWT, Argon2, RBAC matrix), logging, error types
├── db/             engine/session, SQLAlchemy models (constraints live here), Alembic migrations
├── schemas/        Pydantic request/response models — the public API contract
├── services/       business logic + transaction boundaries (inventory, purchasing, sales,
│                   forecasting, replenishment, reports, jobs, users)
├── forecasting/    pure, DB-free pipeline: preprocessing, models, metrics, backtest/selection
├── workers/        ARQ settings, job implementations, dispatchers (arq | inline)
├── cache/          versioned-namespace Redis cache + rate limiter (fail-open)
└── scripts/        bootstrap (first admin, demo seed), simulation-based seed
frontend/src
├── api/            TanStack Query keys & shared hooks
├── components/     ui/ (design-system primitives), common/ (tables, states, badges), layout/
├── lib/            typed fetch client, auth context, URL-state hook, formatting
└── pages/          one module per screen
e2e/                Playwright browser tests (run against the Docker stack)
```

**Request lifecycle:** route validates input (Pydantic) → dependency resolves the user and checks the role's permission → service runs the business operation inside one DB transaction → commit → Redis cache domains are invalidated *after* commit → response model serialises the result. Errors raised anywhere are mapped centrally to one JSON shape.

There is intentionally **no separate repository layer**: the SQLAlchemy `AsyncSession` already is a unit of work + identity map, so services own their queries. Every relationship is `lazy="raise"`, which turns any accidental N+1 lazy load into an immediate error during development; data is loaded explicitly with joins / `selectinload`.

---

## Features

- **Inventory** per product × warehouse: on hand, reserved, available (generated column), effective safety stock / reorder point (per-warehouse overrides), status (`HEALTHY`, `LOW_STOCK`, `CRITICAL`, `OUT_OF_STOCK`), stock value.
- **Warehouse operations** — receive, issue, adjust (reason required), transfer (atomic), reserve / release, customer returns. All write an **immutable ledger** row with balance-after, actor, reference and a shared `transfer_group` for transfers.
- **Purchasing** — suppliers, POs with lines, controlled workflow, partial and full **idempotent receiving** with receipt history, supplier performance (on-time rate, actual lead time, fill rate, spend).
- **Sales** — record sales (optionally issuing stock atomically) and **stream-import CSV history** as a background job with row-level error reports.
- **Demand forecasting** — per item, background job, stored results with accuracy metrics and prediction intervals; nightly re-forecast cron.
- **Shortage detection & restocking** — risk levels with human-readable reasons, recommended order quantities, one-click draft POs grouped by supplier × warehouse.
- **Reports & dashboard** — KPIs, sales trend, reconstructed inventory-value trend, forecast aggregate, risk distribution, valuation, supplier performance, PO status, low stock; CSV exports.
- **Security** — JWT auth, 5 roles with a permission matrix, Argon2id hashing, login rate limiting, strict validation, safe errors.

---

## Domain model & database design

| Table | Notes |
|---|---|
| `products` | unique `sku`; CHECKs on cost/price/thresholds ≥ 0; preferred supplier FK |
| `warehouses`, `suppliers` | unique `code` / `name`; status enum |
| `inventory_items` | unique (product, warehouse); `available_quantity` = **generated column** `on_hand − reserved`; CHECK `on_hand ≥ 0`, `reserved ≥ 0`, `reserved ≤ on_hand` |
| `inventory_transactions` | append-only ledger; signed deltas + balances after; index (product, warehouse, created_at) |
| `purchase_orders`, `purchase_order_lines` | status enum; CHECK `0 ≤ received ≤ ordered`; unique (po, product) |
| `purchase_order_receipts` (+ lines) | unique (po, `receipt_key`) → idempotent receiving |
| `sales` | unique (order_reference, product, warehouse) → idempotent imports; index (product, warehouse, sold_at) |
| `forecast_runs`, `forecast_points` | model, version, metrics/details (JSONB), points with lower/upper; index (product, warehouse, generated_at) |
| `jobs` | durable job status; **partial unique index** on `dedupe_key` where status in (QUEUED, RUNNING) |
| `idempotency_records` | (key, scope) → stored response for `Idempotency-Key` replays |

Invariants are enforced **twice**: in services (friendly errors) and in PostgreSQL (CHECK / UNIQUE / FK / generated column), so even a buggy code path or manual SQL cannot create negative or over-reserved stock — this is covered by tests that attempt exactly that with raw SQL.

**Concurrency.** Stock operations lock the affected `inventory_items` rows with `SELECT … FOR UPDATE` in a *single statement ordered by id*, validate against the locked values and commit once. A transfer's debit and credit therefore succeed or fail together, concurrent requests cannot oversell (tested: 20 concurrent 1-unit issues against 10 units → exactly 10 succeed), and opposite-direction transfers cannot deadlock (tested). Receiving locks the PO row first, so duplicate concurrent receipts serialise (tested: 5 concurrent identical receipts → stock added once).

**Indexes** were chosen from query patterns, not added everywhere: forecasting history scans `sales(product_id, warehouse_id, sold_at)`; ledger views use `inventory_transactions(product_id, warehouse_id, created_at)`; "latest forecast per item" uses `forecast_runs(product_id, warehouse_id, generated_at)` with `DISTINCT ON`; FK columns that are filtered on (`purchase_orders.supplier_id/status/warehouse_id`, `purchase_order_lines.product_id`) are indexed. See [docs/performance.md](docs/performance.md) for `EXPLAIN ANALYZE` results.

---

## API

REST under `/api/v1`, fully documented in Swagger (tags, summaries, response models, error responses).

| Area | Endpoints |
|---|---|
| Auth & users | `POST /auth/login` (JSON), `POST /auth/token` (OAuth2 form, used by Swagger), `GET /auth/me`, `GET /auth/permissions`, `GET/POST /users`, `PATCH /users/{id}` |
| Catalog | `/products` (+ `/categories`, `/{id}` with stock per warehouse), `/warehouses` (+ `/summary`), `/suppliers` (+ stats) |
| Inventory | `GET /inventory`, `GET/PATCH /inventory/{id}`, `GET /inventory/transactions`, `POST /inventory/{receive,issue,adjust,transfer,reserve,release,return}` |
| Purchasing | `/purchase-orders` CRUD (draft), `POST /{id}/status`, `POST /{id}/receive` |
| Sales | `GET/POST /sales`, `POST /sales/import` (multipart CSV → job) |
| Forecasting | `POST /forecasts/run`, `POST /forecasts/run-all`, `GET /forecasts`, `GET /forecasts/item`, `GET /forecasts/{id}` |
| Planning | `GET /shortages`, `GET /restocking` (both paginated + sortable, with a `summary` over all matching rows), `POST /restocking/purchase-orders` |
| Meta | `GET /meta` (public: version, environment, demo mode, upload limit, forecast interval level) |
| Reports | `/reports/{dashboard,low-stock,inventory-value,inventory-trend,sales-summary,supplier-performance,purchase-orders,forecast-accuracy,forecast-aggregate}` |
| Jobs | `GET /jobs`, `GET /jobs/{id}` |

Conventions:
- Lists: `?page=&page_size=` (≤ 200) → `{items, total, page, page_size, pages}`; `?sort=field` / `?sort=-field` against an allow-list; filters per resource; `?format=csv` on exportable lists/reports (formula-injection-safe).
- Errors: `{"error": {"code": "INSUFFICIENT_STOCK", "message": "...", "details": {...}}, "request_id": "..."}` with 400/401/403/404/409/422/429/503 as appropriate. 500s never leak internals.
- `Idempotency-Key` header on stock operations and sales; `receipt_reference` on PO receiving.
- Every response carries `X-Request-ID` (also in every log line).

---

## Forecasting

Implemented in `app/forecasting/` as a pure, DB-independent pipeline (unit-tested in isolation):

1. **Validation & aggregation** — sales are summed per UTC day for one (product, warehouse) and **zero-filled** (a day without sales is real zero demand). The window starts at the item's first sale (no fake leading zeros) and ends yesterday (last complete day). Negative/NaN quantities are rejected.
2. **Profiling** — the Syntetos-Boylan ADI/CV² scheme classifies demand as *smooth, erratic, intermittent, lumpy* or *no demand*.
3. **Candidate models** (pluggable registry, `ForecastModel.fit/predict`):
   - *Moving average* (28 d) — transparent baseline;
   - *Seasonal naive* — weekday profile averaged over the last 4 weeks;
   - *Holt-Winters* (statsmodels) — additive, damped trend + weekly seasonality (needs ≥ 56 days);
   - *Croston-SBA* — for intermittent/lumpy demand.
4. **Rolling-origin backtest** — 3 origins × 14 days (when history allows) for each candidate; metrics are computed on all 42 held-out days.
5. **Selection** — lowest **MAE** for smooth/erratic series; lowest **RMSE** for intermittent ones, because MAE is minimised by the median, which is 0 for intermittent demand and would never trigger a reorder. Ties go to the simpler model.
6. **Refit & forecast** on the full history; negative values clipped to 0.
7. **80 % prediction interval** from the empirical standard deviation of backtest residuals (± 1.28σ).

Why not ML regressors or deep models? Daily SKU-level demand is short, noisy and often intermittent; well-chosen exponential smoothing and Croston baselines are what the forecasting literature (and M-competitions) show to be hard to beat here, they train in milliseconds, and they're explainable. The registry makes adding e.g. a gradient-boosted model a ~30-line change.

**Evaluation metrics.** MAE and RMSE (units), **WAPE** = Σ|e| / Σ|y| (volume-weighted %, robust to zero days), MAPE computed **only over non-zero actual days** (undefined at zero, reported for familiarity), and bias (mean forecast − actual). All candidates' scores are stored with the run (`details.candidates`) and shown in the UI.

**Execution.** Forecasts run in the ARQ worker (`asyncio.to_thread` keeps the event loop responsive during statsmodels fitting). Each run is stored with its points, model, version, metrics and data profile; the last 5 runs per item are kept. Identical in-flight requests are de-duplicated. A nightly cron re-forecasts every active item; failures are isolated per item.

---

## Shortage detection & restocking algorithm

Per product × warehouse (see `app/services/replenishment.py`):

| Symbol | Meaning |
|---|---|
| `d` | expected daily demand — mean of the latest stored forecast's *future* points; falls back to the trailing 28-day sales average (flagged `HISTORICAL_AVERAGE`) |
| `L` | lead time — preferred supplier's lead time, else the product's |
| `D_L` | demand during lead time = sum of the next `L` forecast days (extended with `d` past the horizon) |
| `SS` | safety stock (warehouse override or product default) |
| `inbound` | ordered − received on open POs (DRAFT…PARTIALLY_RECEIVED) |
| `inbound_L` | submitted/confirmed PO units expected **within the lead time** (drafts haven't been sent; later deliveries can't prevent this shortage) |
| `IP` | inventory position: `available + inbound` for recommendations, `available + inbound_L` for risk |
| `ROP` | reorder point = max(static ROP, `min_stock`, `D_L + SS`) |
| `S` | order-up-to level = `ROP + max(d × R, 1)` (R = review period, default 14 days; the +1 floor keeps zero-demand items from being re-recommended once ordered) |

**Risk:** `CRITICAL` if nothing is available or `IP < D_L` (will stock out before any new order can arrive) · `HIGH` if `IP < D_L + SS` (safety stock breached within lead time) · `MEDIUM` if `IP ≤ ROP` · `LOW` if `IP ≤ ROP + d×R` · otherwise `NONE`. **Timing check:** if expected demand until the *next scheduled delivery* exceeds available stock, the item stocks out before that delivery lands, so risk is raised to at least `HIGH` ("expected to run out around Oct 6, before the next delivery on Oct 9") even when the inbound quantity is large. `min_stock` is also a hard floor for the inventory *stock status* (separate from risk): available stock at or below `max(safety stock, min_stock)` is shown as `CRITICAL`. Each item carries days of cover, a projected stock-out date, the next inbound date and a plain-English reason/action.

**Recommendation:** when `IP ≤ ROP`, order `ceil(S − IP)`. Because open POs — **including drafts** — are part of `IP`, an item that was already ordered (or drafted from a previous recommendation) is not recommended again. `POST /restocking/purchase-orders` groups selections into one DRAFT PO per supplier × warehouse, atomically.

---

## Caching, async processing, idempotency

**Redis cache — versioned namespaces.** Each data domain (`catalog`, `inventory`, `sales`, `purchasing`, `forecasts`) has a version counter. A cached value's key embeds the versions of every domain it depends on; a write does `INCR` on its domains *after commit*, making all dependent keys unreachable in O(1) (no `KEYS`/`SCAN`, no missed dependants). TTLs bound memory. Cached: dashboard, replenishment analysis (shared by shortages/restocking/dashboard), report aggregates, per-item forecast + history. Not cached: paginated CRUD lists (cheap, indexed, and need read-your-writes).

**Redis failure handling.** Cache and rate limiter **fail open**: on a Redis error the value is computed from PostgreSQL, a warning is logged, and a 15 s circuit breaker skips Redis to avoid paying timeouts on every request. Readiness reports Redis as degraded but only PostgreSQL gates readiness. Job submission returns 503 if the queue is unreachable (and marks the job failed) instead of silently dropping work. All of this is covered by tests that point the app at a dead Redis.

**Background jobs — why ARQ.** The API is asyncio-native; ARQ is a small asyncio job queue on Redis, so the worker reuses the same async services/sessions/cache code. Celery would add a sync-first runtime and more operational surface for no benefit at this scale. Job state is persisted in PostgreSQL (queryable, survives Redis restarts); ARQ is only the transport (`_job_id` = our job id, so enqueueing is idempotent too). Stale RUNNING jobs (worker died) are failed by a reaper after the job timeout. Tests use an **inline dispatcher** (`JOB_BACKEND=inline`), the Docker stack uses the real worker.

**Idempotency.** `Idempotency-Key` on stock operations/sales stores the response in the *same DB transaction* as the effect (a concurrent duplicate loses on the primary key and rolls back); reusing a key with a different payload is a 409. PO receiving is idempotent per `receipt_reference`. CSV imports are idempotent via the sales natural key. Forecast/import jobs are de-duplicated by a partial unique index.

**CSV import** streams the uploaded file to disk in 1 MB chunks (size-limited, random server-side filename — the client name is never used as a path), then the worker reads it line-by-line and inserts in 1,000-row batches with `ON CONFLICT DO NOTHING`, committing per batch, reporting progress, and returning counts + the first 100 row errors with line numbers. Required columns: `sku, warehouse_code, sold_at, quantity, order_reference`; optional `unit_price`.

---

## Security

- Passwords hashed with **Argon2id**; unknown-user logins still burn a hash (no user-enumeration timing).
- **JWT** (HS256) with explicit algorithm allow-list (`alg=none`/confusion rejected), `exp/iat/nbf/jti`, and a DB check on every request that the user still exists and is active.
- **RBAC**: `ADMIN`, `WAREHOUSE_MANAGER`, `INVENTORY_MANAGER`, `PURCHASING_MANAGER`, `ANALYST` mapped to fine-grained permissions (`app/core/security.py`); enforced per endpoint, mirrored in the UI only for UX.
- **Login rate limiting** in Redis per account *and* per IP (so rotating IPs can't brute-force one account).
- Input validation everywhere (Pydantic + DB constraints); SQL only via SQLAlchemy bound parameters; sort fields via allow-lists; LIKE wildcards escaped.
- Uploads: extension + binary sniff + size limit + random filenames; CSV exports neutralise formula injection.
- Config only from env; `ENVIRONMENT=production` refuses to start with a weak/default `SECRET_KEY`, `DEBUG=true`, or wildcard CORS.
- Logs are structured JSON with request/job ids; keys that look like secrets are redacted; passwords/tokens are never logged.
- nginx adds CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`; containers run as non-root.

See [docs/security-review.md](docs/security-review.md) for the review checklist and residual risks.

---

## Testing

```bash
# Backend (needs PostgreSQL + Redis; defaults match docker-compose / CI service containers)
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.lock && pip install -e ".[dev]"
export TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/inventory_test
export TEST_REDIS_URL=redis://localhost:6379/15
pytest                       # all
pytest tests/unit            # pure unit tests (no infrastructure)
pytest -m integration        # PostgreSQL/Redis integration
pytest -m e2e                # API workflows
ruff check app tests && ruff format --check app tests && mypy app

# Frontend
cd frontend && npm ci
npx vitest run && npx oxlint src && npm run build

# Browser E2E against the running Docker stack
cd e2e && npm ci && npx playwright install chromium
E2E_BASE_URL=http://localhost:8080 npx playwright test
```

| Layer | What is covered |
|---|---|
| Unit | forecasting models/metrics/pipeline edge cases, replenishment math, JWT/password/RBAC, schema validation, CSV row validation, cache keying, CSV-injection guard |
| Integration | every stock operation, DB constraint enforcement via raw SQL, concurrency (overselling, deadlocks), PO workflow + idempotent and concurrent receiving, cache hit/invalidation, Redis-down behaviour, rate limiter, streaming CSV import (dupes, malformed, binary, 2.5k rows), forecast persistence/pruning |
| API e2e | the 4 required workflows; auth failures, 7 role/permission denials, validation format, duplicates, invalid references, insufficient stock, invalid transfers/transitions, duplicate receiving, idempotency replay/mismatch, malformed CSV, DB failure → 503, Redis down → still serving, unexpected exceptions → safe 500, cache invalidation, reports |
| Frontend | form validation, server-error mapping, critical components & flows (Vitest + Testing Library) |
| Browser | Playwright against the Docker stack: login, PO create → receive → inventory updated, forecast job → chart, recommendation → PO, transfer, permissions |

---

## Local development without Docker

```bash
# infrastructure only
docker compose up -d postgres redis   # (or local services)
cd backend && cp ../.env.example .env  # point DATABASE_URL/REDIS_URL at localhost
alembic upgrade head
SEED_DEMO_DATA=true python -m app.scripts.bootstrap
uvicorn app.main:app --reload                       # API on :8000
arq app.workers.worker.WorkerSettings               # worker
cd ../frontend && npm ci && npm run dev             # UI on :5173 (proxies /api to :8000)
```

---

## Architecture decisions & trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| Async SQLAlchemy + asyncpg | one concurrency model end-to-end (API, worker, cache) | async ORM requires explicit eager loading — enforced with `lazy="raise"` |
| Enums as `VARCHAR + CHECK` instead of native PG enums | adding a value is a plain migration | slightly larger storage |
| Generated column for `available_quantity` | can never drift; indexable/sortable | value only visible after flush (we re-select) |
| Ledger + mutable balance row | O(1) current-stock reads; full audit trail | two writes per movement (same transaction) |
| Dynamic recommendations (not persisted) | always consistent with live stock/POs/forecasts; dedupe is automatic | recomputed on cache miss (~tens of ms for hundreds of items; cached) |
| Statistical models over ML | short, noisy, intermittent daily series; explainable; fast | won't capture promotions/price effects without extra features |
| ARQ over Celery | asyncio-native, minimal ops | smaller ecosystem (no built-in UI — we expose `/jobs`) |
| JWT in `localStorage` | simple SPA auth for a bearer API; no CSRF surface | XSS could read it → strict CSP, no `dangerouslySetInnerHTML`, React escaping |
| Single access token, no refresh token | simplicity | users re-login after `ACCESS_TOKEN_EXPIRE_MINUTES` |

## Limitations & possible extensions

- Quantities are integer units; no unit-of-measure conversions, lots/serials or bin locations.
- Forecasts ignore price, promotions and holidays (exogenous regressors would be the next model in the registry).
- No multi-currency or multi-tenant support.
- Access tokens can't be revoked before expiry except by deactivating the user (refresh-token rotation/denylist would address this).
