from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from app.schemas.catalog import ProductCreate, ProductUpdate, WarehouseCreate
from app.schemas.inventory import StockAdjustment, StockMovement, StockTransfer
from app.schemas.purchasing import PurchaseOrderCreate, ReceivePurchaseOrder
from app.schemas.sales import SaleCreate


def product(**kw: object) -> dict:
    return {"sku": "abc-1", "name": "Thing", "cost": "1.00", "price": "2.00", **kw}


def test_sku_is_normalised_and_validated() -> None:
    assert ProductCreate(**product()).sku == "ABC-1"
    for bad in ["a", "-bad", "has space", "x" * 65, "semi;colon"]:
        with pytest.raises(ValidationError):
            ProductCreate(**product(sku=bad))


@pytest.mark.parametrize("field", ["cost", "price"])
def test_negative_money_rejected(field: str) -> None:
    with pytest.raises(ValidationError):
        ProductCreate(**product(**{field: "-0.01"}))


def test_money_precision_enforced() -> None:
    with pytest.raises(ValidationError):
        ProductCreate(**product(price="1.234"))


def test_product_update_requires_a_field() -> None:
    with pytest.raises(ValidationError):
        ProductUpdate()


def test_warehouse_code_uppercased() -> None:
    assert WarehouseCreate(code="wh-east", name="East").code == "WH-EAST"
    with pytest.raises(ValidationError):
        WarehouseCreate(code="bad code!", name="x")


def test_stock_quantities_must_be_positive() -> None:
    with pytest.raises(ValidationError):
        StockMovement(product_id=1, warehouse_id=1, quantity=0)
    with pytest.raises(ValidationError):
        StockMovement(product_id=1, warehouse_id=1, quantity=-5)


def test_adjustment_rules() -> None:
    with pytest.raises(ValidationError):
        StockAdjustment(product_id=1, warehouse_id=1, quantity_change=0, note="count")
    with pytest.raises(ValidationError):
        StockAdjustment(product_id=1, warehouse_id=1, quantity_change=-2, note="")  # reason required
    assert (
        StockAdjustment(product_id=1, warehouse_id=1, quantity_change=-2, note="damaged").quantity_change
        == -2
    )


def test_transfer_requires_distinct_warehouses() -> None:
    with pytest.raises(ValidationError, match="differ"):
        StockTransfer(product_id=1, from_warehouse_id=1, to_warehouse_id=1, quantity=1)


def test_po_rejects_duplicate_products_and_empty_lines() -> None:
    with pytest.raises(ValidationError):
        PurchaseOrderCreate(supplier_id=1, warehouse_id=1, lines=[])
    with pytest.raises(ValidationError, match="once"):
        PurchaseOrderCreate(
            supplier_id=1,
            warehouse_id=1,
            lines=[{"product_id": 1, "quantity_ordered": 1}, {"product_id": 1, "quantity_ordered": 2}],
        )


def test_receive_rejects_duplicate_lines() -> None:
    with pytest.raises(ValidationError):
        ReceivePurchaseOrder(lines=[{"line_id": 1, "quantity": 1}, {"line_id": 1, "quantity": 1}])


def test_sale_cannot_be_in_future() -> None:
    with pytest.raises(ValidationError, match="future"):
        SaleCreate(
            product_id=1,
            warehouse_id=1,
            quantity=1,
            order_reference="X",
            sold_at=datetime.now(UTC) + timedelta(days=1),
        )
