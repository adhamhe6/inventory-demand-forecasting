import { useQuery } from '@tanstack/react-query'
import { AlarmClock, CircleDollarSign, ClipboardList, PackageCheck, Plus, SlidersHorizontal, Truck } from 'lucide-react'
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { qk, useAllSuppliers, useAllWarehouses, usePaged } from '@/api/queries'
import { type Column, DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { SearchInput } from '@/components/common/SearchInput'
import { EmptyState } from '@/components/common/States'
import { POStatusBadge } from '@/components/common/StatusBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useUrlState } from '@/lib/hooks'
import type { POStatus, PurchaseOrderSummary } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { DateRangeFilter, ExportCsvButton, MiniProgress } from './shared'
import { daysPast, isOverdue, OPEN_PO_STATUSES as OPEN, PO_STATUS_LABEL, PO_STATUS_ORDER, type POReport } from './utils'

const DEFAULTS = {
  page: 1,
  page_size: 25,
  search: '',
  status: '',
  supplier_id: '',
  warehouse_id: '',
  date_from: '',
  date_to: '',
  sort: '-created_at',
}

interface SummaryTileProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon: ReactNode
  tone?: 'default' | 'danger' | 'success' | 'warning'
  active?: boolean
  interactive?: boolean
}

const TILE_TONES = {
  default: 'bg-primary/10 text-primary',
  danger: 'bg-red-500/12 text-red-600 dark:text-red-400',
  success: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
}

const SummaryTile = forwardRef<HTMLButtonElement, SummaryTileProps>(
  ({ label, value, hint, icon, tone = 'default', active, interactive = true, className, ...props }, ref) => {
    const body = (
      <>
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-[18px]', TILE_TONES[tone])}>{icon}</span>
        <span className="min-w-0">
          <span className="block text-xs font-medium text-muted-foreground">{label}</span>
          <span className="block text-lg font-semibold tabular leading-tight">{value}</span>
          {hint && <span className="block truncate text-xs text-muted-foreground">{hint}</span>}
        </span>
      </>
    )
    const cls = cn(
      'flex w-full min-w-0 items-center gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition',
      interactive && 'cursor-pointer hover:border-primary/40 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-ring',
      active && 'border-primary ring-1 ring-primary',
      className,
    )
    if (!interactive) return <div className={cls}>{body}</div>
    return (
      <button ref={ref} type="button" className={cls} {...props}>
        {body}
      </button>
    )
  },
)
SummaryTile.displayName = 'SummaryTile'

