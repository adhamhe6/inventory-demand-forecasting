"""FastAPI dependencies: DB session, cache, current user, permissions, pagination."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import Depends, Header, Query, Request
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.redis_cache import Cache, get_cache
from app.core.config import get_settings
from app.core.errors import AuthenticationError, PermissionDeniedError
from app.core.logging import user_id_ctx
from app.core.security import Permission, decode_access_token, has_permission
from app.db.database import session_scope
from app.db.models import User
from app.services.common import PageParams
from app.services.jobs import JobDispatcher

SessionDep = Annotated[AsyncSession, Depends(session_scope)]
# OAuth2 password flow so Swagger UI's "Authorize" button can log in with email + password;
# any client may also send the JWT from POST /auth/login as "Authorization: Bearer <token>".
_oauth2 = OAuth2PasswordBearer(
    tokenUrl=f"{get_settings().api_prefix}/auth/token",
    auto_error=False,
    description="Log in with your email (as username) and password.",
)


def cache_dep() -> Cache:
    return get_cache()


CacheDep = Annotated[Cache, Depends(cache_dep)]


async def get_current_user(
    session: SessionDep,
    token: Annotated[str | None, Depends(_oauth2)],
) -> User:
    if not token:
        raise AuthenticationError("Not authenticated")
    payload = decode_access_token(token)
    try:
        user_id = int(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise AuthenticationError("Invalid authentication token") from exc
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise AuthenticationError("User is inactive or no longer exists")
    user_id_ctx.set(user.id)
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require(permission: Permission) -> Callable[..., Awaitable[User]]:
    async def checker(user: CurrentUser) -> User:
        if not has_permission(user.role, permission):
            raise PermissionDeniedError(
                f"Role {user.role.value} is not allowed to perform this action",
                details={"required_permission": permission.value},
            )
        return user

    return checker


def page_params(
    page: Annotated[int, Query(ge=1, le=100_000, description="1-based page number")] = 1,
    page_size: Annotated[int, Query(ge=1, le=200, description="Items per page (max 200)")] = 25,
) -> PageParams:
    return PageParams(page=page, page_size=page_size)


PageDep = Annotated[PageParams, Depends(page_params)]
SortQuery = Annotated[
    str | None,
    Query(max_length=100, description="Sort field; prefix with '-' for descending, e.g. -created_at"),
]
SearchQuery = Annotated[str | None, Query(max_length=100, description="Case-insensitive text search")]


def get_dispatcher(request: Request) -> JobDispatcher:
    dispatcher: JobDispatcher = request.app.state.dispatcher
    return dispatcher


DispatcherDep = Annotated[JobDispatcher, Depends(get_dispatcher)]
IdempotencyKey = Annotated[
    str | None,
    Header(
        alias="Idempotency-Key",
        min_length=8,
        max_length=200,
        description="Optional client-generated unique key (e.g. a UUID). Retrying a request with "
        "the same key returns the original result instead of applying the change twice.",
    ),
]
