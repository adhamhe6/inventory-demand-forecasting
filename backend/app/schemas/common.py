from __future__ import annotations

import math
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int = Field(description="Total number of matching records")
    page: int
    page_size: int
    pages: int

    @classmethod
    def build(cls, items: list[T], total: int, page: int, page_size: int) -> Page[T]:
        return cls(
            items=items,
            total=total,
            page=page,
            page_size=page_size,
            pages=max(1, math.ceil(total / page_size)) if page_size else 1,
        )


class ErrorBody(BaseModel):
    code: str = Field(examples=["INSUFFICIENT_STOCK"])
    message: str = Field(examples=["Insufficient available stock"])
    details: Any | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody
    request_id: str | None = None


class Message(BaseModel):
    message: str


ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "Missing or invalid credentials"},
    403: {"model": ErrorResponse, "description": "Authenticated but not permitted"},
    422: {"model": ErrorResponse, "description": "Validation or business-rule failure"},
}
NOT_FOUND: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorResponse, "description": "Resource not found"}
}
CONFLICT: dict[int | str, dict[str, Any]] = {
    409: {"model": ErrorResponse, "description": "Conflict with current state"}
}
