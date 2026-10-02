# Implementation Plan

Starting point: an empty repository (README only). Everything below is built from scratch.

## Architecture

```
React SPA (Vite, TS, Tailwind, shadcn-style UI, TanStack Query)
   │  served by nginx, which also reverse-proxies /api → api
   ▼
FastAPI (async) ── SQLAlchemy 2 (asyncpg) ──► PostgreSQL 16
   │        └──── redis-py (cache, rate limit, job queue) ──► Redis 7
   ▼
ARQ worker (same codebase): forecasting, CSV import, scheduled nightly forecast
```

Layering inside `backend/app`:

| Layer | Responsibility |
|---|---|
| `api/routes` | HTTP only: parse/validate, auth dependencies, call a service, shape the response |
| `schemas` | Pydantic request/response models (the public contract) |
| `services` | Business logic and transaction boundaries (inventory ops, PO workflow, restocking, reports) |
| `db/models` | SQLAlchemy models + DB-level invariants (FKs, unique, CHECK) |
| `forecasting` | Pure, DB-agnostic pipeline: validation → aggregation → models → backtest → forecast |
| `workers` | ARQ settings + job functions (thin wrappers that call services) |
| `cache` | Versioned-namespace cache + rate limiter, fail-open on Redis errors |
| `core` | Config, security (JWT, argon2), logging, error types |

A separate repository layer is deliberately **not** added: SQLAlchemy's session already is a unit-of-work/repository; services own their queries. This avoids a pass-through abstraction.

## Database design (PostgreSQL)

- `users` (role enum, argon2 hash)
- `suppliers`, `warehouses` (unique code), `products` (unique SKU, preferred supplier FK)
- `inventory_items` — one row per (product, warehouse); `available_quantity` is a **generated column**;
  CHECKs: `on_hand >= 0`, `reserved >= 0`, `reserved <= on_hand`.
- `inventory_transactions` — append-only ledger with signed `on_hand_delta`/`reserved_delta`, balance after, actor, reference, transfer group.
- `purchase_orders`, `purchase_order_lines` (CHECK received ≤ ordered), `purchase_order_receipts` + lines (receiving history).
- `sales` — unique (`order_reference`, product, warehouse) for import de-duplication.
- `forecast_runs` + `forecast_points` — stored forecasts with model, version, metrics, intervals.
- `jobs` — durable background-job status.
- `idempotency_records` — generic Idempotency-Key storage, written in the same DB transaction as the effect.

Concurrency: row locks (`SELECT … FOR UPDATE`) in deterministic id order for multi-row operations (transfers) to avoid deadlocks.

## API design

REST under `/api/v1`, JSON everywhere, consistent envelope for lists (`items,total,page,page_size,pages`) and errors (`{"error":{"code","message","details"},"request_id"}`). Sorting via `sort=-field` with allow-lists. `Idempotency-Key` header for stock operations, sales and PO receipts.

## Forecasting approach

Daily demand per (product, warehouse), zero-filled. Candidate models: moving average (baseline), seasonal naive, Holt-Winters (damped trend + weekly seasonality) and Croston-SBA for intermittent demand. Rolling-origin holdout backtest picks the model with lowest MAE; metrics stored: MAE, RMSE, WAPE, MAPE (non-zero actuals only), bias. Residual-based prediction intervals. Strategy is pluggable through a registry.

## Background jobs

ARQ (async-native, Redis-based, tiny footprint, shares async services) instead of Celery (heavier, sync-first). Jobs: `forecast_item`, `forecast_all` (also nightly cron), `import_sales_csv`. Job state persisted in `jobs`; duplicate in-flight jobs are de-duplicated by a dedupe key. Tests use an inline dispatcher.

## Caching strategy

Versioned namespaces: each domain (`inventory`, `catalog`, `sales`, `purchasing`, `forecasts`) has a version counter; cached keys embed the versions of the domains they depend on. Writes bump the version (O(1) invalidation). TTL as safety net. Redis errors → log + compute directly (fail-open). Redis also backs login rate limiting.

## Testing strategy

- unit: forecasting models/metrics, restocking math, permissions, validation, cache keying
- integration: real PostgreSQL + Redis (services, constraints, concurrency, cache invalidation, Redis-down behaviour)
- e2e (API): the four required workflows + failure scenarios via httpx against the ASGI app
- frontend: Vitest + Testing Library; Playwright browser tests against the Docker stack

## Deployment

Docker Compose: `postgres`, `redis` (health-checked), `migrate` (one-shot: alembic + bootstrap admin/demo seed), `api`, `worker`, `web` (nginx + SPA). GitHub Actions: lint, type-check, tests with service containers, frontend tests/build, Docker build.
