from __future__ import annotations

import enum

from sqlalchemy import Enum


def str_enum(enum_cls: type[enum.Enum], name: str) -> Enum:
    """Store enums as VARCHAR + CHECK constraint (easier to evolve than native PG enums)."""
    return Enum(
        enum_cls,
        name=name,
        native_enum=False,
        create_constraint=True,
        length=32,
        values_callable=lambda e: [m.value for m in e],
        validate_strings=True,
    )


class EntityStatus(enum.StrEnum):
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"


class TransactionType(enum.StrEnum):
    PURCHASE_RECEIPT = "PURCHASE_RECEIPT"
    SALE = "SALE"
    ISSUE = "ISSUE"
    ADJUSTMENT = "ADJUSTMENT"
    TRANSFER_OUT = "TRANSFER_OUT"
    TRANSFER_IN = "TRANSFER_IN"
    RETURN = "RETURN"
    RESERVATION = "RESERVATION"
    RESERVATION_RELEASE = "RESERVATION_RELEASE"


class PurchaseOrderStatus(enum.StrEnum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    CONFIRMED = "CONFIRMED"
    PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED"
    RECEIVED = "RECEIVED"
    CANCELLED = "CANCELLED"


class JobStatus(enum.StrEnum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"


class JobType(enum.StrEnum):
    FORECAST_ITEM = "FORECAST_ITEM"
    FORECAST_ALL = "FORECAST_ALL"
    IMPORT_SALES = "IMPORT_SALES"
