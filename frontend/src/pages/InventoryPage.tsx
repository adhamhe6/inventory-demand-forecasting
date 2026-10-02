import { ArrowLeftRight, Download, MoreHorizontal, PackagePlus, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { qk, useAllWarehouses, useCategories, usePaged } from '@/api/queries'
import { type Column, DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { SearchInput } from '@/components/common/SearchInput'
import { EmptyState } from '@/components/common/States'
import { StockStatusBadge } from '@/components/common/StatusBadge'
import { type StockOp, StockOperationDialog } from '@/components/inventory/StockOperationDialog'
import { TransactionsTable } from '@/components/inventory/TransactionsTable'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogDescription, DialogHeader, DialogTitle, SheetContent } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NativeSelect } from '@/components/ui/input'
import { downloadCsv, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useUrlState } from '@/lib/hooks'
import type { InventoryItem } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'

const DEFAULTS = { page: 1, page_size: 25, search: '', warehouse_id: '', status: '', category: '', sort: 'status' }

function StockBar({ item }: { item: InventoryItem }) {
  // Visual cue: available vs reorder point (100% = 2× ROP).
  const scale = Math.max(item.reorder_point * 2, item.available_quantity, 1)
  const pct = (item.available_quantity / scale) * 100
  const rop = (item.reorder_point / scale) * 100
  const color =
    item.status === 'HEALTHY' ? 'bg-emerald-500' : item.status === 'LOW_STOCK' ? 'bg-amber-500' : item.status === 'CRITICAL' ? 'bg-orange-500' : 'bg-red-500'
  return (
    <div className="relative hidden h-1.5 w-20 rounded-full bg-muted 2xl:block" aria-hidden>
      <div className={cn('h-full rounded-full', color)} style={{ width: `${Math.min(pct, 100)}%` }} />
      <div className="absolute -top-0.5 h-2.5 w-px bg-foreground/50" style={{ left: `${Math.min(rop, 100)}%` }} />
    </div>
  )
}

