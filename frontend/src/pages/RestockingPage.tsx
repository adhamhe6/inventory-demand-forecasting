import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, CheckCircle2, CircleDollarSign, HelpCircle, PackageSearch, ShoppingCart, SlidersHorizontal, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { qk, useAllSuppliers, useAllWarehouses } from '@/api/queries'
import { type Column, DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { SearchInput } from '@/components/common/SearchInput'
import { EmptyState, InlineError } from '@/components/common/States'
import { RiskBadge } from '@/components/common/StatusBadge'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, NativeSelect } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useUrlState } from '@/lib/hooks'
import type { RestockRecommendation } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { Checkbox, ExportCsvButton, InfoCallout } from './purchasing/shared'
import { DEMAND_SOURCE_LABEL } from './risk/riskUtils'
import { buildRestockPlan, qtyError, sortRecommendations } from './risk/restockUtils'

const DEFAULTS = { warehouse_id: '', supplier_id: '', search: '', sort: 'risk', page: 1, page_size: 50 }

interface CreatedPOs {
  purchase_order_ids: number[]
  po_numbers: string[]
}

export default function RestockingPage() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const [f, setF] = useUrlState(DEFAULTS)
  const warehouses = useAllWarehouses()
  const suppliers = useAllSuppliers()
  const activeSuppliers = useMemo(() => suppliers.data?.filter((s) => s.status === 'ACTIVE') ?? [], [suppliers.data])
  const canCreate = can('manage_purchase_orders')

  const params = { warehouse_id: f.warehouse_id, supplier_id: f.supplier_id, search: f.search }
  const q = useQuery({ queryKey: qk.restocking(params), queryFn: ({ signal }) => api.get<RestockRecommendation[]>('/restocking', params, signal) })

  const [qty, setQty] = useState<Record<number, string>>({})
  const [supplierFor, setSupplierFor] = useState<Record<number, number>>({})
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [created, setCreated] = useState<CreatedPOs | null>(null)

  const rows = useMemo(() => sortRecommendations(q.data ?? [], f.sort), [q.data, f.sort])
  const supplierName = useMemo(() => new Map(suppliers.data?.map((s) => [s.id, s.name])), [suppliers.data])
  const qtyOf = (r: RestockRecommendation) => qty[r.inventory_item_id] ?? String(r.recommended_quantity)
  const supplierOf = (r: RestockRecommendation) => r.supplier_id ?? supplierFor[r.inventory_item_id] ?? null
  const costOf = (r: RestockRecommendation) => {
    const n = Number(qtyOf(r))
    return Number.isFinite(n) && n > 0 ? n * r.unit_cost : 0
  }
  const selectable = (r: RestockRecommendation) => !!supplierOf(r) && !qtyError(qtyOf(r))

  // Selection only counts rows still present in the current result set.
  const selectedRows = rows.filter((r) => selected.has(r.inventory_item_id))
  const validSelected = selectedRows.filter(selectable)
  const plan = buildRestockPlan(validSelected, { qtyOf, supplierOf, supplierName: (id) => supplierName.get(id) ?? `Supplier #${id}` })
  const selectableRows = rows.filter(selectable)
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.inventory_item_id))
  const someSelected = selectedRows.length > 0 && !allSelected

  const totalCost = rows.reduce((n, r) => n + costOf(r), 0)
  const criticalCount = rows.filter((r) => r.risk_level === 'CRITICAL').length
  const noSupplierCount = rows.filter((r) => !r.supplier_id).length

  const toggle = (id: number, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const create = useMutation({
    mutationFn: () =>
      api.post<CreatedPOs>('/restocking/purchase-orders', {
        items: plan.items,
      }),
    onSuccess: (res) => {
      ;[['restocking'], ['shortages'], ['purchase-orders'], ['dashboard'], ['reports'], ['suppliers']].forEach((key) => qc.invalidateQueries({ queryKey: key }))
      setCreated(res)
      setSelected(new Set())
      setQty({})
      setConfirming(false)
      toast.success(`Created ${res.po_numbers.length} draft purchase order${res.po_numbers.length === 1 ? '' : 's'}`, {
        description: (
          <span className="flex flex-wrap gap-x-2">
            {res.purchase_order_ids.map((id, i) => (
              <Link key={id} to={`/purchase-orders/${id}`} className="font-mono underline">
                {res.po_numbers[i]}
              </Link>
            ))}
          </span>
        ),
      })
    },
  })

  const supplierPicker = (r: RestockRecommendation, className?: string) => (
    <NativeSelect
      aria-label={`Supplier for ${r.sku} at ${r.warehouse_code}`}
      className={cn('h-8 w-36 text-xs', !supplierFor[r.inventory_item_id] && 'border-amber-500/60', className)}
      value={supplierFor[r.inventory_item_id] ?? ''}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setSupplierFor((prev) => ({ ...prev, [r.inventory_item_id]: Number(e.target.value) }))}
    >
      <option value="">Choose supplier…</option>
      {activeSuppliers.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </NativeSelect>
  )

  const columns: Column<RestockRecommendation>[] = [
    ...(canCreate
      ? [
          {
            key: 'select',
            header: (
              <Checkbox
                aria-label="Select all orderable items"
                checked={allSelected}
                indeterminate={someSelected}
                disabled={selectableRows.length === 0}
                onChange={(e) => setSelected(e.target.checked ? new Set(selectableRows.map((r) => r.inventory_item_id)) : new Set())}
              />
            ),
            headerClassName: 'w-10',
            cell: (r: RestockRecommendation) => {
              const box = (
                <Checkbox
                  aria-label={`Select ${r.sku} for ${r.warehouse_code}`}
                  checked={selected.has(r.inventory_item_id)}
                  disabled={!selectable(r)}
                  onChange={(e) => toggle(r.inventory_item_id, e.target.checked)}
                />
              )
              return selectable(r) ? (
                box
              ) : (
                <Tooltip content={!supplierOf(r) ? 'This product has no preferred supplier — choose one first' : 'Enter a valid quantity first'}>
                  <span className="inline-flex">{box}</span>
                </Tooltip>
              )
            },
          } satisfies Column<RestockRecommendation>,
        ]
      : []),
    {
      key: 'product',
      header: 'Product',
      sortKey: 'sku',
      cell: (r) => (
        <div className="min-w-0 max-w-[6.25rem] sm:max-w-[12rem]">
          <Link to={`/products/${r.product_id}`} className="block truncate font-medium hover:underline">
            {r.product_name}
          </Link>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {r.sku}
            <span className="font-sans 2xl:hidden"> · {r.warehouse_code}</span>
          </p>
          {!r.supplier_id && canCreate && <div className="mt-1 xl:hidden">{supplierPicker(r, 'w-full max-w-40')}</div>}
        </div>
      ),
    },
    { key: 'wh', header: 'Warehouse', hideBelow: '2xl', cell: (r) => <span className="whitespace-nowrap">{r.warehouse_code}</span> },
    {
      key: 'supplier',
      header: 'Supplier',
      hideBelow: 'xl',
      cell: (r) =>
        r.supplier_id ? (
          <span className="block max-w-[9rem] truncate" title={r.supplier_name ?? undefined}>{r.supplier_name}</span>
        ) : canCreate ? (
          supplierPicker(r)
        ) : (
          <span className="text-xs text-amber-700 dark:text-amber-400">No supplier</span>
        ),
    },
    { key: 'avail', header: 'Available', align: 'right', hideBelow: 'xl', cell: (r) => <span className="tabular">{fmt.int(r.available_quantity)}</span> },
    {
      key: 'inbound',
      header: 'Inbound',
      align: 'right',
      hideBelow: '2xl',
      cell: (r) => <span className={cn('tabular', r.inbound_quantity ? 'text-sky-700 dark:text-sky-400' : 'text-muted-foreground')}>{r.inbound_quantity ? `+${fmt.int(r.inbound_quantity)}` : '—'}</span>,
    },
    {
      key: 'demand',
      header: 'Demand / LT',
      align: 'right',
      hideBelow: '2xl',
      cell: (r) => (
        <span className="inline-flex flex-col items-end whitespace-nowrap">
          <span className="tabular">{fmt.num(r.avg_daily_demand)}/day</span>
          <span className="text-xs text-muted-foreground tabular">{r.lead_time_days}d lead</span>
        </span>
      ),
    },
    {
      key: 'ss',
      header: 'SS / ROP',
      align: 'right',
      hideBelow: '2xl',
      cell: (r) => (
        <span className="whitespace-nowrap tabular text-muted-foreground">
          {fmt.int(r.safety_stock)} / {fmt.num(r.reorder_point)}
        </span>
      ),
    },
    {
      key: 'qty',
      header: 'Order qty',
      sortKey: 'recommended_quantity',
      align: 'right',
      cell: (r) => {
        const v = qtyOf(r)
        const err = qtyError(v)
        const changed = v !== String(r.recommended_quantity)
        return canCreate ? (
          <div className="inline-flex flex-col items-end">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              aria-label={`Order quantity for ${r.sku} at ${r.warehouse_code}`}
              aria-invalid={!!err}
              title={err ?? undefined}
              className="h-8 w-16 text-right tabular sm:w-20"
              value={v}
              onChange={(e) => setQty((prev) => ({ ...prev, [r.inventory_item_id]: e.target.value }))}
            />
            {changed && !err && (
              <button
                type="button"
                className="mt-0.5 cursor-pointer text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                onClick={() =>
                  setQty((prev) => {
                    const next = { ...prev }
                    delete next[r.inventory_item_id]
                    return next
                  })
                }
              >
                reset to {fmt.int(r.recommended_quantity)}
              </button>
            )}
            {err && <span className="mt-0.5 text-[11px] font-medium text-destructive">{err}</span>}
          </div>
        ) : (
          <span className="font-semibold tabular">{fmt.int(r.recommended_quantity)}</span>
        )
      },
    },
    { key: 'cost', header: 'Est. cost', sortKey: 'estimated_cost', align: 'right', hideBelow: 'sm', cell: (r) => <span className="whitespace-nowrap font-medium tabular">{fmt.money(costOf(r))}</span> },
    { key: 'risk', header: 'Risk', sortKey: 'risk', hideBelow: 'md', cell: (r) => <RiskBadge level={r.risk_level} /> },
    {
      key: 'why',
      header: <span className="sr-only">Rationale</span>,
      align: 'right',
      cell: (r) => (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Why reorder ${r.sku} at ${r.warehouse_code}?`}>
              <HelpCircle />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-4 text-sm">
            <p className="font-semibold">
              {r.sku} · {r.warehouse_code}
            </p>
            <p className="mt-1 text-muted-foreground">{r.rationale}</p>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
              {[
                ['Available', fmt.int(r.available_quantity)],
                ['Inbound (open POs)', fmt.int(r.inbound_quantity)],
                ['Inventory position', fmt.int(r.inventory_position)],
                ['Avg daily demand', fmt.num(r.avg_daily_demand)],
                ['Lead time', `${r.lead_time_days} days`],
                ['Review period', `${r.review_period_days} days`],
                ['Lead-time demand', fmt.num(r.demand_during_lead_time)],
                ['Safety stock', fmt.int(r.safety_stock)],
                ['Reorder point', fmt.num(r.reorder_point)],
                ['Order-up-to level', fmt.num(r.order_up_to_level)],
                ['Unit cost', fmt.money(r.unit_cost)],
                ['Source', DEMAND_SOURCE_LABEL[r.demand_source].replace('Demand: ', '')],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="text-right font-medium tabular">{v}</dd>
                </div>
              ))}
            </dl>
          </PopoverContent>
        </Popover>
      ),
    },
  ]

  const filtersActive = f.warehouse_id || f.supplier_id || f.search
  const clear = () => setF({ warehouse_id: '', supplier_id: '', search: '' })

  return (
    <>
      <PageHeader
        title="Restocking"
        description="Recommended order quantities to bring each item back up to its target level."
        actions={<ExportCsvButton path="/restocking" query={params} />}
      />

      <InfoCallout className="mb-4">
        Quantities already on open purchase orders (including drafts) are counted as inbound and netted out, so items you've already ordered aren't suggested
        twice. Order-up-to = reorder point + demand over the review period.
      </InfoCallout>

      {created && (
        <InfoCallout tone="success" icon={<CheckCircle2 />} className="mb-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">
              Created {created.po_numbers.length} draft purchase order{created.po_numbers.length === 1 ? '' : 's'}:
            </span>
            {created.purchase_order_ids.map((id, i) => (
              <Link key={id} to={`/purchase-orders/${id}`} className="font-mono text-sm font-medium underline underline-offset-2">
                {created.po_numbers[i]}
              </Link>
            ))}
            <span className="text-xs opacity-80">Review and submit them to suppliers.</span>
            <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Dismiss" onClick={() => setCreated(null)}>
              <X />
            </Button>
          </div>
        </InfoCallout>
      )}

      <section aria-label="Restocking totals" className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {q.isLoading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[74px] rounded-xl" />)
        ) : (
          [
            { label: 'Items to reorder', value: fmt.int(rows.length), hint: noSupplierCount ? `${noSupplierCount} without a supplier` : 'All have a supplier', icon: <PackageSearch />, tone: 'bg-primary/10 text-primary' },
            { label: 'Total estimated cost', value: fmt.money(totalCost), hint: 'At current unit costs', icon: <CircleDollarSign />, tone: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' },
            {
              label: 'Critical items',
              value: fmt.int(criticalCount),
              hint: criticalCount ? 'Order these first' : 'Nothing critical',
              icon: <AlertOctagon />,
              tone: criticalCount ? 'bg-red-500/12 text-red-600 dark:text-red-400' : 'bg-muted text-muted-foreground',
            },
          ].map((t) => (
            <Card key={t.label} className="flex items-center gap-3 p-4">
              <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-[18px]', t.tone)} aria-hidden>
                {t.icon}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-muted-foreground">{t.label}</span>
                <span className="block text-lg font-semibold tabular leading-tight">{t.value}</span>
                <span className="block truncate text-xs text-muted-foreground">{t.hint}</span>
              </span>
            </Card>
          ))
        )}
      </section>

      <Card>
        <div className="flex flex-col gap-2 border-b p-4 lg:flex-row lg:items-center">
          <SearchInput value={f.search} onChange={(v) => setF({ search: v })} placeholder="Search SKU or product…" />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex">
            <NativeSelect aria-label="Warehouse" className="lg:w-40" value={f.warehouse_id} onChange={(e) => setF({ warehouse_id: e.target.value })}>
              <option value="">All warehouses</option>
              {warehouses.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect aria-label="Supplier" className="lg:w-52" value={f.supplier_id} onChange={(e) => setF({ supplier_id: e.target.value })}>
              <option value="">All suppliers</option>
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
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
          caption="Restocking recommendations"
          columns={columns}
          rows={q.data ? rows.slice((f.page - 1) * f.page_size, f.page * f.page_size) : undefined}
          rowKey={(r) => r.inventory_item_id}
          loading={q.isFetching}
          error={q.error}
          onRetry={() => q.refetch()}
          sort={f.sort}
          onSortChange={(sort) => setF({ sort })}
          empty={
            <EmptyState
              icon={<CheckCircle2 className="size-6" aria-hidden />}
              title={filtersActive ? 'No recommendations match these filters' : 'Nothing needs reordering'}
              description={
                filtersActive
                  ? 'Try another warehouse or supplier.'
                  : 'Every item is above its reorder point once open purchase orders are counted.'
              }
              action={
                filtersActive ? (
                  <Button variant="outline" onClick={clear}>
                    Clear filters
                  </Button>
                ) : (
                  <Button variant="outline" asChild>
                    <Link to="/stock-risks">View stock risks</Link>
                  </Button>
                )
              }
            />
          }
          page={f.page}
          pageSize={f.page_size}
          total={q.data ? rows.length : undefined}
          onPageChange={(page) => setF({ page }, { resetPage: false })}
          onPageSizeChange={(page_size) => setF({ page_size })}
        />
      </Card>

      {canCreate && validSelected.length > 0 && (
        <div className="sticky bottom-4 z-20 mt-4 flex flex-col gap-3 rounded-xl border bg-card/95 p-3 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <p className="text-sm">
            <span className="font-semibold">{validSelected.length}</span> item{validSelected.length === 1 ? '' : 's'} selected ·{' '}
            <span className="font-semibold">{plan.groups.length}</span> draft PO{plan.groups.length === 1 ? '' : 's'} ·{' '}
            <span className="font-semibold tabular">{fmt.money(plan.total)}</span>
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button onClick={() => setConfirming(true)}>
              <ShoppingCart /> Create purchase orders
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={(o) => !create.isPending && setConfirming(o)}
        title={`Create ${plan.groups.length} draft purchase order${plan.groups.length === 1 ? '' : 's'}?`}
        confirmLabel="Create drafts"
        loading={create.isPending}
        onConfirm={() => create.mutate()}
        description={
          <p>
            One draft per supplier and warehouse. Nothing is sent to suppliers until you submit each order.
          </p>
        }
      >
        <ul className="max-h-64 divide-y overflow-y-auto rounded-md border text-sm">
          {plan.groups.map((g) => (
            <li key={g.key} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate font-medium">{g.supplierName}</span>
                <span className="block text-xs text-muted-foreground">
                  → {g.warehouseCode} · {g.items} item{g.items === 1 ? '' : 's'} · {fmt.int(g.units)} units
                </span>
              </span>
              <span className="shrink-0 font-medium tabular">{fmt.money(g.cost)}</span>
            </li>
          ))}
        </ul>
        <p className="flex justify-between text-sm">
          <span className="text-muted-foreground">Total estimated cost</span>
          <strong className="tabular">{fmt.money(plan.total)}</strong>
        </p>
        <InlineError error={create.error} />
      </ConfirmDialog>
    </>
  )
}
