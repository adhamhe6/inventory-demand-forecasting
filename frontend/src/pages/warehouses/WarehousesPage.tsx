import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, Boxes, DollarSign, MapPin, Pencil, Plus, Warehouse as WarehouseIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { qk } from '@/api/queries'
import { KpiCard } from '@/components/common/KpiCard'
import { PageHeader } from '@/components/common/PageHeader'
import { SearchInput } from '@/components/common/SearchInput'
import { CardsSkeleton, EmptyState, ErrorState } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useUrlState } from '@/lib/hooks'
import type { Warehouse, WarehouseSummary } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { WarehouseFormDialog } from './WarehouseFormDialog'

const DEFAULTS = { search: '', status: '' }

export default function WarehousesPage() {
  const { can } = useAuth()
  const canManage = can('manage_warehouses')
  const [f, setF] = useUrlState(DEFAULTS)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Warehouse | null>(null)
  const q = useQuery({ queryKey: qk.warehouseSummary, queryFn: ({ signal }) => api.get<WarehouseSummary[]>('/warehouses/summary', undefined, signal) })

  const rows = useMemo(() => {
    const term = f.search.trim().toLowerCase()
    return (q.data ?? []).filter(
      (w) =>
        (!f.status || w.status === f.status) &&
        (!term || [w.code, w.name, w.location ?? ''].some((s) => s.toLowerCase().includes(term))),
    )
  }, [q.data, f.search, f.status])

  const totals = useMemo(() => {
    const active = (q.data ?? []).filter((w) => w.status === 'ACTIVE')
    return {
      count: q.data?.length ?? 0,
      active: active.length,
      units: (q.data ?? []).reduce((s, w) => s + w.total_units, 0),
      reserved: (q.data ?? []).reduce((s, w) => s + w.reserved_units, 0),
      value: (q.data ?? []).reduce((s, w) => s + w.inventory_value, 0),
      low: (q.data ?? []).reduce((s, w) => s + w.low_stock_items, 0),
    }
  }, [q.data])

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (w: Warehouse) => {
    setEditing(w)
    setFormOpen(true)
  }
  const filtersActive = f.search || f.status

  return (
    <>
      <PageHeader
        title="Warehouses"
        description="Stocking locations with live units, value and low-stock counts."
        actions={
          canManage && (
            <Button onClick={openCreate}>
              <Plus /> New warehouse
            </Button>
          )
        }
      />

      {q.error ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : !q.data ? (
        <div className="space-y-6">
          <CardsSkeleton count={4} />
          <CardsSkeleton count={3} />
        </div>
      ) : q.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<WarehouseIcon className="size-6" />}
            title="No warehouses yet"
            description="Create your first warehouse to start receiving and tracking stock."
            action={
              canManage ? (
                <Button onClick={openCreate}>
                  <Plus /> New warehouse
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="space-y-6">
          <section aria-label="Network totals" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Warehouses" value={fmt.int(totals.count)} hint={`${totals.active} active`} icon={<WarehouseIcon />} />
            <KpiCard label="Units on hand" value={fmt.int(totals.units)} hint={`${fmt.int(totals.reserved)} reserved`} icon={<Boxes />} />
            <KpiCard label="Inventory value" value={fmt.moneyCompact(totals.value)} hint="At cost, all warehouses" icon={<DollarSign />} />
            <KpiCard
              label="Low-stock items"
              value={fmt.int(totals.low)}
              hint="At or below reorder point"
              icon={<AlertTriangle />}
              tone={totals.low ? 'warning' : 'success'}
              to="/inventory"
            />
          </section>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <SearchInput value={f.search} onChange={(v) => setF({ search: v })} placeholder="Search code, name or location…" />
            <NativeSelect aria-label="Status" className="sm:w-40" value={f.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </NativeSelect>
            <p className="text-sm text-muted-foreground sm:ml-auto" aria-live="polite">
              {rows.length} of {q.data.length} warehouses
            </p>
          </div>

          {rows.length === 0 ? (
            <Card>
              <EmptyState
                title="No matching warehouses"
                description="Try a different search or status."
                action={
                  filtersActive ? (
                    <Button variant="outline" onClick={() => setF({ search: '', status: '' })}>
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {rows.map((w) => (
                <li key={w.id}>
                  <WarehouseCard w={w} canManage={canManage} onEdit={() => openEdit(w)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <WarehouseFormDialog open={formOpen} onOpenChange={setFormOpen} warehouse={editing} />
    </>
  )
}

function WarehouseCard({ w, canManage, onEdit }: { w: WarehouseSummary; canManage: boolean; onEdit: () => void }) {
  const reservedPct = w.total_units ? w.reserved_units / w.total_units : 0
  return (
    <Card className={cn('flex h-full flex-col transition-shadow hover:shadow-md', w.status === 'INACTIVE' && 'bg-muted/30')}>
      <div className="flex items-start justify-between gap-3 p-5 pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-primary">{w.code}</span>
            {w.status === 'ACTIVE' ? <Badge variant="success">Active</Badge> : <Badge variant="muted">Inactive</Badge>}
          </div>
          <h2 className="mt-2 truncate text-base font-semibold">
            <Link to={`/warehouses/${w.id}`} className="hover:text-primary hover:underline">
              {w.name}
            </Link>
          </h2>
          <p className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{w.location ?? 'No location set'}</span>
          </p>
        </div>
        {canManage && (
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${w.code}`} onClick={onEdit}>
            <Pencil />
          </Button>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-px border-y bg-border">
        {[
          ['Units on hand', fmt.int(w.total_units)],
          ['Inventory value', fmt.money(w.inventory_value)],
          ['Products stocked', fmt.int(w.product_count)],
          ['Reserved', `${fmt.int(w.reserved_units)} (${fmt.pct(reservedPct, 0)})`],
        ].map(([k, v]) => (
          <div key={k} className="bg-card px-5 py-3">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="mt-0.5 font-semibold tabular">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-auto flex items-center justify-between gap-2 px-5 py-3">
        {w.low_stock_items > 0 ? (
          <Link
            to={`/warehouses/${w.id}?tab=inventory`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-700 hover:underline dark:text-amber-400"
          >
            <AlertTriangle className="size-4" aria-hidden />
            {w.low_stock_items} item{w.low_stock_items === 1 ? '' : 's'} at or below reorder point
          </Link>
        ) : (
          <span className="text-sm text-muted-foreground">No low-stock items</span>
        )}
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/warehouses/${w.id}`} aria-label={`Open ${w.code}`}>
            Open <ArrowRight />
          </Link>
        </Button>
      </div>
    </Card>
  )
}
