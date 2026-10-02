import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowRight, Calculator, ClipboardList, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { type CSSProperties, useState } from 'react'
import { Link } from 'react-router-dom'
import { qk, useAllWarehouses, useCategories } from '@/api/queries'
import { type Column, DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { SearchInput } from '@/components/common/SearchInput'
import { EmptyState } from '@/components/common/States'
import { RISK_COLORS, RiskBadge } from '@/components/common/StatusBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogDescription, DialogHeader, DialogTitle, SheetContent } from '@/components/ui/dialog'
import { NativeSelect } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useUrlState } from '@/lib/hooks'
import type { RiskLevel, StockRisk, StockRiskPage } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { ExportCsvButton, InfoCallout } from './purchasing/shared'
import { DEMAND_SOURCE_LABEL, effectiveInbound } from './risk/riskUtils'

const DEFAULTS = { min_risk: 'LOW', level: '', warehouse_id: '', category: '', search: '', sort: 'risk', page: 1, page_size: 25 }
const LEVELS: RiskLevel[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
const LEVEL_LABEL: Record<RiskLevel, string> = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', NONE: 'No risk' }
const LEVEL_HINT: Record<RiskLevel, string> = {
  CRITICAL: 'Out of stock or will run out before a delivery can arrive',
  HIGH: 'Projected below safety stock within lead time',
  MEDIUM: 'At or below the reorder point',
  LOW: 'Approaching the reorder point',
  NONE: 'Healthy',
}

function Cover({ r }: { r: StockRisk }) {
  if (r.days_of_cover == null) return <span className="text-muted-foreground">No demand</span>
  return (
    <span className="inline-flex flex-col items-end">
      <span className={cn('tabular font-medium', r.days_of_cover < r.lead_time_days && 'text-red-600 dark:text-red-400')}>{fmt.num(r.days_of_cover)} d</span>
      {r.stockout_date && <span className="whitespace-nowrap text-xs text-muted-foreground">out {fmt.shortDate(r.stockout_date)}</span>}
    </span>
  )
}

export default function StockRisksPage() {
  const [f, setF] = useUrlState(DEFAULTS)
  const warehouses = useAllWarehouses()
  const categories = useCategories()
  const [selected, setSelected] = useState<StockRisk | null>(null)

  // Filtering, sorting and pagination happen server-side; `summary` carries the per-level
  // counts for the current warehouse/category/search so the cards show the full distribution.
  const params = {
    min_risk: f.min_risk,
    risk_level: f.level,
    warehouse_id: f.warehouse_id,
    category: f.category,
    search: f.search,
    sort: f.sort.replace(/projected$/, 'projected_stock_at_lead_time'),
    page: f.page,
    page_size: f.page_size,
  }
  const q = useQuery({
    queryKey: qk.shortages(params),
    queryFn: ({ signal }) => api.get<StockRiskPage>('/shortages', params, signal),
    placeholderData: keepPreviousData,
  })
  const counts: Record<RiskLevel, number> = q.data?.summary.by_risk_level ?? { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 }

  const columns: Column<StockRisk>[] = [
    {
      key: 'product',
      header: 'Product',
      sortKey: 'sku',
      cell: (r) => (
        <div className="min-w-0 max-w-[11rem] sm:max-w-[15rem]">
          <p className="truncate font-medium">{r.product_name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {r.sku}
            <span className="font-sans md:hidden"> · {r.warehouse_code}</span>
          </p>
        </div>
      ),
    },
    { key: 'wh', header: 'Warehouse', hideBelow: 'md', cell: (r) => <span className="whitespace-nowrap">{r.warehouse_code}</span> },
    { key: 'avail', header: 'Available', sortKey: 'available_quantity', align: 'right', hideBelow: 'sm', cell: (r) => <span className="font-medium tabular">{fmt.int(r.available_quantity)}</span> },
    {
      key: 'inbound',
      header: 'Inbound',
      align: 'right',
      hideBelow: 'xl',
      cell: (r) => {
        const inTime = effectiveInbound(r)
        return (
          <span className="inline-flex flex-col items-end">
            <span className={cn('tabular', inTime ? 'text-sky-700 dark:text-sky-400' : 'text-muted-foreground')}>{inTime ? `+${fmt.int(inTime)}` : '—'}</span>
            {r.inbound_quantity > inTime && (
              <span className="whitespace-nowrap text-xs text-muted-foreground" title="On draft or late purchase orders — not counted against the risk">
                +{fmt.int(r.inbound_quantity - inTime)} pending
              </span>
            )}
          </span>
        )
      },
    },
    {
      key: 'ltd',
      header: 'Lead-time demand',
      align: 'right',
      hideBelow: '2xl',
      cell: (r) => <span className="tabular text-muted-foreground">{fmt.num(r.demand_during_lead_time)}</span>,
    },
    { key: 'lt', header: 'Lead time', align: 'right', hideBelow: '2xl', cell: (r) => <span className="tabular text-muted-foreground">{r.lead_time_days} d</span> },
    {
      key: 'proj',
      header: 'Projected',
      sortKey: 'projected',
      align: 'right',
      hideBelow: 'sm',
      cell: (r) => (
        <span className={cn('font-medium tabular', r.projected_stock_at_lead_time < 0 ? 'text-red-600 dark:text-red-400' : r.projected_stock_at_lead_time < r.safety_stock ? 'text-amber-700 dark:text-amber-400' : '')}>
          {fmt.num(r.projected_stock_at_lead_time)}
        </span>
      ),
    },
    { key: 'cover', header: 'Cover', sortKey: 'days_of_cover', align: 'right', hideBelow: 'xl', cell: (r) => <Cover r={r} /> },
    { key: 'risk', header: 'Risk', sortKey: 'risk', cell: (r) => <RiskBadge level={r.risk_level} /> },
    {
      key: 'action',
      header: 'Recommended action',
      hideBelow: '2xl',
      cell: (r) => <p className="max-w-[16rem] truncate text-xs text-muted-foreground" title={r.recommended_action}>{r.recommended_action}</p>,
    },
  ]

  const filtersActive = f.level || f.min_risk !== 'LOW' || f.warehouse_id || f.category || f.search
  const clear = () => setF({ level: '', min_risk: 'LOW', warehouse_id: '', category: '', search: '' })

  return (
    <>
      <PageHeader
        title="Stock risks"
        description="Items projected to fall below safety stock before a new delivery could arrive."
        actions={
          <>
            <ExportCsvButton path="/shortages" query={{ min_risk: f.min_risk, risk_level: f.level, warehouse_id: f.warehouse_id, category: f.category, search: f.search, sort: params.sort }} />
            <Button asChild>
              <Link to={`/restocking${f.warehouse_id ? `?warehouse_id=${f.warehouse_id}` : ''}`}>
                <ClipboardList /> Restocking plan
              </Link>
            </Button>
          </>
        }
      />

      <section aria-label="Risk summary" className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {q.isLoading
          ? LEVELS.map((l) => <Skeleton key={l} className="h-[88px] rounded-xl" />)
          : LEVELS.map((l) => {
              const active = f.level === l
              return (
                <button
                  key={l}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setF({ level: active ? '' : l })}
                  className={cn(
                    'group relative flex min-w-0 cursor-pointer flex-col rounded-xl border bg-card p-4 text-left shadow-xs transition hover:shadow-sm focus-visible:outline-2 focus-visible:outline-ring',
                    active && 'ring-2',
                  )}
                  style={active ? ({ '--tw-ring-color': RISK_COLORS[l], borderColor: RISK_COLORS[l] } as CSSProperties) : undefined}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <span className="size-2.5 rounded-full" style={{ background: RISK_COLORS[l] }} aria-hidden />
                    {LEVEL_LABEL[l]}
                  </span>
                  <span className="mt-1 text-2xl font-semibold tabular">{fmt.int(counts[l])}</span>
                  <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{active ? 'Showing only these · click to clear' : LEVEL_HINT[l]}</span>
                </button>
              )
            })}
      </section>

      <Card>
        <div className="flex flex-col gap-2 border-b p-4 lg:flex-row lg:items-center">
          <SearchInput value={f.search} onChange={(v) => setF({ search: v })} placeholder="Search SKU or product…" />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:flex">
            <NativeSelect
              aria-label="Minimum risk level"
              className="lg:w-48"
              value={f.level ? '' : f.min_risk}
              onChange={(e) => setF({ min_risk: e.target.value || 'LOW', level: '' })}
            >
              {f.level && <option value="">{LEVEL_LABEL[f.level as RiskLevel]} only</option>}
              <option value="LOW">Low risk and above</option>
              <option value="MEDIUM">Medium and above</option>
              <option value="HIGH">High and above</option>
              <option value="CRITICAL">Critical only</option>
              <option value="NONE">All items (incl. healthy)</option>
            </NativeSelect>
            <NativeSelect aria-label="Warehouse" className="lg:w-40" value={f.warehouse_id} onChange={(e) => setF({ warehouse_id: e.target.value })}>
              <option value="">All warehouses</option>
              {warehouses.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code}
                </option>
              ))}
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
            <Button variant="ghost" size="sm" className="self-start lg:ml-auto lg:self-auto" onClick={clear}>
              <SlidersHorizontal /> Clear filters
            </Button>
          )}
        </div>
        <DataTable
          caption="Stock risks"
          columns={columns}
          rows={q.data?.items}
          rowKey={(r) => r.inventory_item_id}
          loading={q.isFetching}
          error={q.error}
          onRetry={() => q.refetch()}
          sort={f.sort}
          onSortChange={(sort) => setF({ sort })}
          onRowClick={setSelected}
          empty={
            <EmptyState
              icon={<ShieldCheck className="size-6" aria-hidden />}
              title={filtersActive ? 'No items match these filters' : 'No stock risks right now'}
              description={
                filtersActive
                  ? 'Try a lower risk threshold or another warehouse.'
                  : 'Every item is projected to stay above safety stock through its replenishment lead time.'
              }
              action={
                filtersActive ? (
                  <Button variant="outline" onClick={clear}>
                    Clear filters
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
      <p className="mt-3 text-xs text-muted-foreground">Click a row to see how its projection is calculated.</p>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent aria-describedby="risk-detail-desc">{selected && <RiskDetail r={selected} />}</SheetContent>
      </Dialog>
    </>
  )
}

function RiskDetail({ r }: { r: StockRisk }) {
  const inTime = effectiveInbound(r)
  const pending = r.inbound_quantity - inTime
  const rows: Array<{ label: string; value: string; sign?: string; strong?: boolean; tone?: string }> = [
    { label: 'Available now', value: fmt.int(r.available_quantity), sign: '' },
    { label: 'Inbound arriving within the lead time', value: fmt.int(inTime), sign: '+' },
    { label: `Demand during lead time (${fmt.num(r.avg_daily_demand)}/day × ${r.lead_time_days} days)`, value: fmt.num(r.demand_during_lead_time), sign: '−' },
    {
      label: 'Projected stock when a new order would arrive',
      value: fmt.num(r.projected_stock_at_lead_time),
      sign: '=',
      strong: true,
      tone: r.projected_stock_at_lead_time < 0 ? 'text-red-600 dark:text-red-400' : r.projected_stock_at_lead_time < r.safety_stock ? 'text-amber-700 dark:text-amber-400' : '',
    },
  ]
  return (
    <>
      <DialogHeader>
        <DialogTitle>{r.product_name}</DialogTitle>
        <DialogDescription id="risk-detail-desc">
          <span className="font-mono">{r.sku}</span> · {r.warehouse_name} ({r.warehouse_code}) · {r.category}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <RiskBadge level={r.risk_level} />
        <Badge variant="secondary">{DEMAND_SOURCE_LABEL[r.demand_source]}</Badge>
        {r.stockout_before_inbound && <Badge variant="danger">Runs out before next delivery</Badge>}
        {r.next_inbound_date && <Badge variant="info">Next delivery {fmt.shortDate(r.next_inbound_date)}</Badge>}
      </div>
      <div className="rounded-lg border-l-4 bg-muted/40 p-3" style={{ borderLeftColor: RISK_COLORS[r.risk_level] }}>
        <p className="text-sm font-medium">{r.reason}</p>
        <p className="mt-1 text-sm text-muted-foreground">{r.recommended_action}</p>
      </div>

      <section aria-labelledby="calc-h">
        <h3 id="calc-h" className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Calculator className="size-4 text-muted-foreground" aria-hidden /> How this is calculated
        </h3>
        <dl className="overflow-hidden rounded-lg border text-sm">
          {rows.map((row) => (
            <div key={row.label} className={cn('flex items-center justify-between gap-3 border-b px-3 py-2 last:border-0', row.strong && 'bg-muted/40')}>
              <dt className={cn('flex min-w-0 gap-2', row.strong ? 'font-medium' : 'text-muted-foreground')}>
                <span className="w-3 shrink-0 text-center font-mono text-muted-foreground" aria-hidden>
                  {row.sign}
                </span>
                <span>{row.label}</span>
              </dt>
              <dd className={cn('shrink-0 tabular', row.strong && 'text-base font-semibold', row.tone)}>{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          ['Avg daily demand', fmt.num(r.avg_daily_demand)],
          ['Safety stock', fmt.int(r.safety_stock)],
          ['Reorder point', fmt.num(r.reorder_point)],
          ['On hand', fmt.int(r.quantity_on_hand)],
          ['Days of cover', r.days_of_cover == null ? 'No demand' : `${fmt.num(r.days_of_cover)} days`],
          ['Stockout date', r.stockout_date ? fmt.date(r.stockout_date) : '—'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 font-semibold tabular">{value}</dd>
          </div>
        ))}
      </dl>

      <InfoCallout>
        {r.demand_source === 'FORECAST'
          ? 'Demand comes from the latest forecast for this item and warehouse.'
          : r.demand_source === 'HISTORICAL_AVERAGE'
            ? 'No forecast exists yet, so demand is the average of recent daily sales. Run a forecast for a sharper estimate.'
            : 'There is no sales history for this item, so no demand is projected.'}{' '}
        Risk compares projected stock with the safety stock ({fmt.int(r.safety_stock)}) and reorder point ({fmt.num(r.reorder_point)}). Only submitted or
        confirmed orders due within the lead time count as inbound
        {pending > 0 && (
          <>
            {' '}— <strong>{fmt.int(pending)} more units</strong> are on draft or later orders and will reduce the risk once submitted
          </>
        )}
        .{r.next_inbound_date && ` Next delivery expected ${fmt.date(r.next_inbound_date)}.`}
        {r.stockout_before_inbound && ' Stock is expected to run out before that delivery arrives.'}
      </InfoCallout>

      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link to={`/restocking?warehouse_id=${r.warehouse_id}&search=${encodeURIComponent(r.sku)}`}>
            Restock this item <ArrowRight />
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to={`/products/${r.product_id}`}>View product</Link>
        </Button>
        {r.demand_source !== 'NONE' && (
          <Button variant="outline" asChild>
            <Link to={`/forecasting?product_id=${r.product_id}&warehouse_id=${r.warehouse_id}`}>Forecast</Link>
          </Button>
        )}
      </div>
    </>
  )
}
