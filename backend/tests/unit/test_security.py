from datetime import UTC, datetime, timedelta

import jwt
import pytest

from app.core.config import Settings, get_settings
from app.core.errors import AuthenticationError
from app.core.security import (
    ROLE_PERMISSIONS,
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
    safe = {"secret_key": "x" * 40, "first_admin_password": "a-real-Passw0rd", "seed_demo_data": False}
    with pytest.raises(ValueError, match="SECRET_KEY"):
        Settings(environment="production", **{**safe, "secret_key": "change-me"})
    # The .env.example placeholder is long enough to pass a length check; it must still be refused.
    with pytest.raises(ValueError, match="SECRET_KEY"):
        Settings(
            environment="production",
            **{**safe, "secret_key": "change-me-to-a-long-random-string-of-at-least-32-chars"},
        )
    with pytest.raises(ValueError, match="FIRST_ADMIN_PASSWORD"):
        Settings(environment="production", **{**safe, "first_admin_password": "ChangeMe123!"})
    with pytest.raises(ValueError, match="SEED_DEMO_DATA"):
        Settings(environment="production", **{**safe, "seed_demo_data": True})
    with pytest.raises(ValueError, match="CORS"):
        Settings(environment="production", **safe, cors_origins=["*"])
    ok = Settings(environment="production", **safe, cors_origins="https://app.example.com")
    assert ok.cors_origins == ["https://app.example.com"]
    assert get_settings().environment == "test"


def test_frontend_permission_table_matches_backend() -> None:
    """The SPA hides actions from a copy of ROLE_PERMISSIONS; fail CI if the copy drifts."""
    import re
    from pathlib import Path

    src = (Path(__file__).resolve().parents[3] / "frontend/src/lib/permissions.ts").read_text()
    union = set(re.findall(r"\|\s*'([a-z_]+)'", src.split("const ROLE_PERMISSIONS")[0]))
    assert union == {p.value for p in Permission} - {Permission.READ.value}  # READ is implicit in the UI
    table = src.split("const ROLE_PERMISSIONS")[1].split("}")[0]
    for role in Role:
        entry = re.search(rf"{role.value}:\s*(\[[^\]]*\]|'all')", table)
        assert entry, f"{role} missing from frontend permissions"
        backend = {p.value for p in ROLE_PERMISSIONS[role]} - {Permission.READ.value}
        frontend = union if entry.group(1) == "'all'" else set(re.findall(r"'([a-z_]+)'", entry.group(1)))
        assert frontend == backend, f"{role}: frontend {sorted(frontend)} != backend {sorted(backend)}"
