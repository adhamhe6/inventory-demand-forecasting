import { useState } from 'react'
import { usePaged, qk } from '@/api/queries'
import { type Column, DataTable } from '@/components/common/DataTable'
import { EmptyState } from '@/components/common/States'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import type { Transaction, TransactionType } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'

const TYPE: Record<TransactionType, { label: string; variant: BadgeProps['variant'] }> = {
  PURCHASE_RECEIPT: { label: 'PO receipt', variant: 'success' },
  SALE: { label: 'Sale', variant: 'info' },
  ISSUE: { label: 'Issue', variant: 'secondary' },
  ADJUSTMENT: { label: 'Adjustment', variant: 'warning' },
  TRANSFER_OUT: { label: 'Transfer out', variant: 'orange' },
  TRANSFER_IN: { label: 'Transfer in', variant: 'default' },
  RETURN: { label: 'Return', variant: 'success' },
  RESERVATION: { label: 'Reserved', variant: 'muted' },
  RESERVATION_RELEASE: { label: 'Released', variant: 'muted' },
}

export function TransactionTypeBadge({ type }: { type: TransactionType }) {
  return <Badge variant={TYPE[type].variant}>{TYPE[type].label}</Badge>
}

function Delta({ v }: { v: number }) {
  if (v === 0) return <span className="text-muted-foreground">0</span>
  return <span className={cn('font-medium tabular', v > 0 ? 'text-emerald-600' : 'text-red-600')}>{v > 0 ? `+${fmt.int(v)}` : fmt.int(v)}</span>
}

/** Paginated audit ledger, optionally scoped to a product and/or warehouse. */
export function TransactionsTable({ productId, warehouseId, showProduct = true }: { productId?: number; warehouseId?: number; showProduct?: boolean }) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const query = { product_id: productId, warehouse_id: warehouseId, page, page_size: pageSize }
  const q = usePaged<Transaction>(qk.transactions(query), '/inventory/transactions', query)
  const columns: Column<Transaction>[] = [
    { key: 'when', header: 'When', cell: (t) => <span className="whitespace-nowrap text-muted-foreground">{fmt.dateTime(t.created_at)}</span> },
    { key: 'type', header: 'Type', cell: (t) => <TransactionTypeBadge type={t.type} /> },
    ...(showProduct
      ? [{ key: 'product', header: 'Product', cell: (t: Transaction) => <span className="font-mono text-xs">{t.sku}</span> } as Column<Transaction>]
      : []),
    { key: 'wh', header: 'Warehouse', cell: (t) => t.warehouse_code, hideBelow: 'sm' },
    { key: 'onhand', header: 'On hand Δ', align: 'right', cell: (t) => <Delta v={t.on_hand_delta} /> },
    { key: 'res', header: 'Reserved Δ', align: 'right', cell: (t) => <Delta v={t.reserved_delta} />, hideBelow: 'md' },
    { key: 'after', header: 'Balance', align: 'right', cell: (t) => <span className="tabular">{fmt.int(t.on_hand_after)}</span> },
    { key: 'ref', header: 'Reference', cell: (t) => <span className="text-xs">{t.reference ?? '—'}</span>, hideBelow: 'lg' },
    { key: 'actor', header: 'By', cell: (t) => <span className="text-xs text-muted-foreground">{t.actor_name ?? 'System'}</span>, hideBelow: 'xl' },
  ]
  return (
    <DataTable
      caption="Inventory transactions"
      columns={columns}
      rows={q.data?.items}
      rowKey={(t) => t.id}
      loading={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      empty={<EmptyState title="No stock movements yet" description="Receipts, sales, transfers and adjustments will appear here." />}
      page={page}
      pageSize={pageSize}
      total={q.data?.total}
      onPageChange={setPage}
      onPageSizeChange={(s) => {
        setPageSize(s)
        setPage(1)
      }}
    />
  )
}
