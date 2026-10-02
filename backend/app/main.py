"""FastAPI application factory."""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError, OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.routes import auth, catalog, forecasting, inventory, purchasing, reports, sales
from app.cache.redis_cache import close_redis, get_cache
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.logging import configure_logging, request_id_ctx, user_id_ctx
from app.db.database import dispose_engine, get_engine
from app.forecasting.pipeline import INTERVAL_LEVEL
from app.workers.dispatch import ArqDispatcher, InlineDispatcher

logger = logging.getLogger("app")

OPENAPI_TAGS = [
    {"name": "Auth & Users", "description": "JWT login and user administration (ADMIN)."},
    {"name": "Products", "description": "Product master data (unique SKU)."},
    {"name": "Warehouses", "description": "Warehouses (unique code) and per-warehouse stock summaries."},
    {"name": "Suppliers", "description": "Suppliers and their performance statistics."},
    {
        "name": "Inventory",
        "description": "Stock levels and atomic, idempotent stock operations with a full audit ledger.",
    },
    {"name": "Purchase Orders", "description": "Controlled PO workflow and idempotent receiving."},
    {"name": "Sales", "description": "Sales recording and streaming CSV import."},
    {
        "name": "Demand Forecasting",
        "description": "Background forecasting jobs and stored forecasts with accuracy metrics.",
    },
    {"name": "Stock Risk", "description": "Shortage detection from stock, open POs and forecasts."},
    {"name": "Restocking", "description": "Replenishment recommendations and one-click draft POs."},
    {
        "name": "Reports & Dashboard",
        "description": "Cached analytics for dashboards; CSV export where useful.",
    },
    {"name": "Background Jobs", "description": "Status, progress and results of asynchronous jobs."},
    {"name": "Health", "description": "Liveness / readiness probes."},
]


