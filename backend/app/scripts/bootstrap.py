"""Idempotent start-up tasks: ensure the first admin exists and (optionally) seed demo data.

Run after migrations: ``python -m app.scripts.bootstrap``.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.core.security import Role, hash_password
from app.db.database import dispose_engine, get_sessionmaker
from app.db.models import Product, User

logger = logging.getLogger("bootstrap")


async def ensure_admin() -> None:
    settings = get_settings()
    async with get_sessionmaker()() as session:
        if await session.scalar(select(func.count()).select_from(User).where(User.role == Role.ADMIN)):
            logger.info("admin user already present")
            return
        session.add(
            User(
                email=settings.first_admin_email.lower(),
                full_name="System Administrator",
                password_hash=hash_password(settings.first_admin_password.get_secret_value()),
                role=Role.ADMIN,
                is_active=True,
            )
        )
        await session.commit()
        logger.info("created initial admin", extra={"email": settings.first_admin_email})


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    await ensure_admin()
    if settings.seed_demo_data:
        async with get_sessionmaker()() as session:
            has_data = await session.scalar(select(func.count()).select_from(Product))
        if has_data:
            logger.info("demo seed skipped: database already contains products")
        else:
            from app.scripts.seed import seed

            await seed(run_forecasts=True)
    await dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())
