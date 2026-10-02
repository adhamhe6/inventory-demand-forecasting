from datetime import UTC, datetime, timedelta

import jwt
import pytest

from app.core.config import Settings, get_settings
from app.core.errors import AuthenticationError
from app.core.security import (
    Permission,
    Role,
    create_access_token,
    decode_access_token,
    has_permission,
    hash_password,
    verify_password,
)


def test_password_hashing_roundtrip_and_never_plaintext() -> None:
    h = hash_password("S3cret-password")
    assert h != "S3cret-password" and h.startswith("$argon2id$")
    assert verify_password("S3cret-password", h)
    assert not verify_password("wrong", h)
    assert not verify_password("anything", None)
    assert not verify_password("anything", "not-a-hash")


def test_jwt_roundtrip() -> None:
    token, ttl = create_access_token(42, "ADMIN")
    payload = decode_access_token(token)
    assert payload["sub"] == "42" and payload["role"] == "ADMIN" and ttl > 0


def test_expired_token_rejected() -> None:
    token, _ = create_access_token(1, "ADMIN", expires_minutes=-1)
    with pytest.raises(AuthenticationError) as exc:
        decode_access_token(token)
    assert exc.value.code == "TOKEN_EXPIRED"


def test_tampered_and_unsigned_tokens_rejected() -> None:
    token, _ = create_access_token(1, "ANALYST")
    head, body, sig = token.split(".")
    with pytest.raises(AuthenticationError):
        decode_access_token(f"{head}.{body}.{sig[:-2]}xx")
    none_token = jwt.encode(
        {
            "sub": "1",
            "role": "ADMIN",
            "type": "access",
            "iat": datetime.now(UTC),
            "exp": datetime.now(UTC) + timedelta(hours=1),
        },
        key=None,
        algorithm="none",
    )
    with pytest.raises(AuthenticationError):
        decode_access_token(none_token)
    forged = jwt.encode(
        {
            "sub": "1",
            "role": "ADMIN",
            "type": "access",
            "iat": datetime.now(UTC),
            "exp": datetime.now(UTC) + timedelta(hours=1),
        },
        "some-other-secret-key-of-sufficient-length",
        algorithm="HS256",
    )
    with pytest.raises(AuthenticationError):
        decode_access_token(forged)


def test_role_permission_matrix() -> None:
    assert all(has_permission(Role.ADMIN, p) for p in Permission)
    assert has_permission(Role.WAREHOUSE_MANAGER, Permission.STOCK_OPERATIONS)
    assert not has_permission(Role.WAREHOUSE_MANAGER, Permission.MANAGE_PURCHASE_ORDERS)
    assert has_permission(Role.PURCHASING_MANAGER, Permission.MANAGE_PURCHASE_ORDERS)
    assert not has_permission(Role.PURCHASING_MANAGER, Permission.STOCK_ADJUST)
    assert not has_permission(Role.ANALYST, Permission.STOCK_OPERATIONS)
    assert has_permission(Role.ANALYST, Permission.RUN_FORECASTS)
    assert not has_permission(Role.INVENTORY_MANAGER, Permission.MANAGE_USERS)


def test_production_settings_refuse_insecure_defaults() -> None:
    with pytest.raises(ValueError, match="SECRET_KEY"):
        Settings(environment="production", secret_key="change-me")
    with pytest.raises(ValueError, match="CORS"):
        Settings(environment="production", secret_key="x" * 40, cors_origins=["*"])
    ok = Settings(environment="production", secret_key="x" * 40, cors_origins="https://app.example.com")
    assert ok.cors_origins == ["https://app.example.com"]
    assert get_settings().environment == "test"
