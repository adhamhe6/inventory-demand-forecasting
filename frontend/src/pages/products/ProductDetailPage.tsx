import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Boxes,
  ChevronDown,
  DollarSign,
  MoreHorizontal,
  PackageCheck,
  PackageSearch,
  Pencil,
  Power,
  Trash2,
  Truck,
} from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { qk, usePaged } from '@/api/queries'
import { type Column, DataTable } from '@/components/common/DataTable'
import { KpiCard } from '@/components/common/KpiCard'
import { CardsSkeleton, EmptyState, ErrorState } from '@/components/common/States'
import { ActiveBadge, POStatusBadge, RiskBadge, StockStatusBadge } from '@/components/common/StatusBadge'
import { type StockOp, StockOperationDialog } from '@/components/inventory/StockOperationDialog'
import { TransactionsTable } from '@/components/inventory/TransactionsTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ApiError, api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useUrlState } from '@/lib/hooks'
import type { InventoryItem, ProductDetail, PurchaseOrderSummary, RestockRecommendation, Sale, StockRisk } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { marginOf } from './formUtils'
import { ProductFormDialog } from './ProductFormDialog'
import { ProductForecastPanel } from './ProductForecastPanel'
import { useProductLifecycle } from './useProductLifecycle'

const TAB_DEFAULTS = { tab: 'overview', wh: 0 }
const TABS = ['overview', 'forecast', 'movements', 'purchase-orders', 'sales'] as const

const OPS: Array<{ op: StockOp; label: string }> = [
  { op: 'receive', label: 'Receive' },
  { op: 'issue', label: 'Issue' },
  { op: 'transfer', label: 'Transfer…' },
  { op: 'reserve', label: 'Reserve' },
  { op: 'release', label: 'Release reservation' },
  { op: 'return', label: 'Customer return' },
]

