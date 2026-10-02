-- Ledger / balance / purchasing invariants. Run: docker compose exec -T postgres psql -U inventory -d inventory -q < scripts/verify/invariants.sql
-- Every *_mismatch / bad_* / over_* / unbalanced_* count must be 0.
\pset footer off
SELECT 'items' k, count(*) FROM inventory_items
UNION ALL SELECT 'ledger rows', count(*) FROM inventory_transactions
UNION ALL SELECT 'sales', count(*) FROM sales
UNION ALL SELECT 'POs', count(*) FROM purchase_orders
UNION ALL SELECT 'forecast runs', count(*) FROM forecast_runs;
-- 1. ledger sums reproduce balances
SELECT 'ledger_mismatch' AS check, count(*) FROM inventory_items i
LEFT JOIN (SELECT product_id, warehouse_id, sum(on_hand_delta) oh, sum(reserved_delta) rs FROM inventory_transactions GROUP BY 1,2) t
 USING (product_id, warehouse_id)
WHERE coalesce(t.oh,0) <> i.quantity_on_hand OR coalesce(t.rs,0) <> i.reserved_quantity;
-- 2. running *_after columns match the latest row
SELECT 'after_mismatch', count(*) FROM inventory_items i JOIN LATERAL (
  SELECT on_hand_after, reserved_after FROM inventory_transactions t
  WHERE t.product_id=i.product_id AND t.warehouse_id=i.warehouse_id ORDER BY id DESC LIMIT 1) l ON true
WHERE l.on_hand_after <> i.quantity_on_hand OR l.reserved_after <> i.reserved_quantity;
-- 3. no negative / over-reserved balances
SELECT 'bad_balances', count(*) FROM inventory_items WHERE quantity_on_hand<0 OR reserved_quantity<0 OR reserved_quantity>quantity_on_hand;
-- 4. PO lines never over-received; status consistent with receipts
SELECT 'over_received', count(*) FROM purchase_order_lines WHERE quantity_received > quantity_ordered;
SELECT 'received_status_mismatch', count(*) FROM purchase_orders po WHERE status='RECEIVED' AND EXISTS
  (SELECT 1 FROM purchase_order_lines l WHERE l.purchase_order_id=po.id AND l.quantity_received<l.quantity_ordered);
-- 5. ledger receipts for POs equal received quantities
SELECT 'po_receipt_ledger_mismatch', count(*) FROM (
  SELECT po.po_number, sum(l.quantity_received) rec,
    (SELECT coalesce(sum(quantity),0) FROM inventory_transactions t WHERE t.type='PURCHASE_RECEIPT' AND t.reference = po.po_number) led
  FROM purchase_orders po JOIN purchase_order_lines l ON l.purchase_order_id=po.id GROUP BY po.id, po.po_number) x WHERE rec<>led;
-- 6. transfers balanced per group
SELECT 'unbalanced_transfers', count(*) FROM (SELECT transfer_group, sum(on_hand_delta) s FROM inventory_transactions WHERE transfer_group IS NOT NULL GROUP BY 1) g WHERE s<>0;
-- 7. jobs
SELECT status, type, count(*) FROM jobs GROUP BY 1,2 ORDER BY 2,1;
