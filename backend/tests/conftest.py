"""Test harness.

Integration and e2e tests run against a real PostgreSQL database (migrated with Alembic, so
the migrations themselves are under test) and a real Redis. Jobs run inline
(JOB_BACKEND=inline) so API-level workflows are deterministic; the ARQ worker path is
exercised separately in the Docker smoke test.

Configure with TEST_DATABASE_URL / TEST_REDIS_URL (defaults match the docker-compose / CI
service containers).
"""

from __future__ import annotations

import os
import tempfile

os.environ["ENVIRONMENT"] = "test"
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://postgres:postgres@localhost:5432/inventory_test"
)
os.environ["REDIS_URL"] = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/15")
os.environ["JOB_BACKEND"] = "inline"
os.environ["LOG_JSON"] = "false"
os.environ["LOG_LEVEL"] = "WARNING"
os.environ["IMPORT_DIR"] = tempfile.mkdtemp(prefix="inv-imports-")
os.environ["DATABASE_POOL_SIZE"] = "5"
os.environ["LOGIN_RATE_LIMIT_ATTEMPTS"] = "1000"

from collections.abc import AsyncIterator, Callable
from decimal import Decimal
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.redis_cache import get_cache, get_redis
from app.core.security import Role, create_access_token, hash_password
from app.db.database import get_engine, get_sessionmaker
from app.db.models import Product, Supplier, User, Warehouse

TABLES = [
    "forecast_points",
    "forecast_runs",
    "jobs",
    "idempotency_records",
    "purchase_order_receipt_lines",
    "purchase_order_receipts",
    "purchase_order_lines",
    "purchase_orders",
    "inventory_transactions",
    "inventory_items",
    "sales",
    "products",
    "suppliers",
    "warehouses",
    "users",
]


def _run_migrations() -> None:
    from alembic.config import Config

    from alembic import command

    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "..", "alembic"))
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")


@pytest.fixture(scope="session")
def migrated_db() -> None:
    """Apply migrations once per session (also proves downgrade/upgrade works)."""
    import concurrent.futures

    # Alembic's env.py uses asyncio.run(), which cannot nest inside the test loop.
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        pool.submit(_run_migrations).result()


@pytest.fixture
async def db(migrated_db: None) -> None:
    """Clean database + Redis for every test that touches infrastructure."""
    async with get_engine().begin() as conn:
        await conn.execute(text(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE"))
        await conn.execute(text("ALTER SEQUENCE purchase_order_number_seq RESTART WITH 1001"))
    await get_redis().flushdb()
    cache = get_cache()
    cache._down_until = 0.0  # reset circuit breaker between tests


@pytest.fixture
async def session(db: None) -> AsyncIterator[AsyncSession]:
    async with get_sessionmaker()() as s:
        yield s


@pytest.fixture
async def client(db: None) -> AsyncIterator[AsyncClient]:
    from app.main import app
    from app.workers.dispatch import InlineDispatcher

    app.state.dispatcher = InlineDispatcher()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def users(db: None) -> dict[Role, User]:
    """One active user per role."""
    out: dict[Role, User] = {}
    async with get_sessionmaker()() as s:
        for role in Role:
            u = User(
                email=f"{role.value.lower()}@test.example",
                full_name=role.value.title(),
                password_hash=hash_password("Password123!"),
                role=role,
                is_active=True,
            )
            s.add(u)
            out[role] = u
        await s.commit()
    return out


@pytest.fixture
def auth(users: dict[Role, User]) -> Callable[[Role], dict[str, str]]:
    def headers(role: Role = Role.ADMIN) -> dict[str, str]:
        token, _ = create_access_token(users[role].id, role.value)
        return {"Authorization": f"Bearer {token}"}

    return headers


@pytest.fixture
async def catalog(db: None) -> dict[str, Any]:
    """Minimal master data: 2 warehouses, 1 supplier, 2 products."""
    async with get_sessionmaker()() as s:
        sup = Supplier(name="Acme Supply", lead_time_days=5)
        wa = Warehouse(code="WH-A", name="Warehouse A")
        wb = Warehouse(code="WH-B", name="Warehouse B")
        s.add_all([sup, wa, wb])
        await s.flush()
        p1 = Product(
            sku="SKU-1",
            name="Widget",
            category="Parts",
            cost=Decimal("2.50"),
            price=Decimal("5.00"),
            reorder_point=20,
            safety_stock=10,
            lead_time_days=5,
            supplier_id=sup.id,
        )
        p2 = Product(
            sku="SKU-2",
            name="Gadget",
            category="Parts",
            cost=Decimal("10.00"),
            price=Decimal("25.00"),
            reorder_point=5,
            safety_stock=2,
            lead_time_days=7,
            supplier_id=sup.id,
        )
        s.add_all([p1, p2])
        await s.commit()
        return {"supplier": sup, "wa": wa, "wb": wb, "p1": p1, "p2": p2}
