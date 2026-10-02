from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request, status

from app.api.dependencies import CurrentUser, PageDep, SessionDep, require
from app.cache.redis_cache import RateLimiter, get_redis
from app.core.config import get_settings
from app.core.errors import RateLimitedError
from app.core.security import ROLE_PERMISSIONS, Permission, create_access_token
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

    Failed attempts are rate limited (Redis fixed window) in two independent buckets:
    per account – so rotating source IPs cannot brute-force one user – and per client IP
    (3× the account limit) – so one client cannot spray many accounts. A successful login
    clears the account bucket.
    """
    settings = get_settings()
    limiter = RateLimiter(get_redis())
    window = settings.login_rate_limit_window_seconds
    account_bucket = f"login:acct:{body.email.lower()}"
    ip_bucket = f"login:ip:{_client_ip(request)}"
    for bucket, limit in (
        (account_bucket, settings.login_rate_limit_attempts),
        (ip_bucket, settings.login_rate_limit_attempts * 3),
    ):
        allowed, retry_after = await limiter.hit(bucket, limit, window)
        if not allowed:
            raise RateLimitedError(
                "Too many login attempts. Please try again later.",
                details={"retry_after_seconds": retry_after},
            )
    user = await UserService(session).authenticate(body.email, body.password)
    await limiter.reset(account_bucket)
    token, expires_in = create_access_token(user.id, user.role.value)
    return TokenResponse(access_token=token, expires_in=expires_in, user=UserRead.model_validate(user))


@router.get("/auth/me", response_model=UserRead, summary="Current user", responses=ERROR_RESPONSES)
async def me(user: CurrentUser) -> User:
    return user


@router.get("/auth/permissions", summary="Permissions of the current user's role", responses=ERROR_RESPONSES)
async def my_permissions(user: CurrentUser) -> dict[str, list[str]]:
    return {"role": [user.role.value], "permissions": sorted(p.value for p in ROLE_PERMISSIONS[user.role])}


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
