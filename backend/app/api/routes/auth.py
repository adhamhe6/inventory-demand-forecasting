from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel

from app.api.dependencies import CurrentUser, PageDep, SessionDep, require
from app.cache.redis_cache import RateLimiter, get_redis
from app.core.config import get_settings
from app.core.errors import AuthenticationError, RateLimitedError
from app.core.security import ROLE_PERMISSIONS, Permission, Role, create_access_token
from app.db.models import User
from app.schemas.auth import LoginRequest, TokenResponse, UserCreate, UserRead, UserUpdate
from app.schemas.common import CONFLICT, ERROR_RESPONSES, NOT_FOUND, ErrorResponse, Page
from app.services.users import UserService

router = APIRouter(tags=["Auth & Users"])


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post(
    "/auth/login",
    response_model=TokenResponse,
    summary="Log in and obtain a JWT access token",
    responses={
        401: {"model": ErrorResponse},
        429: {"model": ErrorResponse, "description": "Too many attempts"},
    },
)
async def login(body: LoginRequest, request: Request, session: SessionDep) -> TokenResponse:
    """Exchange email + password for a bearer token.

    *Failed* attempts are rate limited (Redis fixed window) in two independent buckets: per
    account – so rotating source IPs cannot brute-force one user – and per client IP (3× the
    account limit) – so one client cannot spray many accounts. Successful logins are never
    counted, so many legitimate users behind one NAT are unaffected.
    """
    settings = get_settings()
    limiter = RateLimiter(get_redis())
    window = settings.login_rate_limit_window_seconds
    buckets = (
        (f"login:acct:{body.email.lower()}", settings.login_rate_limit_attempts),
        (f"login:ip:{_client_ip(request)}", settings.login_rate_limit_attempts * 3),
    )
    for bucket, limit in buckets:
        retry_after = await limiter.retry_after(bucket, limit)
        if retry_after:
            raise RateLimitedError(
                "Too many failed login attempts. Please try again later.",
                details={"retry_after_seconds": retry_after},
            )
    try:
        user = await UserService(session).authenticate(body.email, body.password)
    except AuthenticationError:
        for bucket, limit in buckets:
            await limiter.hit(bucket, limit, window)
        raise
    await limiter.reset(buckets[0][0])
    token, expires_in = create_access_token(user.id, user.role.value)
    return TokenResponse(access_token=token, expires_in=expires_in, user=UserRead.model_validate(user))


@router.get("/auth/me", response_model=UserRead, summary="Current user", responses=ERROR_RESPONSES)
async def me(user: CurrentUser) -> User:
    return user


class PermissionsResponse(BaseModel):
    role: Role
    permissions: list[str]


@router.get(
    "/auth/permissions",
    response_model=PermissionsResponse,
    summary="Permissions of the current user's role",
    responses=ERROR_RESPONSES,
)
async def my_permissions(user: CurrentUser) -> PermissionsResponse:
    return PermissionsResponse(
        role=user.role, permissions=sorted(p.value for p in ROLE_PERMISSIONS[user.role])
    )


AdminDep = Annotated[User, Depends(require(Permission.MANAGE_USERS))]


@router.get("/users", response_model=Page[UserRead], summary="List users (admin)", responses=ERROR_RESPONSES)
async def list_users(_: AdminDep, session: SessionDep, page: PageDep) -> Page[UserRead]:
    users, total = await UserService(session).list_users(page)
    return Page.build([UserRead.model_validate(u) for u in users], total, page.page, page.page_size)


@router.post(
    "/users",
    response_model=UserRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create user (admin)",
    responses={**ERROR_RESPONSES, **CONFLICT},
)
async def create_user(body: UserCreate, _: AdminDep, session: SessionDep) -> User:
    return await UserService(session).create(body)


@router.patch(
    "/users/{user_id}",
    response_model=UserRead,
    summary="Update user (admin)",
    responses={**ERROR_RESPONSES, **NOT_FOUND},
)
async def update_user(user_id: int, body: UserUpdate, admin: AdminDep, session: SessionDep) -> User:
    return await UserService(session).update(user_id, body, admin.id)
