from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AuthenticationError, BusinessRuleError, ConflictError, NotFoundError
from app.core.security import Role, hash_password, needs_rehash, verify_password
from app.db.models import User
from app.schemas.auth import UserCreate, UserUpdate
from app.services.common import PageParams, apply_sort, paginate

logger = logging.getLogger(__name__)


class UserService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def authenticate(self, email: str, password: str) -> User:
        user = await self.session.scalar(select(User).where(func.lower(User.email) == email.lower()))
        # verify_password always hashes, so unknown users take as long as known ones.
        if not verify_password(password, user.password_hash if user else None) or user is None:
            logger.info("login failed", extra={"reason": "bad_credentials"})
            raise AuthenticationError("Incorrect email or password", code="INVALID_CREDENTIALS")
        if not user.is_active:
            raise AuthenticationError("Account is disabled", code="ACCOUNT_DISABLED")
        if needs_rehash(user.password_hash):
            user.password_hash = hash_password(password)
        user.last_login_at = datetime.now(UTC)
        await self.session.commit()
        logger.info("login succeeded", extra={"user_id": user.id})
        return user

    async def get(self, user_id: int) -> User:
        user = await self.session.get(User, user_id)
        if user is None:
            raise NotFoundError(f"User {user_id} not found")
        return user

    async def list(self, page: PageParams) -> tuple[list[User], int]:
        stmt = apply_sort(select(User), None, {"id": User.id, "email": User.email}, "email")
        rows, total = await paginate(self.session, stmt, page)
        return [r[0] for r in rows], total

    async def create(self, data: UserCreate) -> User:
        user = User(
            email=data.email.lower(),
            full_name=data.full_name,
            password_hash=hash_password(data.password),
            role=data.role,
            is_active=True,
        )
        self.session.add(user)
        try:
            await self.session.commit()
        except IntegrityError as exc:
            await self.session.rollback()
            raise ConflictError("A user with this email already exists", code="DUPLICATE") from exc
        logger.info("user created", extra={"new_user_id": user.id, "role": user.role.value})
        return user

    async def update(self, user_id: int, data: UserUpdate, acting_user_id: int) -> User:
        user = await self.get(user_id)
        changes = data.model_dump(exclude_unset=True)
        if user_id == acting_user_id and (
            changes.get("is_active") is False or changes.get("role", Role.ADMIN) != Role.ADMIN
        ):
            raise BusinessRuleError("You cannot deactivate or demote your own account", code="SELF_LOCKOUT")
        if changes.get("password"):
            user.password_hash = hash_password(changes.pop("password"))
        changes.pop("password", None)
        for key, value in changes.items():
            setattr(user, key, value)
        await self.session.commit()
        return user
