"""Password hashing (Argon2id), JWT access tokens and the role → permission matrix."""

from __future__ import annotations

import enum
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.config import get_settings
from app.core.errors import AuthenticationError

_hasher = PasswordHasher()
# A real hash used to equalise timing when the user does not exist.
_DUMMY_HASH = _hasher.hash("timing-equaliser-not-a-real-password")


class Role(enum.StrEnum):
    ADMIN = "ADMIN"
    WAREHOUSE_MANAGER = "WAREHOUSE_MANAGER"
    INVENTORY_MANAGER = "INVENTORY_MANAGER"
    PURCHASING_MANAGER = "PURCHASING_MANAGER"
    ANALYST = "ANALYST"


class Permission(enum.StrEnum):
    READ = "read"
    MANAGE_USERS = "manage_users"
    MANAGE_PRODUCTS = "manage_products"
    DELETE_PRODUCTS = "delete_products"
    MANAGE_WAREHOUSES = "manage_warehouses"
    MANAGE_SUPPLIERS = "manage_suppliers"
    STOCK_OPERATIONS = "stock_operations"
    STOCK_ADJUST = "stock_adjust"
    MANAGE_PURCHASE_ORDERS = "manage_purchase_orders"
    RECEIVE_PURCHASE_ORDERS = "receive_purchase_orders"
    RECORD_SALES = "record_sales"
    IMPORT_SALES = "import_sales"
    RUN_FORECASTS = "run_forecasts"


_ALL = set(Permission)

ROLE_PERMISSIONS: dict[Role, set[Permission]] = {
    Role.ADMIN: _ALL,
    Role.WAREHOUSE_MANAGER: {
        Permission.READ,
        Permission.MANAGE_WAREHOUSES,
        Permission.STOCK_OPERATIONS,
        Permission.STOCK_ADJUST,
        Permission.RECEIVE_PURCHASE_ORDERS,
        Permission.RECORD_SALES,
    },
    Role.INVENTORY_MANAGER: {
        Permission.READ,
        Permission.MANAGE_PRODUCTS,
        Permission.STOCK_OPERATIONS,
        Permission.STOCK_ADJUST,
        Permission.RECORD_SALES,
        Permission.IMPORT_SALES,
        Permission.RUN_FORECASTS,
    },
    Role.PURCHASING_MANAGER: {
        Permission.READ,
        Permission.MANAGE_SUPPLIERS,
        Permission.MANAGE_PURCHASE_ORDERS,
        Permission.RECEIVE_PURCHASE_ORDERS,
        Permission.RUN_FORECASTS,
    },
    Role.ANALYST: {
        Permission.READ,
        Permission.IMPORT_SALES,
        Permission.RUN_FORECASTS,
    },
}


def has_permission(role: Role | str, permission: Permission) -> bool:
    return permission in ROLE_PERMISSIONS.get(Role(role), set())


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    """Constant-ish time verification; also burns a hash when the user is unknown."""
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def create_access_token(subject: int, role: str, expires_minutes: int | None = None) -> tuple[str, int]:
    settings = get_settings()
    minutes = expires_minutes or settings.access_token_expire_minutes
    now = datetime.now(UTC)
    payload = {
        "sub": str(subject),
        "role": role,
        "type": "access",
        "iat": now,
        "nbf": now,
        "exp": now + timedelta(minutes=minutes),
        "jti": uuid.uuid4().hex,
    }
    token = jwt.encode(payload, settings.secret_key.get_secret_value(), algorithm=settings.jwt_algorithm)
    return token, minutes * 60


def decode_access_token(token: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            settings.secret_key.get_secret_value(),
            algorithms=[settings.jwt_algorithm],  # explicit allow-list: blocks alg=none/confusion
            options={"require": ["exp", "iat", "sub"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise AuthenticationError("Token has expired", code="TOKEN_EXPIRED") from exc
    except jwt.PyJWTError as exc:
        raise AuthenticationError("Invalid authentication token") from exc
    if payload.get("type") != "access":
        raise AuthenticationError("Invalid authentication token")
    return payload
