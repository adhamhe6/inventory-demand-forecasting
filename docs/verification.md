# Verification

What was checked beyond the automated test suites, how, and the observed results.
Everything below was run on 2026-10-02 against the Docker Compose stack (`.env.example` settings, demo seed), and re-run after the final pre-merge review fixes.

## Re-running it

```bash
docker compose up -d --wait                       # stack with demo seed
API_URL=http://localhost:8000 python scripts/verify/live_checks.py            # 43 checks, exit 1 on any FAIL
API_URL=http://localhost:8000 python scripts/verify/recompute_replenishment.py
docker compose exec -T postgres psql -U inventory -d inventory -q < scripts/verify/invariants.sql
cd e2e && E2E_BASE_URL=http://localhost:8080 npx playwright test
```

`live_checks.py` writes demo data (stock movements, a PO, imported sales, forecast jobs); never point it at production.

## Final pre-merge review

An independent review of the whole repository (security, domain logic, docs vs code, frontend and tests) found and fixed:
production accepting published defaults (placeholder `SECRET_KEY`, default admin password, demo seed); a spoofable client IP on the published API port; partially received POs that could never be closed (their missing units counted as inbound forever); jobs stuck in `QUEUED` blocking their dedupe key; a receipt reference replayed with different lines being silently accepted; inactive suppliers pre-selected on recommendations; stale forecasts used after their horizon; stale caches after a partially failed import and after product renames; an N+1 guard that compared 0 rows with 0 rows for four of six endpoints; a Playwright test that could skip silently; a negative-only permission test; and several inaccurate documentation claims. Each fix has a regression test (backend 134 → 143 tests, frontend 68 → 70) or a live check (42 → 43).

## CI from a clean clone

Fresh `git clone` of the branch, new virtualenv / `npm ci`, every step of `.github/workflows/ci.yml`:

| Job | Result |
|---|---|
| backend | ruff ✓ · ruff format ✓ · mypy ✓ (62 files) · `alembic upgrade head && alembic check` → no drift · pytest **134 passed**, 84 % coverage |
| frontend | `npm ci` (0 vulnerabilities) · oxlint ✓ · vitest **68 passed** · `npm run build` ✓ |
| docker-e2e | images built `--no-cache` from the clone · `compose up --wait` (seed + 65 forecasts ≈ 32 s) · smoke test through nginx ✓ · Playwright **11 passed** |

## Live system checks (`scripts/verify/live_checks.py`, 43/43)

- **Auth & RBAC:** anonymous / forged token → 401; analyst issue stock, analyst create PO, warehouse list users, purchasing adjust stock, inventory manager create user → 403; analyst reads reports/restocking → 200. Swagger OAuth2 `/auth/token` works and is declared in OpenAPI. `/meta` is public and contains no secrets.
- **Malformed input:** non-JSON body, negative quantity, page_size > 200 → 422 `VALIDATION_ERROR`; SQL in `sort` → 400 `INVALID_SORT`; unknown product → 404; all with `error` + `request_id`.
- **Invariants & atomicity:** over-issue, over-release, over-receive → 422 business-rule errors; a failed transfer changes no balance and writes no ledger row; illegal PO transition → 409; closing a partially received PO short removes its 6 outstanding units from inbound (606 → 600).
- **Idempotency:** same `Idempotency-Key` twice → one effect, identical response; same key with a different body → 409; PO receipt replayed with the same GRN → stock added once, and the same GRN with different lines → 409 with stock unchanged; CSV re-upload → 0 inserted / 5 duplicates; concurrent `run-all` requests → same job id.
- **Redis caching:** cache keys populated; a stock write bumps `cache:ver:inventory`; dashboard totals equal `SUM(quantity_on_hand)` immediately after the write; after invalidation the first read recomputes and stores a new-version key, the second is a cache hit.
- **Jobs:** CSV import runs in the worker with line-numbered row errors; binary upload / wrong extension → 400; missing columns → FAILED job with message; `run-all` forecasts all 65 items.

## Failure scenarios (manual, observed)

| Scenario | Result |
|---|---|
| Worker killed (`docker compose kill worker`) mid forecast-all | job → `FAILED` "worker stopped… please retry" **80 s** later; retry succeeds (65/65). Before the heartbeat fix it stayed `RUNNING` for up to an hour — see commit history. |
| Redis stopped | dashboard 200 (136 ms), restocking 200, login 200, job submit 503 `SERVICE_UNAVAILABLE`, readiness `redis: unavailable`; full recovery after restart |
| API container stopped (browser) | every page shows an error with *Try again* within ~3 s (nginx `proxy_connect_timeout 5s`, was 60 s); one retry recovers the whole page; a hard reload keeps the session and explains the outage |
| `ENVIRONMENT=production` with the `.env.example` secret, the default admin password, or `SEED_DEMO_DATA=true` (run in the built image) | each refused at startup with a specific message; a properly configured production env starts |
| 11 failed logins for one account | 11th → 429 with `retry_after_seconds`; same counter for `/auth/login` and `/auth/token`; other accounts on the IP unaffected |

## Data correctness

- `invariants.sql` on the seeded DB, after all live checks and after a 200k-row import: ledger sums = balances, latest `*_after` = balances, no negative/over-reserved stock, no over-received PO line, `RECEIVED` POs have a received date and are fully received unless closed short after a receipt, PO ledger receipts = received quantities, transfers net to zero — **0 violations**.
- `recompute_replenishment.py`: d, D_L, ROP, inventory position, order-up-to level and recommended quantity re-derived from raw SQL for **65/65** items — **0 mismatches** with `/shortages` and `/restocking`.
- Seeded scenario quality: growing items forecast at their recent level (e.g. 5.1 → 6.9 units/day, forecast 6.9); model choice follows the demand profile (37 Holt-Winters, 13 moving average, 9 Croston, 6 seasonal naive); 18 high/critical risks and 15 recommendations, all with suppliers.

## Performance

See [performance.md](performance.md): 200k-row CSV import in 51 s at ~188 MiB worker memory; hot queries use their indexes at 250k sales (≤ 9 ms).

## Browser / visual QA

Every route at 1440, 820 and 390 px, light and dark: no console errors, no failed requests, no page-level horizontal overflow. Fixed during QA: 320 px dashboard overflow on phones, tables cut off at tablet width, warehouse missing from inventory rows on phones, deep-linked tabs scrolled out of view, 404 without `h1`, Google Fonts dependency (now self-hosted, CSP tightened). The Playwright mobile overflow guard was found to be unable to fail under device emulation and was corrected.

## Security

`pip-audit -r backend/requirements.lock`: no known vulnerabilities. `npm audit --omit=dev` (frontend) and `npm audit` (e2e): 0. Response headers verified live (API: `nosniff`, `X-Frame-Options: DENY`, `no-referrer`, `no-store`, `X-Request-ID`; web: CSP without third-party origins, `Permissions-Policy`). See [security-review.md](security-review.md).
