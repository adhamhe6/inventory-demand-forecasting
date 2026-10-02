"""Domain error types. Services raise these; the API layer maps them to HTTP responses."""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    status_code: int = 400
    code: str = "BAD_REQUEST"

    def __init__(self, message: str, *, code: str | None = None, details: Any = None) -> None:
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        self.details = details


class NotFoundError(AppError):
    status_code = 404
    code = "NOT_FOUND"


class ConflictError(AppError):
    status_code = 409
    code = "CONFLICT"


class BusinessRuleError(AppError):
    """A request that is well-formed but violates a business rule (e.g. insufficient stock)."""

    status_code = 422
    code = "BUSINESS_RULE_VIOLATION"


class InsufficientStockError(BusinessRuleError):
    code = "INSUFFICIENT_STOCK"


class InvalidStateTransitionError(ConflictError):
    code = "INVALID_STATE_TRANSITION"


class AuthenticationError(AppError):
    status_code = 401
    code = "UNAUTHORIZED"


class PermissionDeniedError(AppError):
    status_code = 403
    code = "FORBIDDEN"


class RateLimitedError(AppError):
    status_code = 429
    code = "RATE_LIMITED"


class ServiceUnavailableError(AppError):
    status_code = 503
    code = "SERVICE_UNAVAILABLE"