export default function ProductDetailPage() {
  const { id: rawId } = useParams()
  const id = Number(rawId)
  const validId = Number.isInteger(id) && id > 0
  const navigate = useNavigate()
  const { can } = useAuth()
  const [t, setT] = useUrlState(TAB_DEFAULTS)
  const tab = (TABS as readonly string[]).includes(t.tab) ? t.tab : 'overview'
  const [editOpen, setEditOpen] = useState(false)
  const [op, setOp] = useState<StockOp | null>(null)
  const [opItem, setOpItem] = useState<InventoryItem | null>(null)
  const lifecycle = useProductLifecycle({ onDeleted: () => navigate('/products', { replace: true }) })

  const q = useQuery({
    queryKey: qk.product(id),
    queryFn: ({ signal }) => api.get<ProductDetail>(`/products/${id}`, undefined, signal),
    enabled: validId,
    retry: (count, e) => !(e instanceof ApiError && e.status === 404) && count < 2,
  })

  if (!validId || (q.error instanceof ApiError && q.error.status === 404)) {
    return (
      <Card className="mx-auto mt-8 max-w-lg">
        <EmptyState
          icon={<PackageSearch className="size-6" />}
          title="Product not found"
          description={`We couldn't find a product with ID “${rawId}”. It may have been deleted, or the link is incorrect.`}
          action={
            <Button asChild>
              <Link to="/products">
                <ArrowLeft /> Back to products
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

  const p = q.data
  const canOps = can('stock_operations') && !!p?.is_active
  const openOp = (o: StockOp, item: InventoryItem | null = null) => {
    setOpItem(item)
    setOp(o)
  }
  const margin = p ? marginOf(p) : null
  const leadTime = p ? (p.supplier?.lead_time_days ?? p.lead_time_days) : null
  const forecastWarehouses = p?.stock.map((s) => ({ id: s.warehouse_id, code: s.warehouse_code, name: s.warehouse_name })) ?? []
  const selectedWh = forecastWarehouses.some((w) => w.id === t.wh) ? t.wh : (forecastWarehouses[0]?.id ?? null)

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link to="/products" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Products
        </Link>
      </nav>

      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        {p ? (
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-medium text-muted-foreground">{p.sku}</span>
              <ActiveBadge active={p.is_active} />
              <Badge variant="outline">{p.category}</Badge>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
            {p.description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{p.description}</p>}
          </div>
        ) : (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-7 w-72" />
          </div>
        )}
        {p && (
          <div className="flex flex-wrap items-center gap-2">
            {can('stock_operations') && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" disabled={!p.is_active} title={p.is_active ? undefined : 'Reactivate the product to move stock'}>
                    <ArrowLeftRight /> Stock operation <ChevronDown className="opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {OPS.map((o) => (
                    <DropdownMenuItem key={o.op} onSelect={() => openOp(o.op)}>
                      {o.label}
                    </DropdownMenuItem>
                  ))}
                  {can('stock_adjust') && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => openOp('adjust')}>Adjust…</DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {can('manage_products') && (
              <Button onClick={() => setEditOpen(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {(can('manage_products') || can('delete_products')) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More product actions" loading={lifecycle.reactivating}>
                    {!lifecycle.reactivating && <MoreHorizontal />}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {can('manage_products') && (
                    <DropdownMenuItem onSelect={() => (p.is_active ? lifecycle.requestDeactivate(p) : lifecycle.reactivate(p))}>
                      <Power /> {p.is_active ? 'Deactivate' : 'Reactivate'}
                    </DropdownMenuItem>
                  )}
                  {can('delete_products') && (
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => lifecycle.requestDelete(p)}>
                      <Trash2 /> Delete…
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>

      {!p ? (
        <CardsSkeleton count={4} />
      ) : (
        <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="Total on hand"
            value={`${fmt.int(p.total_on_hand)} ${p.unit}`}
            hint={`Across ${p.stock.length} warehouse${p.stock.length === 1 ? '' : 's'}`}
            icon={<Boxes />}
          />
          <KpiCard
            label="Available"
            value={fmt.int(p.total_available)}
            hint={`${fmt.int(p.total_on_hand - p.total_available)} reserved · reorder at ${fmt.int(p.reorder_point)}`}
            icon={<PackageCheck />}
            tone={p.total_available === 0 ? 'danger' : p.total_available <= p.reorder_point ? 'warning' : 'success'}
          />
          <KpiCard
            label="Price"
            value={fmt.money(p.price)}
            hint={
              <span>
                Cost {fmt.money(p.cost)} ·{' '}
                <span className={cn(margin != null && margin < 0 && 'text-destructive')}>{fmt.pct(margin)} margin</span>
              </span>
            }
            icon={<DollarSign />}
          />
          <KpiCard
            label="Supplier"
            value={
              p.supplier ? (
                <Link to={`/suppliers/${p.supplier.id}`} className="block truncate text-base hover:text-primary hover:underline" title={p.supplier.name}>
                  {p.supplier.name}
                </Link>
              ) : (
                <span className="text-lg text-muted-foreground">No supplier</span>
              )
            }
            hint={`Lead time ${leadTime} days${p.supplier ? '' : ' (product default)'}`}
            icon={<Truck />}
          />
        </section>
      )}

      <Tabs value={tab} onValueChange={(v) => setT({ tab: v })} className="mt-6">
        <TabsList aria-label="Product sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="forecast">Sales &amp; forecast</TabsTrigger>
          <TabsTrigger value="movements">Stock movements</TabsTrigger>
          <TabsTrigger value="purchase-orders">Purchase orders</TabsTrigger>
          <TabsTrigger value="sales">Recent sales</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="grid grid-cols-1 gap-6">
          {p && <StockByWarehouse productId={p.id} canOps={canOps} canAdjust={can('stock_adjust')} onOp={openOp} />}
          {p && (
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <ShortageRiskCard productId={p.id} sku={p.sku} />
              <RestockCard productId={p.id} sku={p.sku} />
            </div>
          )}
          {p && (
            <Card>
              <CardHeader>
                <CardTitle>Replenishment settings</CardTitle>
                <CardDescription>Product-level defaults; warehouses may override reorder points.</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
                  {[
                    ['Unit', p.unit],
                    ['Min stock', fmt.int(p.min_stock)],
                    ['Reorder point', fmt.int(p.reorder_point)],
                    ['Safety stock', fmt.int(p.safety_stock)],
                    ['Lead time (product)', `${p.lead_time_days} days`],
                    ['Last updated', fmt.date(p.updated_at)],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-xs text-muted-foreground">{k}</dt>
                      <dd className="mt-0.5 font-medium tabular">{v}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="forecast">
          {p && (
            <ProductForecastPanel
              productId={p.id}
              unit={p.unit}
              warehouses={forecastWarehouses}
              warehouseId={selectedWh}
              onWarehouseChange={(wh) => setT({ wh })}
            />
          )}
        </TabsContent>

        <TabsContent value="movements">
          <Card>
            <CardHeader>
              <CardTitle>Stock movements</CardTitle>
              <CardDescription>Every receipt, sale, transfer, reservation and adjustment for this product.</CardDescription>
            </CardHeader>
            {validId && <TransactionsTable productId={id} showProduct={false} />}
          </Card>
        </TabsContent>

        <TabsContent value="purchase-orders">{p && <ProductPurchaseOrders productId={p.id} />}</TabsContent>

        <TabsContent value="sales">{p && <RecentSales productId={p.id} sku={p.sku} unit={p.unit} />}</TabsContent>
      </Tabs>

      <ProductFormDialog open={editOpen} onOpenChange={setEditOpen} product={p ?? null} />
      <StockOperationDialog op={op} item={opItem} defaultProductId={p?.id} onOpenChange={(o) => !o && setOp(null)} />
      {lifecycle.dialogs}
    </>
  )
}

/* ------------------------------------------------------------------ overview: stock per warehouse */

function StockByWarehouse({
  productId,
  canOps,
  canAdjust,
  onOp,
}: {
  productId: number
  canOps: boolean
  canAdjust: boolean
  onOp: (op: StockOp, item: InventoryItem) => void
}) {
  const query = { product_id: productId, page_size: 100, sort: 'warehouse_code' }
  const q = usePaged<InventoryItem>(qk.inventory(query), '/inventory', query)
  const columns: Column<InventoryItem>[] = [
    {
      key: 'wh',
      header: 'Warehouse',
      cell: (i) => (
        <Link to={`/warehouses/${i.warehouse_id}`} className="group block min-w-0">
          <p className="font-medium group-hover:text-primary group-hover:underline">{i.warehouse_code}</p>
          <p className="hidden truncate text-xs text-muted-foreground sm:block">{i.warehouse_name}</p>
        </Link>
      ),
    },
    { key: 'onhand', header: 'On hand', align: 'right', cell: (i) => <span className="tabular">{fmt.int(i.quantity_on_hand)}</span> },
    { key: 'reserved', header: 'Reserved', align: 'right', hideBelow: 'md', cell: (i) => <span className="tabular text-muted-foreground">{fmt.int(i.reserved_quantity)}</span> },
    { key: 'available', header: 'Available', align: 'right', cell: (i) => <span className="font-semibold tabular">{fmt.int(i.available_quantity)}</span> },
    { key: 'rop', header: 'Reorder pt.', align: 'right', hideBelow: 'lg', cell: (i) => <span className="tabular text-muted-foreground">{fmt.int(i.reorder_point)}</span> },
    { key: 'ss', header: 'Safety', align: 'right', hideBelow: 'xl', cell: (i) => <span className="tabular text-muted-foreground">{fmt.int(i.safety_stock)}</span> },
    { key: 'value', header: 'Value', align: 'right', hideBelow: 'lg', cell: (i) => <span className="tabular">{fmt.money(i.stock_value)}</span> },
    { key: 'status', header: 'Status', cell: (i) => <StockStatusBadge status={i.status} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (i) =>
        canOps ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Stock actions for ${i.warehouse_code}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {OPS.map((o) => (
                <DropdownMenuItem key={o.op} onSelect={() => onOp(o.op, i)} disabled={o.op === 'release' && i.reserved_quantity === 0}>
                  {o.label}
                </DropdownMenuItem>
              ))}
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
      <CardHeader>
        <CardTitle>Stock by warehouse</CardTitle>
        <CardDescription>Status compares available units with each warehouse’s reorder point and safety stock.</CardDescription>
      </CardHeader>
      <DataTable
        caption="Stock by warehouse"
        columns={columns}
        rows={q.data?.items}
        rowKey={(i) => i.id}
        loading={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        empty={<EmptyState title="Not stocked anywhere yet" description="Receive stock or a purchase order to start tracking this product in a warehouse." />}
      />
    </Card>
  )
}

/* ------------------------------------------------------------------ overview: shortage risk */

function ShortageRiskCard({ productId, sku }: { productId: number; sku: string }) {
  const q = useQuery({
    queryKey: qk.shortages({ min_risk: 'NONE', search: sku }),
    queryFn: ({ signal }) => api.get<StockRisk[]>('/shortages', { min_risk: 'NONE', search: sku }, signal),
    select: (rows) => rows.filter((r) => r.product_id === productId),
  })
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="grid gap-1">
          <CardTitle>Shortage risk</CardTitle>
          <CardDescription>Projected stock at the end of the lead time</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/stock-risks?search=${encodeURIComponent(sku)}`}>
            Stock risks <ArrowRight />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data ? (
          <Skeleton className="h-28 w-full" />
        ) : q.data.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No risk data — this product isn’t stocked in any active warehouse yet.</p>
        ) : (
          <ul className="grid gap-3">
            {q.data.map((r) => (
              <li key={r.inventory_item_id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.warehouse_code}</span>
                    <RiskBadge level={r.risk_level} />
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {r.days_of_cover == null ? 'No demand signal' : `${fmt.num(r.days_of_cover)} days of cover`}
                    {r.stockout_date ? ` · stock-out ~${fmt.shortDate(r.stockout_date)}` : ''}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Available</dt>
                    <dd className="font-medium tabular">{fmt.int(r.available_quantity)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Lead-time demand</dt>
                    <dd className="font-medium tabular">{fmt.num(r.demand_during_lead_time)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Projected</dt>
                    <dd className={cn('font-medium tabular', r.projected_stock_at_lead_time < 0 && 'text-destructive')}>{fmt.num(r.projected_stock_at_lead_time)}</dd>
                  </div>
                </dl>
                <p className="mt-2 text-xs text-muted-foreground">
                  {r.reason}. <span className="font-medium text-foreground">{r.recommended_action}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ overview: restocking */

function RestockCard({ productId, sku }: { productId: number; sku: string }) {
  const { can } = useAuth()
  const q = useQuery({
    queryKey: qk.restocking({ search: sku }),
    queryFn: ({ signal }) => api.get<RestockRecommendation[]>('/restocking', { search: sku }, signal),
    select: (rows) => rows.filter((r) => r.product_id === productId),
  })
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="grid gap-1">
          <CardTitle>Restocking recommendation</CardTitle>
          <CardDescription>Order-up-to level covering lead time + review period</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/restocking?search=${encodeURIComponent(sku)}`}>
            Restocking <ArrowRight />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data ? (
          <Skeleton className="h-28 w-full" />
        ) : q.data.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-600">
              <PackageCheck className="size-5" aria-hidden />
            </div>
            <p className="text-sm font-medium">No reorder needed</p>
            <p className="max-w-xs text-xs text-muted-foreground">Current stock plus inbound orders covers expected demand in every warehouse.</p>
          </div>
        ) : (
          <ul className="grid gap-3">
            {q.data.map((r) => (
              <li key={r.inventory_item_id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.warehouse_code}</span>
                    <RiskBadge level={r.risk_level} />
                  </div>
                  <span className="text-sm">
                    Order <span className="font-semibold tabular">{fmt.int(r.recommended_quantity)}</span>
                    <span className="text-muted-foreground"> · {fmt.money(r.estimated_cost)}</span>
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{r.rationale}</p>
                {r.supplier_id && can('manage_purchase_orders') && (
                  <Button variant="link" size="sm" className="mt-1 h-auto px-0" asChild>
                    <Link to={`/purchase-orders/new?supplier_id=${r.supplier_id}&warehouse_id=${r.warehouse_id}`}>
                      Create purchase order with {r.supplier_name} <ArrowRight />
                    </Link>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ purchase orders */

function ProductPurchaseOrders({ productId }: { productId: number }) {
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [sort, setSort] = useState('-order_date')
  const query = { product_id: productId, page, page_size: pageSize, sort }
  const q = usePaged<PurchaseOrderSummary>(qk.purchaseOrders(query), '/purchase-orders', query)
  const columns: Column<PurchaseOrderSummary>[] = [
    {
      key: 'po',
      header: 'PO',
      sortKey: 'po_number',
      cell: (o) => (
        <Link to={`/purchase-orders/${o.id}`} onClick={(e) => e.stopPropagation()} className="whitespace-nowrap font-mono text-xs font-medium text-primary hover:underline">
          {o.po_number}
        </Link>
      ),
    },
    { key: 'supplier', header: 'Supplier', sortKey: 'supplier_name', hideBelow: 'md', cell: (o) => <span className="block max-w-[14rem] truncate">{o.supplier_name}</span> },
    { key: 'wh', header: 'Warehouse', hideBelow: 'sm', cell: (o) => o.warehouse_code },
    { key: 'status', header: 'Status', sortKey: 'status', cell: (o) => <POStatusBadge status={o.status} /> },
    { key: 'date', header: 'Ordered', sortKey: 'order_date', hideBelow: 'lg', cell: (o) => <span className="whitespace-nowrap text-muted-foreground">{fmt.date(o.order_date)}</span> },
    {
      key: 'eta',
      header: 'Expected',
      sortKey: 'expected_delivery_date',
      hideBelow: 'xl',
      cell: (o) => <span className="whitespace-nowrap text-muted-foreground">{fmt.date(o.received_date ?? o.expected_delivery_date)}</span>,
    },
    { key: 'total', header: 'PO total', sortKey: 'total_amount', align: 'right', cell: (o) => <span className="tabular">{fmt.money(o.total_amount)}</span> },
  ]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Purchase orders</CardTitle>
        <CardDescription>Orders that include this product (totals are for the whole order).</CardDescription>
      </CardHeader>
      <DataTable
        caption="Purchase orders containing this product"
        columns={columns}
        rows={q.data?.items}
        rowKey={(o) => o.id}
        loading={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        sort={sort}
        onSortChange={(s) => {
          setSort(s)
          setPage(1)
        }}
        onRowClick={(o) => navigate(`/purchase-orders/${o.id}`)}
        empty={<EmptyState title="No purchase orders yet" description="Purchase orders that include this product will be listed here." />}
        page={page}
        pageSize={pageSize}
        total={q.data?.total}
        onPageChange={setPage}
        onPageSizeChange={(s) => {
          setPageSize(s)
          setPage(1)
        }}
      />
    </Card>
  )
}

/* ------------------------------------------------------------------ recent sales */

function RecentSales({ productId, sku, unit }: { productId: number; sku: string; unit: string }) {
  const query = { product_id: productId, page_size: 10, sort: '-sold_at' }
  const q = usePaged<Sale>(qk.sales(query), '/sales', query)
  const columns: Column<Sale>[] = [
    { key: 'when', header: 'Sold', cell: (s) => <span className="whitespace-nowrap text-muted-foreground">{fmt.dateTime(s.sold_at)}</span> },
    { key: 'wh', header: 'Warehouse', hideBelow: 'sm', cell: (s) => s.warehouse_code },
    { key: 'order', header: 'Order', hideBelow: 'md', cell: (s) => <span className="font-mono text-xs">{s.order_reference}</span> },
    { key: 'qty', header: `Qty (${unit})`, align: 'right', cell: (s) => <span className="tabular">{fmt.int(s.quantity)}</span> },
    { key: 'price', header: 'Unit price', align: 'right', hideBelow: 'lg', cell: (s) => <span className="tabular text-muted-foreground">{fmt.money(s.unit_price)}</span> },
    { key: 'rev', header: 'Revenue', align: 'right', cell: (s) => <span className="font-medium tabular">{fmt.money(s.revenue)}</span> },
  ]
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="grid gap-1">
          <CardTitle>Recent sales</CardTitle>
          <CardDescription>{q.data ? `Latest 10 of ${fmt.int(q.data.total)} sales` : 'Latest 10 sales'}</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/sales?search=${encodeURIComponent(sku)}`}>
            All sales <ArrowRight />
          </Link>
        </Button>
      </CardHeader>
      <DataTable
        caption="Recent sales"
        columns={columns}
        rows={q.data?.items}
        rowKey={(s) => s.id}
        loading={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        empty={<EmptyState title="No sales recorded" description="Sales for this product will appear here once recorded or imported." />}
      />
    </Card>
  )
}