def error_body(
    code: str, message: str, details: Any = None, request: Request | None = None
) -> dict[str, Any]:
    rid = request_id_ctx.get() or (getattr(request.state, "request_id", None) if request else None)
    return {"error": {"code": code, "message": message, "details": details}, "request_id": rid}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error(_: Request, exc: AppError) -> JSONResponse:
        if exc.status_code >= 500:
            logger.error("service error", extra={"code": exc.code, "error": exc.message})
        return JSONResponse(
            error_body(exc.code, exc.message, jsonable_encoder(exc.details)), status_code=exc.status_code
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {
                "field": ".".join(str(p) for p in err.get("loc", ()) if p != "body"),
                "message": err.get("msg"),
                "type": err.get("type"),
            }
            for err in exc.errors()
        ]
        return JSONResponse(
            error_body("VALIDATION_ERROR", "Request validation failed", details), status_code=422
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 401: "UNAUTHORIZED", 403: "FORBIDDEN"}.get(
            exc.status_code, "HTTP_ERROR"
        )
        return JSONResponse(
            error_body(code, str(exc.detail)),
            status_code=exc.status_code,
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(IntegrityError)
    async def integrity_error(_: Request, exc: IntegrityError) -> JSONResponse:
        # A DB constraint caught something the service layer did not (defence in depth).
        logger.warning("integrity error", extra={"error": str(exc.orig)[:300]})
        return JSONResponse(
            error_body("CONSTRAINT_VIOLATION", "The request violates a data integrity rule"), status_code=409
        )

    @app.exception_handler(OperationalError)
    @app.exception_handler(DBAPIError)
    async def db_unavailable(_: Request, exc: Exception) -> JSONResponse:
        logger.error("database error", exc_info=exc)
        return JSONResponse(
            error_body("DATABASE_UNAVAILABLE", "The database is temporarily unavailable"), status_code=503
        )

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        # Runs outside the request middleware, so the request id comes from request.state.
        logger.exception(
            "unhandled exception",
            exc_info=exc,
            extra={"request_id": getattr(request.state, "request_id", None)},
        )
        message = f"{type(exc).__name__}: {exc}" if get_settings().debug else "An unexpected error occurred"
        return JSONResponse(error_body("INTERNAL_ERROR", message, request=request), status_code=500)


async def request_context_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Assign/propagate X-Request-ID, log one structured line per request, add security headers."""
    incoming = request.headers.get("x-request-id", "")
    request_id = (
        incoming if 8 <= len(incoming) <= 64 and incoming.replace("-", "").isalnum() else uuid.uuid4().hex
    )
    request.state.request_id = request_id
    token = request_id_ctx.set(request_id)
    user_token = user_id_ctx.set(None)
    start = time.perf_counter()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
    finally:
        duration_ms = round((time.perf_counter() - start) * 1000, 1)
        if request.url.path not in ("/health", "/health/ready"):
            level = logging.WARNING if status_code >= 500 else logging.INFO
            logger.log(
                level,
                "request",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status": status_code,
                    "duration_ms": duration_ms,
                    "client": request.client.host if request.client else None,
                },
            )
        request_id_ctx.reset(token)
        user_id_ctx.reset(user_token)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers.setdefault("Cache-Control", "no-store")
    return response


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    pool = None
    if settings.job_backend == "arq":
        from arq import create_pool
        from arq.connections import RedisSettings

        try:
            pool = await create_pool(RedisSettings.from_dsn(settings.redis_url), retry=3)
        except Exception as exc:  # API must still start (reads work) when Redis is down
            logger.error(
                "could not connect job queue; background jobs unavailable", extra={"error": str(exc)}
            )
        app.state.dispatcher = ArqDispatcher(pool)
    else:
        app.state.dispatcher = InlineDispatcher()
    logger.info(
        "api started", extra={"environment": settings.environment, "job_backend": settings.job_backend}
    )
    yield
    if pool is not None:
        await pool.aclose()
    await close_redis()
    await dispose_engine()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Inventory Management & Demand Forecasting API",
        version="1.0.0",
        description=(
            "Multi-warehouse inventory, purchasing and sales with demand forecasting, shortage "
            "detection and restocking recommendations.\n\n"
            "**Authenticate**: click *Authorize* and sign in with your email (username) and password "
            "(demo: `admin@example.com` / `ChangeMe123!`), or `POST /api/v1/auth/login` for a JSON token.\n\n"
            'Errors always have the shape `{"error": {"code", "message", "details"}, "request_id"}`.'
        ),
        openapi_tags=OPENAPI_TAGS,
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
        swagger_ui_parameters={"persistAuthorization": True, "displayRequestDuration": True},
    )
    register_exception_handlers(app)
    app.middleware("http")(request_context_middleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,  # bearer tokens, no cookies
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"],
        expose_headers=["X-Request-ID", "Content-Disposition", "Idempotent-Replayed"],
    )
    prefix = settings.api_prefix
    for router in (
        auth.router,
        catalog.products,
        catalog.warehouses,
        catalog.suppliers,
        inventory.router,
        purchasing.router,
        sales.router,
        forecasting.forecasts,
        forecasting.shortages,
        forecasting.restocking,
        forecasting.jobs,
        reports.router,
    ):
        app.include_router(router, prefix=prefix)

    @app.get(f"{prefix}/meta", tags=["Health"], summary="Public client configuration")
    async def meta() -> dict[str, Any]:
        """Non-sensitive settings the UI needs (so it never hard-codes them)."""
        return {
            "app_name": settings.app_name,
            "version": app.version,
            "environment": settings.environment,
            "demo_mode": settings.seed_demo_data,
            "max_import_file_mb": settings.max_import_file_mb,
            "forecast_interval_level": INTERVAL_LEVEL,
            "restock_review_period_days": settings.restock_review_period_days,
        }

    @app.get("/health", tags=["Health"], summary="Liveness probe")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/ready", tags=["Health"], summary="Readiness probe (database + Redis)")
    async def ready() -> JSONResponse:
        checks: dict[str, str] = {}
        try:
            async with get_engine().connect() as conn:
                await conn.execute(text("SELECT 1"))
            checks["database"] = "ok"
        except Exception as exc:
            logger.warning("readiness: database down", extra={"error": str(exc)[:200]})
            checks["database"] = "unavailable"
        checks["redis"] = "ok" if await get_cache().ping() else "unavailable"
        # Redis is an optimisation (cache fails open), so only the database gates readiness.
        healthy = checks["database"] == "ok"
        return JSONResponse(
            {"status": "ok" if healthy else "degraded", "checks": checks}, status_code=200 if healthy else 503
        )

    return app


app = create_app()