export default function InventoryPage() {
  const { can } = useAuth()
  const [f, setF] = useUrlState(DEFAULTS)
  const warehouses = useAllWarehouses()
  const categories = useCategories()
  const [op, setOp] = useState<StockOp | null>(null)
  const [opItem, setOpItem] = useState<InventoryItem | null>(null)
  const [detailSel, setDetail] = useState<InventoryItem | null>(null)
  const [exporting, setExporting] = useState(false)

  const query = {
    page: f.page,
    page_size: f.page_size,
    search: f.search,
    warehouse_id: f.warehouse_id,
    status: f.status,
    category: f.category,
    sort: f.sort,
  }
  const q = usePaged<InventoryItem>(qk.inventory(query), '/inventory', query)
  const canOps = can('stock_operations')
  // Keep the open detail panel in sync with refreshed list data after stock operations.
  const detail = detailSel ? (q.data?.items.find((i) => i.id === detailSel.id) ?? detailSel) : null

  const openOp = (o: StockOp, item: InventoryItem | null) => {
    setOpItem(item)
    setOp(o)
  }

  const columns: Column<InventoryItem>[] = [
    {
      key: 'sku',
      header: 'SKU',
      sortKey: 'sku',
      cell: (i) => (
        <Link to={`/products/${i.product_id}`} onClick={(e) => e.stopPropagation()} className="whitespace-nowrap font-mono text-xs font-medium text-primary hover:underline">
          {i.sku}
        </Link>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      sortKey: 'product_name',
      cell: (i) => (
        <div className="min-w-0 max-w-[14rem]">
          <p className="truncate font-medium">{i.product_name}</p>
          <p className="truncate text-xs text-muted-foreground">{i.category}</p>
        </div>
      ),
    },
    { key: 'wh', header: 'Warehouse', sortKey: 'warehouse_code', cell: (i) => <span className="whitespace-nowrap">{i.warehouse_code}</span>, hideBelow: 'sm' },
    { key: 'onhand', header: 'On hand', sortKey: 'quantity_on_hand', align: 'right', cell: (i) => <span className="tabular">{fmt.int(i.quantity_on_hand)}</span> },
    { key: 'reserved', header: 'Reserved', sortKey: 'reserved_quantity', align: 'right', hideBelow: 'md', cell: (i) => <span className="tabular text-muted-foreground">{fmt.int(i.reserved_quantity)}</span> },
    {
      key: 'available',
      header: 'Available',
      sortKey: 'available_quantity',
      align: 'right',
      cell: (i) => (
        <div className="flex items-center justify-end gap-3">
          <StockBar item={i} />
          <span className="font-semibold tabular">{fmt.int(i.available_quantity)}</span>
        </div>
      ),
    },
    { key: 'rop', header: 'Reorder pt.', sortKey: 'reorder_point', align: 'right', hideBelow: 'xl', cell: (i) => <span className="tabular text-muted-foreground">{fmt.int(i.reorder_point)}</span> },
    { key: 'value', header: 'Value', sortKey: 'stock_value', align: 'right', hideBelow: '2xl', cell: (i) => <span className="tabular">{fmt.money(i.stock_value)}</span> },
    { key: 'status', header: 'Status', sortKey: 'status', cell: (i) => <StockStatusBadge status={i.status} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (i) =>
        canOps ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${i.sku} in ${i.warehouse_code}`} onClick={(e) => e.stopPropagation()}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onSelect={() => openOp('receive', i)}>Receive</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openOp('issue', i)}>Issue</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openOp('transfer', i)}>Transfer…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => openOp('reserve', i)}>Reserve</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openOp('release', i)} disabled={i.reserved_quantity === 0}>
                Release reservation
              </DropdownMenuItem>
              {can('stock_adjust') && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => openOp('adjust', i)}>Adjust…</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null,
    },
  ]

  const filtersActive = f.search || f.warehouse_id || f.status || f.category

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Warehouse-level stock with reservations, reorder points and status."
        actions={
          <>
            <Button
              variant="outline"
              loading={exporting}
              onClick={async () => {
                setExporting(true)
                try {
                  await downloadCsv('/inventory', { search: f.search, warehouse_id: f.warehouse_id, status: f.status, category: f.category, sort: f.sort })
                } catch (e) {
                  toast.error('Export failed', { description: errorMessage(e) })
                } finally {
                  setExporting(false)
                }
              }}
            >
              {!exporting && <Download />} Export CSV
            </Button>
            {canOps && (
              <>
                <Button variant="outline" onClick={() => openOp('transfer', null)}>
                  <ArrowLeftRight /> Transfer
                </Button>
                <Button onClick={() => openOp('receive', null)}>
                  <PackagePlus /> Receive stock
                </Button>
              </>
            )}
          </>
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center">
          <SearchInput value={f.search} onChange={(v) => setF({ search: v })} placeholder="Search SKU or product…" />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:flex">
            <NativeSelect aria-label="Warehouse" className="lg:w-44" value={f.warehouse_id} onChange={(e) => setF({ warehouse_id: e.target.value })}>
              <option value="">All warehouses</option>
              {warehouses.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect aria-label="Stock status" className="lg:w-40" value={f.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">All statuses</option>
              <option value="HEALTHY">Healthy</option>
              <option value="LOW_STOCK">Low stock</option>
              <option value="CRITICAL">Critical</option>
              <option value="OUT_OF_STOCK">Out of stock</option>
            </NativeSelect>
            <NativeSelect aria-label="Category" className="lg:w-48" value={f.category} onChange={(e) => setF({ category: e.target.value })}>
              <option value="">All categories</option>
              {categories.data?.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
          </div>
          {filtersActive && (
            <Button variant="ghost" size="sm" className="lg:ml-auto" onClick={() => setF({ search: '', warehouse_id: '', status: '', category: '' })}>
              <SlidersHorizontal /> Clear filters
            </Button>
          )}
        </div>
        <DataTable
          caption="Inventory by warehouse"
          columns={columns}
          rows={q.data?.items}
          rowKey={(i) => i.id}
          loading={q.isFetching}
          error={q.error}
          onRetry={() => q.refetch()}
          sort={f.sort}
          onSortChange={(sort) => setF({ sort })}
          onRowClick={setDetail}
          empty={
            <EmptyState
              title={filtersActive ? 'No matching stock' : 'No inventory yet'}
              description={filtersActive ? 'Try clearing filters or searching for another product.' : 'Receive stock or a purchase order to get started.'}
              action={
                canOps && !filtersActive ? (
                  <Button onClick={() => openOp('receive', null)}>
                    <PackagePlus /> Receive stock
                  </Button>
                ) : undefined
              }
            />
          }
          page={f.page}
          pageSize={f.page_size}
          total={q.data?.total}
          onPageChange={(page) => setF({ page }, { resetPage: false })}
          onPageSizeChange={(page_size) => setF({ page_size })}
        />
      </Card>

      <StockOperationDialog op={op} item={opItem} onOpenChange={(o) => !o && setOp(null)} />

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent aria-describedby="inv-detail-desc">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>{detail.product_name}</DialogTitle>
                <DialogDescription id="inv-detail-desc">
                  <span className="font-mono">{detail.sku}</span> · {detail.warehouse_name} ({detail.warehouse_code})
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <StockStatusBadge status={detail.status} />
                <span className="text-xs text-muted-foreground">Updated {fmt.relative(detail.updated_at)}</span>
              </div>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {[
                  ['On hand', fmt.int(detail.quantity_on_hand)],
                  ['Reserved', fmt.int(detail.reserved_quantity)],
                  ['Available', fmt.int(detail.available_quantity)],
                  ['Safety stock', fmt.int(detail.safety_stock)],
                  ['Reorder point', fmt.int(detail.reorder_point)],
                  ['Stock value', fmt.money(detail.stock_value)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border p-3">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-1 text-lg font-semibold tabular">{value}</dd>
                  </div>
                ))}
              </dl>
              {canOps && (
                <div className="flex flex-wrap gap-2">
                  {(['receive', 'issue', 'transfer', 'reserve', 'release'] as StockOp[]).map((o) => (
                    <Button key={o} variant="outline" size="sm" onClick={() => openOp(o, detail)} disabled={o === 'release' && detail.reserved_quantity === 0}>
                      {o[0].toUpperCase() + o.slice(1)}
                    </Button>
                  ))}
                  {can('stock_adjust') && (
                    <Button variant="outline" size="sm" onClick={() => openOp('adjust', detail)}>
                      Adjust
                    </Button>
                  )}
                </div>
              )}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Stock movements</h3>
                  <Button variant="link" size="sm" asChild>
                    <Link to={`/products/${detail.product_id}`}>Product details</Link>
                  </Button>
                </div>
                <div className="rounded-lg border">
                  <TransactionsTable productId={detail.product_id} warehouseId={detail.warehouse_id} showProduct={false} />
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Dialog>
    </>
  )
}