export default function PurchaseOrdersPage() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const [f, setF] = useUrlState(DEFAULTS)
  const suppliers = useAllSuppliers()
  const warehouses = useAllWarehouses()
  const report = useQuery({ queryKey: qk.reports('purchase-orders'), queryFn: () => api.get<POReport>('/reports/purchase-orders') })

  const statuses = (f.status ? f.status.split(',') : []) as POStatus[]
  const query = {
    page: f.page,
    page_size: f.page_size,
    search: f.search,
    status: statuses,
    supplier_id: f.supplier_id,
    warehouse_id: f.warehouse_id,
    date_from: f.date_from,
    date_to: f.date_to,
    sort: f.sort,
  }
  const q = usePaged<PurchaseOrderSummary>(qk.purchaseOrders(query), '/purchase-orders', query)
  const canManage = can('manage_purchase_orders')

  const setStatuses = (next: POStatus[]) => setF({ status: PO_STATUS_ORDER.filter((s) => next.includes(s)).join(',') })
  const toggleStatus = (s: POStatus) => setStatuses(statuses.includes(s) ? statuses.filter((x) => x !== s) : [...statuses, s])
  const openSelected = OPEN.every((s) => statuses.includes(s)) && statuses.length === OPEN.length

  const byStatus = new Map(report.data?.by_status.map((s) => [s.status, s]))
  const openCount = OPEN.reduce((n, s) => n + (byStatus.get(s)?.count ?? 0), 0)
  const openValue = OPEN.reduce((n, s) => n + (byStatus.get(s)?.value ?? 0), 0)
  const inboundUnits = OPEN.filter((s) => s !== 'DRAFT').reduce((n, s) => n + (byStatus.get(s)?.outstanding_units ?? 0), 0)
  const overdue = report.data?.overdue ?? []
  const overdueCount = report.data?.overdue_count ?? overdue.length

  const columns: Column<PurchaseOrderSummary>[] = [
    {
      key: 'po',
      header: 'PO number',
      sortKey: 'po_number',
      cell: (po) => (
        <div className="flex flex-col items-start gap-1">
          <Link to={`/purchase-orders/${po.id}`} onClick={(e) => e.stopPropagation()} className="whitespace-nowrap font-mono text-xs font-medium text-primary hover:underline">
            {po.po_number}
          </Link>
          <span className="sm:hidden">
            <POStatusBadge status={po.status} />
          </span>
        </div>
      ),
    },
    {
      key: 'supplier',
      header: 'Supplier',
      sortKey: 'supplier_name',
      cell: (po) => (
        <div className="min-w-0 max-w-[11rem] sm:max-w-[13rem]">
          <p className="truncate font-medium">{po.supplier_name}</p>
          <p className="truncate text-xs text-muted-foreground xl:hidden">
            {po.warehouse_code}
            <span className="sm:hidden"> · {fmt.money(po.total_amount)}</span>
          </p>
        </div>
      ),
    },
    { key: 'wh', header: 'Warehouse', cell: (po) => <span className="whitespace-nowrap">{po.warehouse_code}</span>, hideBelow: 'xl' },
    { key: 'status', header: 'Status', sortKey: 'status', hideBelow: 'sm', cell: (po) => <POStatusBadge status={po.status} /> },
    { key: 'ordered', header: 'Ordered', sortKey: 'order_date', hideBelow: 'xl', cell: (po) => <span className="whitespace-nowrap tabular">{fmt.date(po.order_date)}</span> },
    {
      key: 'expected',
      header: 'Expected',
      sortKey: 'expected_delivery_date',
      hideBelow: 'md',
      cell: (po) =>
        isOverdue(po) ? (
          <span className="inline-flex flex-col">
            <span className="whitespace-nowrap font-medium text-red-600 tabular dark:text-red-400">{fmt.date(po.expected_delivery_date)}</span>
            <span className="text-xs text-red-600/80 dark:text-red-400/80">{daysPast(po.expected_delivery_date)}d overdue</span>
          </span>
        ) : (
          <span className="whitespace-nowrap tabular text-muted-foreground">{po.status === 'RECEIVED' && po.received_date ? `Rcvd ${fmt.shortDate(po.received_date)}` : fmt.date(po.expected_delivery_date)}</span>
        ),
    },
    {
      key: 'progress',
      header: 'Received',
      hideBelow: '2xl',
      cell: (po) => (
        <div className="w-32">
          <MiniProgress value={po.received_units} max={po.total_units} label={`${po.received_units} of ${po.total_units} units received`} />
          <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground tabular">
            {fmt.int(po.received_units)} / {fmt.int(po.total_units)} units
          </p>
        </div>
      ),
    },
    { key: 'lines', header: 'Lines', align: 'right', hideBelow: '2xl', cell: (po) => <span className="tabular text-muted-foreground">{po.line_count}</span> },
    { key: 'total', header: 'Total', sortKey: 'total_amount', align: 'right', hideBelow: 'sm', cell: (po) => <span className="whitespace-nowrap font-medium tabular">{fmt.money(po.total_amount)}</span> },
  ]

  const filtersActive = f.search || f.status || f.supplier_id || f.warehouse_id || f.date_from || f.date_to

  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="Track orders from draft to receipt, and receive goods into stock."
        actions={
          <>
            <ExportCsvButton
              path="/purchase-orders"
              query={{ search: f.search, status: statuses, supplier_id: f.supplier_id, warehouse_id: f.warehouse_id, date_from: f.date_from, date_to: f.date_to, sort: f.sort }}
            />
            {canManage && (
              <Button asChild>
                <Link to="/purchase-orders/new">
                  <Plus /> New purchase order
                </Link>
              </Button>
            )}
          </>
        }
      />

      <section aria-label="Purchase order summary" className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {report.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[74px] rounded-xl" />)
        ) : report.error ? (
          <p className="col-span-full text-sm text-muted-foreground">Summary unavailable right now.</p>
        ) : (
          <>
            <SummaryTile
              label="Open orders"
              value={fmt.int(openCount)}
              hint={`${fmt.moneyCompact(openValue)} committed`}
              icon={<ClipboardList />}
              onClick={() => setStatuses(openSelected ? [] : OPEN)}
              aria-pressed={openSelected}
              active={openSelected}
            />
            <SummaryTile label="Inbound units" value={fmt.int(inboundUnits)} hint="Ordered, not yet received" icon={<Truck />} interactive={false} />
            <Popover>
              <PopoverTrigger asChild>
                <SummaryTile
                  label="Overdue"
                  value={fmt.int(overdueCount)}
                  hint={overdueCount ? 'Past expected delivery' : 'Everything is on schedule'}
                  icon={<AlarmClock />}
                  tone={overdueCount ? 'danger' : 'success'}
                />
              </PopoverTrigger>
              <PopoverContent className="w-80 p-2">
                <p className="px-2 py-1.5 text-sm font-semibold">Overdue deliveries</p>
                {overdueCount > overdue.length && (
                  <p className="px-2 pb-1.5 text-xs text-muted-foreground">
                    Showing the {fmt.int(overdue.length)} most overdue of {fmt.int(overdueCount)}
                  </p>
                )}
                {overdue.length === 0 ? (
                  <p className="px-2 pb-2 text-sm text-muted-foreground">No open orders are past their expected delivery date.</p>
                ) : (
                  <ul className="max-h-72 overflow-y-auto">
                    {overdue.map((o) => (
                      <li key={o.id}>
                        <Link to={`/purchase-orders/${o.id}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                          <span className="min-w-0">
                            <span className="block font-mono text-xs font-medium text-primary">{o.po_number}</span>
                            <span className="block truncate text-xs text-muted-foreground">{o.supplier_name}</span>
                          </span>
                          <Badge variant="danger">{o.days_overdue}d late</Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </PopoverContent>
            </Popover>
            <SummaryTile
              label="Received"
              value={fmt.int(byStatus.get('RECEIVED')?.count ?? 0)}
              hint={`${fmt.moneyCompact(byStatus.get('RECEIVED')?.value ?? 0)} total value`}
              icon={<PackageCheck />}
              tone="success"
              onClick={() => setStatuses(statuses.length === 1 && statuses[0] === 'RECEIVED' ? [] : ['RECEIVED'])}
              aria-pressed={statuses.length === 1 && statuses[0] === 'RECEIVED'}
              active={statuses.length === 1 && statuses[0] === 'RECEIVED'}
            />
          </>
        )}
      </section>

      <Card>
        <div className="flex flex-col gap-3 border-b p-4">
          <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
            <button
              type="button"
              aria-pressed={statuses.length === 0}
              onClick={() => setStatuses([])}
              className={cn(
                'inline-flex h-7 cursor-pointer items-center rounded-full border px-3 text-xs font-medium transition',
                statuses.length === 0 ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted',
              )}
            >
              All
            </button>
            {PO_STATUS_ORDER.map((s) => {
              const on = statuses.includes(s)
              const count = byStatus.get(s)?.count
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleStatus(s)}
                  className={cn(
                    'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition',
                    on ? 'border-primary bg-primary/10 text-primary' : 'bg-card text-foreground hover:bg-muted',
                  )}
                >
                  {PO_STATUS_LABEL[s]}
                  {count != null && <span className={cn('tabular', on ? 'text-primary/80' : 'text-muted-foreground')}>{fmt.int(count)}</span>}
                </button>
              )
            })}
          </div>
          <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
            <SearchInput value={f.search} onChange={(v) => setF({ search: v })} placeholder="Search PO number or supplier…" />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex">
              <NativeSelect aria-label="Supplier" className="lg:w-48" value={f.supplier_id} onChange={(e) => setF({ supplier_id: e.target.value })}>
                <option value="">All suppliers</option>
                {suppliers.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect aria-label="Warehouse" className="lg:w-40" value={f.warehouse_id} onChange={(e) => setF({ warehouse_id: e.target.value })}>
                <option value="">All warehouses</option>
                {warehouses.data?.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <DateRangeFilter from={f.date_from} to={f.date_to} onChange={(p) => setF(p)} labelPrefix="Order date" />
            {filtersActive && (
              <Button
                variant="ghost"
                size="sm"
                className="self-start lg:ml-auto lg:self-auto"
                onClick={() => setF({ search: '', status: '', supplier_id: '', warehouse_id: '', date_from: '', date_to: '' })}
              >
                <SlidersHorizontal /> Clear filters
              </Button>
            )}
          </div>
        </div>
        <DataTable
          caption="Purchase orders"
          columns={columns}
          rows={q.data?.items}
          rowKey={(po) => po.id}
          loading={q.isFetching}
          error={q.error}
          onRetry={() => q.refetch()}
          sort={f.sort}
          onSortChange={(sort) => setF({ sort })}
          onRowClick={(po) => navigate(`/purchase-orders/${po.id}`)}
          empty={
            <EmptyState
              icon={<CircleDollarSign className="size-6" aria-hidden />}
              title={filtersActive ? 'No matching purchase orders' : 'No purchase orders yet'}
              description={
                filtersActive
                  ? 'Try another status, supplier or date range.'
                  : 'Create an order manually or generate draft orders from restocking recommendations.'
              }
              action={
                filtersActive ? (
                  <Button variant="outline" onClick={() => setF({ search: '', status: '', supplier_id: '', warehouse_id: '', date_from: '', date_to: '' })}>
                    Clear filters
                  </Button>
                ) : canManage ? (
                  <Button asChild>
                    <Link to="/purchase-orders/new">
                      <Plus /> New purchase order
                    </Link>
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
    </>
  )
}
