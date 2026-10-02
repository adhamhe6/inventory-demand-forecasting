import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  Boxes,
  CheckCircle2,
  DollarSign,
  KeyRound,
  Lock,
  MapPin,
  MoreHorizontal,
  PackagePlus,
  Pencil,
  SlidersHorizontal,
  Warehouse as WarehouseIcon,
} from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { qk, usePaged } from '@/api/queries'
import { type Column, DataTable } from '@/components/common/DataTable'
import { KpiCard } from '@/components/common/KpiCard'
import { SearchInput } from '@/components/common/SearchInput'
import { CardsSkeleton, EmptyState, ErrorState } from '@/components/common/States'
import { StockStatusBadge } from '@/components/common/StatusBadge'
import { type StockOp, StockOperationDialog } from '@/components/inventory/StockOperationDialog'
import { TransactionsTable } from '@/components/inventory/TransactionsTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NativeSelect } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ApiError, api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useUrlState } from '@/lib/hooks'
import type { InventoryItem, Warehouse, WarehouseSummary } from '@/lib/types'
import { fmt } from '@/lib/utils'
import { WarehouseFormDialog } from './WarehouseFormDialog'

const DEFAULTS = { tab: 'inventory', page: 1, page_size: 25, search: '', status: '', sort: 'status' }
const TABS = ['inventory', 'movements', 'transfer'] as const

