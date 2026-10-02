# Security review

Checklist from the project brief, with what was verified and where.

| Area | Status | Notes / evidence |
|---|---|---|
| Authentication | ✅ | JWT HS256, `exp`/`iat`/`nbf`/`jti`, required claims, explicit algorithm allow-list (tests reject `alg=none`, a forged key, a tampered signature, and an expired token). Every request re-checks that the user exists and is active (test: a deactivated user's token stops working). |
| Authorization | ✅ | Role → permission matrix in `core/security.py`; every mutating endpoint depends on `require(Permission.X)`. Seven parametrised tests confirm 403s across roles. The UI hides actions only for UX. |
| Password hashing | ✅ | Argon2id (`argon2-cffi`) with automatic rehash on login. A dummy hash equalises timing for unknown users, so response time doesn't reveal which emails exist. Password policy: at least 10 characters, letters and digits. |
| JWT handling | ✅ | Secret comes only from the environment. Production refuses keys shorter than 32 characters, known defaults, and any `change-me…` value (the `.env.example` placeholder is 54 characters, so a length check alone would accept it). Tokens are bearer-only, so cookies and CSRF don't apply. |
| Input validation | ✅ | Pydantic on every input (lengths, ranges, patterns, decimal precision, cross-field rules) plus DB CHECK/UNIQUE/FK constraints. Consistent 422 responses with field paths. |
| SQL injection | ✅ | All SQL goes through SQLAlchemy bound parameters. `sort` uses an allow-list, and LIKE wildcards in search terms are escaped. The only f-string SQL is the seed script's `TRUNCATE`, built from a fixed tuple of table names. Ruff `S` rules are enabled. |
| Secret management | ✅ | Config comes only from env/`.env` (git-ignored). `.env.example` holds placeholders, and compose fails fast when `SECRET_KEY`/`FIRST_ADMIN_PASSWORD` are unset. |
| CORS | ✅ | Explicit origin list without credentials. Production rejects `*`. Behind nginx the SPA and API share an origin. |
| Rate limiting | ✅ | Failed login attempts are limited per account and per IP (3× the account limit) in Redis; both `/auth/login` and the Swagger `/auth/token` form share the same buckets, and successful logins are not counted. The limiter fails open if Redis is down; this is a deliberate availability trade-off, logged as a warning. |
| File uploads | ✅ | `.csv` extension and NUL-byte sniff checks, a streaming size limit (413), and a random server-side filename (never the client path). Files are deleted after processing. Malformed or binary content becomes a clear job error. |
| Sensitive logging | ✅ | JSON logs redact keys containing password/token/secret/authorization/cookie. Request logs carry method, path, status, duration and IP, but no bodies or headers. |
| Error leakage | ✅ | The catch-all handler returns a generic message plus a `request_id`, and the traceback is only logged. Tests assert internal exception text never appears in a response, and that DB errors return 503 without driver details. |
| Public endpoints | ✅ | Only `/auth/login`, `/auth/token`, `/meta`, the health probes and the API docs (`/docs`, `/redoc`, `/openapi.json`) are unauthenticated. `/meta` exposes version, environment name, demo mode and limits, never secrets or credentials (test asserts this). The login page lists demo accounts only when `demo_mode` is true. |
| Insecure defaults | ✅ | Production mode refuses a weak/placeholder secret, a published default admin password, the demo seed (published demo passwords), debug and wildcard CORS. Backend containers run as a non-root user (the stock nginx image's master runs as root, workers as `nginx`). Postgres and Redis are not published to the host; the API port is published on 127.0.0.1 only, so external traffic goes through nginx. |
| HTTP hardening | ✅ | API: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Cache-Control: no-store`. nginx/SPA adds a strict CSP and `Permissions-Policy`. |
| CSV export injection | ✅ | Cells starting with `= + - @` (or tab/CR) are prefixed with `'` (unit-tested). |
| Dependency vulnerabilities | ✅ | `pip-audit -r requirements.lock`: no known vulnerabilities. `npm audit --omit=dev` (frontend) and `npm audit` (e2e): 0 vulnerabilities. |

## Issues found and fixed during the review

1. **Login rate-limit bypass via spoofed `X-Forwarded-For`.** The limiter originally used one bucket keyed on IP + email, so rotating forged client IPs gave unlimited attempts against one account. Fixed by adding an independent per-account bucket and a per-IP bucket.
2. **nginx header inheritance.** An `add_header` inside a `location` silently drops server-level headers. Security headers moved to a snippet that each SPA location includes. The CSP is deliberately not applied to proxied Swagger UI, which loads CDN assets.
3. **Catch-all 500 handler crash.** The handler itself raised, so clients received a non-JSON plain-text 500. Found by a test, fixed, and the test is kept as a regression guard.
4. **Production accepted published defaults** (final pre-merge review). The `.env.example` `SECRET_KEY` placeholder passed the length check, and `ENVIRONMENT=production` still ran the demo seed (an ADMIN with a published password) and accepted the default first-admin password; Swagger always printed the default credentials. Production now refuses all three, and Swagger shows demo credentials only when demo data is seeded (unit-tested).
5. **Spoofable client IP on the published API port** (final review). uvicorn trusted `X-Forwarded-For` from any address while compose published port 8000 on all interfaces, so a client calling the API directly got a fresh per-IP login bucket per request (the per-account limit still held) and could stream unbounded uploads before authentication. Forwarded headers are now trusted only from private networks and the API port is bound to 127.0.0.1, so external traffic goes through nginx (which overwrites the header and caps bodies at 55 MB).
6. **Explicit `null` in a user PATCH** surfaced as a 409 from the NOT NULL constraint; it is now a 422 validation error (tested).

## Residual risks and accepted trade-offs

* Access tokens live in `localStorage`, so an XSS bug could read them. Mitigations: strict CSP, React escaping, no `dangerouslySetInnerHTML`, short token lifetime. An httpOnly-cookie session with CSRF protection would remove this risk at the cost of complexity.
* No refresh tokens or revocation list. Deactivating a user is effective immediately because every request re-checks the user; other revocation waits for expiry.
* uvicorn honours `X-Forwarded-For` only from private networks (`FORWARDED_ALLOW_IPS` = 127.0.0.1, 10/8, 172.16/12, 192.168/16), i.e. from nginx. A deployment that puts the API on a shared private network with untrusted clients should narrow it to the proxy's address.