export default function WarehouseDetailPage() {
  const { id: rawId } = useParams()
  const id = Number(rawId)
  const validId = Number.isInteger(id) && id > 0
  const { can } = useAuth()
  const [f, setF] = useUrlState(DEFAULTS)
  const tab = (TABS as readonly string[]).includes(f.tab) ? f.tab : 'inventory'
  const [editOpen, setEditOpen] = useState(false)
  const [op, setOp] = useState<StockOp | null>(null)
  const [opItem, setOpItem] = useState<InventoryItem | null>(null)

  const q = useQuery({
    queryKey: qk.warehouses({ id }),
    queryFn: ({ signal }) => api.get<Warehouse>(`/warehouses/${id}`, undefined, signal),
    enabled: validId,
    retry: (count, e) => !(e instanceof ApiError && e.status === 404) && count < 2,
  })
  const summary = useQuery({
    queryKey: qk.warehouseSummary,
    queryFn: ({ signal }) => api.get<WarehouseSummary[]>('/warehouses/summary', undefined, signal),
    enabled: validId,
    select: (rows) => rows.find((r) => r.id === id) ?? null,
  })

  if (!validId || (q.error instanceof ApiError && q.error.status === 404)) {
    return (
      <Card className="mx-auto mt-8 max-w-lg">
        <EmptyState
          icon={<WarehouseIcon className="size-6" />}
          title="Warehouse not found"
          description={`We couldn't find a warehouse with ID “${rawId}”. The link may be incorrect.`}
          action={
            <Button asChild>
              <Link to="/warehouses">
                <ArrowLeft /> Back to warehouses
              </Link>
            </Button>
          }
        />
      </Card>
    )
  }
  if (q.error) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    )
  }

  const w = q.data
  const s = summary.data
  const active = w?.status === 'ACTIVE'
  const canOps = can('stock_operations') && active
  const openOp = (o: StockOp, item: InventoryItem | null = null) => {
    setOpItem(item)
    setOp(o)
  }

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link to="/warehouses" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Warehouses
        </Link>
      </nav>

      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        {w ? (
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-primary">{w.code}</span>
              {active ? <Badge variant="success">Active</Badge> : <Badge variant="muted">Inactive</Badge>}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">{w.name}</h1>
            <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
              <MapPin className="size-3.5" aria-hidden /> {w.location ?? 'No location set'}
            </p>
          </div>
        ) : (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-7 w-72" />
          </div>
        )}
        {w && (
          <div className="flex flex-wrap items-center gap-2">
            {can('manage_warehouses') && (
              <Button variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {canOps && (
              <>
                <Button variant="outline" onClick={() => setF({ tab: 'transfer' })}>
                  <ArrowLeftRight /> Transfer
                </Button>
                <Button onClick={() => openOp('receive')}>
                  <PackagePlus /> Receive stock
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {w && !active && (
        <div role="status" className="mb-6 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>This warehouse is inactive. Its stock and history are visible, but receipts, issues, sales and transfers are blocked until it is reactivated.</span>
        </div>
      )}

      {!s && summary.isLoading ? (
        <CardsSkeleton count={4} />
      ) : s ? (
        <section aria-label="Warehouse summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Units on hand" value={fmt.int(s.total_units)} hint={`${fmt.int(s.reserved_units)} reserved`} icon={<Boxes />} />
          <KpiCard label="Inventory value" value={fmt.money(s.inventory_value)} hint="At cost" icon={<DollarSign />} />
          <KpiCard label="Products stocked" value={fmt.int(s.product_count)} hint="With units on hand" icon={<WarehouseIcon />} />
          <KpiCard
            label="Low-stock items"
            value={fmt.int(s.low_stock_items)}
            hint="At or below reorder point"
            icon={<AlertTriangle />}
            tone={s.low_stock_items ? 'warning' : 'success'}
          />
        </section>
      ) : null}

      <Tabs value={tab} onValueChange={(v) => setF({ tab: v })} className="mt-6">
        <TabsList aria-label="Warehouse sections">
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="movements">Movements</TabsTrigger>
          <TabsTrigger value="transfer">
            <ArrowLeftRight /> Transfer
          </TabsTrigger>
        </TabsList>

        <TabsContent value="inventory">
          <InventoryTab warehouseId={id} f={f} setF={setF} canOps={canOps} canAdjust={can('stock_adjust')} onOp={openOp} />
        </TabsContent>

        <TabsContent value="movements">
          <Card>
            <CardHeader>
              <CardTitle>Stock movements</CardTitle>
              <CardDescription>Audit ledger of every change to stock in this warehouse.</CardDescription>
            </CardHeader>
            <TransactionsTable warehouseId={id} />
          </Card>
        </TabsContent>

        <TabsContent value="transfer">{w && <TransferTab warehouse={w} canOps={canOps} canTransfer={can('stock_operations')} onOp={openOp} />}</TabsContent>
      </Tabs>

      <WarehouseFormDialog open={editOpen} onOpenChange={setEditOpen} warehouse={w ?? null} />
      <StockOperationDialog op={op} item={opItem} defaultWarehouseId={id} onOpenChange={(o) => !o && setOp(null)} />
    </>
  )
}

/* ------------------------------------------------------------------ inventory tab */

type Filters = typeof DEFAULTS

function InventoryTab({
  warehouseId,
  f,
  setF,
  canOps,
  canAdjust,
  onOp,
}: {
  warehouseId: number
  f: Filters
  setF: (patch: Partial<Filters>, opts?: { resetPage?: boolean }) => void
  canOps: boolean
  canAdjust: boolean
  onOp: (op: StockOp, item: InventoryItem) => void
}) {
  const query = { warehouse_id: warehouseId, page: f.page, page_size: f.page_size, search: f.search, status: f.status, sort: f.sort }
  const q = usePaged<InventoryItem>(qk.inventory(query), '/inventory', query)
  const filtersActive = f.search || f.status

  const columns: Column<InventoryItem>[] = [
    {
      key: 'sku',
      header: 'SKU',
      sortKey: 'sku',
      cell: (i) => (
        <Link to={`/products/${i.product_id}`} className="whitespace-nowrap font-mono text-xs font-medium text-primary hover:underline">
          {i.sku}
        </Link>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      sortKey: 'product_name',
      hideBelow: 'sm',
      cell: (i) => (
        <div className="min-w-0 max-w-[16rem]">
          <p className="truncate font-medium">{i.product_name}</p>
          <p className="truncate text-xs text-muted-foreground">{i.category}</p>
        </div>
      ),
    },
    { key: 'onhand', header: 'On hand', sortKey: 'quantity_on_hand', align: 'right', hideBelow: 'md', cell: (i) => <span className="tabular">{fmt.int(i.quantity_on_hand)}</span> },
    { key: 'reserved', header: 'Reserved', sortKey: 'reserved_quantity', align: 'right', hideBelow: 'lg', cell: (i) => <span className="tabular text-muted-foreground">{fmt.int(i.reserved_quantity)}</span> },
    { key: 'available', header: 'Available', sortKey: 'available_quantity', align: 'right', cell: (i) => <span className="font-semibold tabular">{fmt.int(i.available_quantity)}</span> },
    { key: 'rop', header: 'Reorder pt.', sortKey: 'reorder_point', align: 'right', hideBelow: 'xl', cell: (i) => <span className="tabular text-muted-foreground">{fmt.int(i.reorder_point)}</span> },
    { key: 'value', header: 'Value', sortKey: 'stock_value', align: 'right', hideBelow: 'xl', cell: (i) => <span className="tabular">{fmt.money(i.stock_value)}</span> },
    { key: 'status', header: 'Status', sortKey: 'status', cell: (i) => <StockStatusBadge status={i.status} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (i) =>
        canOps ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Stock actions for ${i.sku}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onOp('receive', i)}>Receive</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onOp('issue', i)} disabled={i.available_quantity === 0}>
                Issue
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onOp('transfer', i)} disabled={i.available_quantity === 0}>
                Transfer…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onOp('reserve', i)} disabled={i.available_quantity === 0}>
                Reserve
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onOp('release', i)} disabled={i.reserved_quantity === 0}>
                Release reservation
              </DropdownMenuItem>
              {canAdjust && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onOp('adjust', i)}>Adjust…</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null,
    },
  ]

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
        <SearchInput value={f.search} onChange={(v) => setF({ search: v })} placeholder="Search SKU or product…" />
        <NativeSelect aria-label="Stock status" className="sm:w-44" value={f.status} onChange={(e) => setF({ status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="HEALTHY">Healthy</option>
          <option value="LOW_STOCK">Low stock</option>
          <option value="CRITICAL">Critical</option>
          <option value="OUT_OF_STOCK">Out of stock</option>
        </NativeSelect>
        {filtersActive && (
          <Button variant="ghost" size="sm" className="sm:ml-auto" onClick={() => setF({ search: '', status: '' })}>
            <SlidersHorizontal /> Clear filters
          </Button>
        )}
      </div>
      <DataTable
        caption="Inventory in this warehouse"
        columns={columns}
        rows={q.data?.items}
        rowKey={(i) => i.id}
        loading={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        sort={f.sort}
        onSortChange={(sort) => setF({ sort })}
        empty={
          <EmptyState
            title={filtersActive ? 'No matching stock' : 'No stock in this warehouse yet'}
            description={filtersActive ? 'Try clearing filters or searching for another product.' : 'Receive stock or a purchase order into this warehouse to get started.'}
          />
        }
        page={f.page}
        pageSize={f.page_size}
        total={q.data?.total}
        onPageChange={(page) => setF({ page }, { resetPage: false })}
        onPageSizeChange={(page_size) => setF({ page_size })}
      />
    </Card>
  )
}

/* ------------------------------------------------------------------ transfer tab */

function TransferTab({
  warehouse,
  canOps,
  canTransfer,
  onOp,
}: {
  warehouse: Warehouse
  canOps: boolean
  canTransfer: boolean
  onOp: (op: StockOp, item?: InventoryItem | null) => void
}) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const query = { warehouse_id: warehouse.id, search, page, page_size: 10, sort: '-available_quantity' }
  const q = usePaged<InventoryItem>(qk.inventory(query), '/inventory', query, canOps)
  const blockedReason = !canTransfer
    ? 'Your role cannot move stock between warehouses.'
    : warehouse.status !== 'ACTIVE'
      ? 'Reactivate this warehouse before transferring stock out of it.'
      : null

  const columns: Column<InventoryItem>[] = [
    {
      key: 'product',
      header: 'Product',
      cell: (i) => (
        <div className="min-w-0 max-w-[9rem] sm:max-w-[18rem]">
          <p className="truncate font-mono text-xs font-medium">{i.sku}</p>
          <p className="truncate text-sm text-muted-foreground">{i.product_name}</p>
        </div>
      ),
    },
    { key: 'reserved', header: 'Reserved', align: 'right', hideBelow: 'sm', cell: (i) => <span className="tabular text-muted-foreground">{fmt.int(i.reserved_quantity)}</span> },
    { key: 'available', header: 'Available', align: 'right', cell: (i) => <span className="font-semibold tabular">{fmt.int(i.available_quantity)}</span> },
    {
      key: 'go',
      header: <span className="sr-only">Transfer</span>,
      align: 'right',
      cell: (i) => (
        <Button size="sm" variant="outline" disabled={i.available_quantity <= 0} onClick={() => onOp('transfer', i)} aria-label={`Transfer ${i.sku}`}>
          <ArrowLeftRight /> <span className="hidden sm:inline">Transfer</span>
        </Button>
      ),
    },
  ]

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
      <Card className="xl:col-span-2 xl:self-start">
        <CardHeader>
          <CardTitle>Transfer stock out of {warehouse.code}</CardTitle>
          <CardDescription>Move units to another warehouse in a single, all-or-nothing operation.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <ol className="grid gap-3 text-sm">
            {[
              { icon: CheckCircle2, title: 'Only available stock moves', body: 'Reserved units stay put. The quantity is checked against what is available here at the moment you submit.' },
              { icon: ArrowLeftRight, title: 'Atomic: both sides or nothing', body: `A TRANSFER_OUT from ${warehouse.code} and a TRANSFER_IN at the destination are written in one database transaction and linked in the ledger. If anything fails, no stock moves.` },
              { icon: KeyRound, title: 'Safe to retry', body: 'Each submission carries an idempotency key, so a double-click or network retry can’t move stock twice.' },
            ].map((s) => (
              <li key={s.title} className="flex gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <s.icon className="size-4" aria-hidden />
                </span>
                <div>
                  <p className="font-medium">{s.title}</p>
                  <p className="text-muted-foreground">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
          {blockedReason ? (
            <p className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              <Lock className="mt-0.5 size-4 shrink-0" aria-hidden /> {blockedReason}
            </p>
          ) : (
            <Button size="lg" onClick={() => onOp('transfer', null)} className="w-full sm:w-auto">
              <ArrowLeftRight /> Start a transfer from {warehouse.code}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className="xl:col-span-3">
        <CardHeader>
          <CardTitle>Pick an item to transfer</CardTitle>
          <CardDescription>Source and product are locked in, so only the destination and quantity are left to choose.</CardDescription>
        </CardHeader>
        {canOps ? (
          <>
            <div className="border-y px-4 py-3">
              <SearchInput
                value={search}
                onChange={(v) => {
                  setSearch(v)
                  setPage(1)
                }}
                placeholder="Search SKU or product…"
              />
            </div>
            <DataTable
              caption="Items available to transfer"
              columns={columns}
              rows={q.data?.items}
              rowKey={(i) => i.id}
              loading={q.isFetching}
              error={q.error}
              onRetry={() => q.refetch()}
              empty={<EmptyState title={search ? 'No matching items' : 'Nothing to transfer'} description={search ? 'Try another search.' : 'This warehouse has no stock yet.'} />}
              page={page}
              pageSize={10}
              total={q.data?.total}
              onPageChange={setPage}
            />
          </>
        ) : (
          <CardContent>
            <p className="py-6 text-center text-sm text-muted-foreground">{blockedReason}</p>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
