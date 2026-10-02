import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Layers, RefreshCw, SlidersHorizontal, XCircle } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { qk, useAllWarehouses, usePaged } from '@/api/queries'
import { type Column, DataTable } from '@/components/common/DataTable'
import { SearchInput } from '@/components/common/SearchInput'
import { EmptyState, ErrorState, InlineError } from '@/components/common/States'
import { JobStatusBadge } from '@/components/common/StatusBadge'
import { Field } from '@/components/common/Field'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useUrlState } from '@/lib/hooks'
import type { ForecastRunSummary, Job, Page } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { FORECAST_DEPENDENT_KEYS, useForecastAccuracy } from './lib'
import { HORIZONS, MODEL_CHOICES, modelLabel, modelShort } from './meta'
import { isActive, jobDuration, useTrackedJob } from './useTrackedJob'
import { LookupError, LookupFailedOption } from '../shared/LookupError'

const LIST_DEFAULTS = { page: 1, page_size: 10, search: '', list_wh: '', model_name: '', sort: '-total_predicted' }


export function LatestForecastsTable({
  selected,
  onSelect,
}: {
  selected: { productId: number; warehouseId: number } | null
  onSelect: (row: ForecastRunSummary) => void
}) {
  const [f, setF] = useUrlState(LIST_DEFAULTS)
  const warehouses = useAllWarehouses()
  const query = { page: f.page, page_size: f.page_size, search: f.search, warehouse_id: f.list_wh, model_name: f.model_name, sort: f.sort }
  const q = usePaged<ForecastRunSummary>(qk.forecasts(query), '/forecasts', query)
  const filtersActive = f.search || f.list_wh || f.model_name

  const columns: Column<ForecastRunSummary>[] = [
    {
      key: 'product',
      header: 'Product',
      sortKey: 'sku',
      cell: (r) => {
        const isSel = selected?.productId === r.product_id && selected?.warehouseId === r.warehouse_id
        return (
          <div className="flex min-w-0 max-w-[16rem] items-center gap-2">
            <span className={cn('size-1.5 shrink-0 rounded-full', isSel ? 'bg-primary' : 'bg-transparent')} aria-hidden />
            <div className="min-w-0">
              <p className={cn('truncate font-medium', isSel && 'text-primary')}>
                {r.product_name}
                {isSel && <span className="sr-only"> (shown in chart)</span>}
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">{r.sku}</p>
            </div>
          </div>
        )
      },
    },
    { key: 'wh', header: 'Warehouse', cell: (r) => <span className="whitespace-nowrap">{r.warehouse_code}</span>, hideBelow: 'sm' },
    { key: 'model', header: 'Model', cell: (r) => <Badge variant="secondary">{modelShort(r.model_name)}</Badge>, hideBelow: 'md' },
    {
      key: 'total',
      header: 'Predicted',
      sortKey: 'total_predicted',
      align: 'right',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <span className="font-semibold tabular">{fmt.int(r.total_predicted)}</span>
          <span className="block text-xs text-muted-foreground">next {r.horizon_days}d</span>
        </div>
      ),
    },
    { key: 'avg', header: 'Avg / day', sortKey: 'avg_daily_demand', align: 'right', hideBelow: 'lg', cell: (r) => <span className="tabular">{fmt.num(r.avg_daily_demand)}</span> },
    { key: 'mae', header: 'MAE', sortKey: 'mae', align: 'right', hideBelow: 'lg', cell: (r) => <span className="tabular text-muted-foreground">{fmt.num(r.metrics.mae)}</span> },
    { key: 'wape', header: 'WAPE', sortKey: 'wape', align: 'right', hideBelow: 'md', cell: (r) => <span className="tabular">{fmt.pct(r.metrics.wape, 0)}</span> },
    {
      key: 'generated',
      header: 'Generated',
      sortKey: 'generated_at',
      align: 'right',
      hideBelow: 'xl',
      cell: (r) => (
        <span className="whitespace-nowrap text-muted-foreground" title={fmt.dateTime(r.generated_at)}>
          {fmt.relative(r.generated_at)}
        </span>
      ),
    },
  ]

  return (
    <Card>
      <CardHeader className="pb-0">
        <CardTitle>Latest forecasts</CardTitle>
        <CardDescription>The most recent forecast for every product and warehouse. Select a row to inspect it above.</CardDescription>
      </CardHeader>
      <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center">
        <SearchInput value={f.search} onChange={(v) => setF({ search: v })} placeholder="Search SKU or product…" />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex">
          <NativeSelect aria-label="Filter by warehouse" className="lg:w-44" value={f.list_wh} onChange={(e) => setF({ list_wh: e.target.value })}>
            <option value="">All warehouses</option>
            <LookupFailedOption query={warehouses} />
            {warehouses.data?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect aria-label="Filter by model" className="lg:w-48" value={f.model_name} onChange={(e) => setF({ model_name: e.target.value })}>
            <option value="">All models</option>
            {MODEL_CHOICES.filter((m) => m !== 'auto').map((m) => (
              <option key={m} value={m}>
                {modelLabel(m)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <LookupError lookups={{ warehouses }} />
        {filtersActive && (
          <Button variant="ghost" size="sm" className="lg:ml-auto" onClick={() => setF({ search: '', list_wh: '', model_name: '' })}>
            <SlidersHorizontal /> Clear filters
          </Button>
        )}
      </div>
      <DataTable
        caption="Latest forecasts"
        columns={columns}
        rows={q.data?.items}
        rowKey={(r) => r.id}
        loading={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        sort={f.sort}
        onSortChange={(sort) => setF({ sort })}
        onRowClick={onSelect}
        empty={
          <EmptyState
            title={filtersActive ? 'No matching forecasts' : 'No forecasts yet'}
            description={filtersActive ? 'Try clearing filters or searching for another product.' : 'Re-forecast all items to generate forecasts for every stocked product.'}
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

function RunAllSummary({ job }: { job: Job }) {
  const r = (job.result ?? {}) as { items?: number; succeeded?: number; failed?: number; models?: Record<string, number>; failures?: Array<{ product_id: number; warehouse_id: number; error: string }> }
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>
          <span className="font-semibold tabular">{fmt.int(r.items)}</span> <span className="text-muted-foreground">items</span>
        </span>
        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="size-3.5" aria-hidden />
          <span className="font-semibold tabular">{fmt.int(r.succeeded)}</span> succeeded
        </span>
        <span className={cn('inline-flex items-center gap-1', r.failed ? 'text-destructive' : 'text-muted-foreground')}>
          <XCircle className="size-3.5" aria-hidden />
          <span className="font-semibold tabular">{fmt.int(r.failed)}</span> failed
        </span>
        <span className="text-xs text-muted-foreground">in {jobDuration(job)}</span>
      </div>
      {r.models && Object.keys(r.models).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(r.models)
            .sort((a, b) => b[1] - a[1])
            .map(([m, n]) => (
              <Badge key={m} variant="secondary">
                {modelShort(m)} · {n}
              </Badge>
            ))}
        </div>
      )}
      {r.failures && r.failures.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Show failures</summary>
          <ul className="mt-1 space-y-1">
            {r.failures.map((x) => (
              <li key={`${x.product_id}-${x.warehouse_id}`} className="text-destructive">
                Product #{x.product_id} / warehouse #{x.warehouse_id}: {x.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

export function RunAllCard() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const warehouses = useAllWarehouses()
  const [horizon, setHorizon] = useState(30)
  const [warehouseId, setWarehouseId] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)

  // Resume tracking an in-flight run (e.g. after a reload) and show the last result.
  const latest = useQuery({
    queryKey: qk.jobs({ type: 'FORECAST_ALL', page_size: 1 }),
    queryFn: () => api.get<Page<Job>>('/jobs', { type: 'FORECAST_ALL', page_size: 1 }),
    select: (p) => p.items[0] ?? null,
  })
  const trackedId = jobId ?? (latest.data && isActive(latest.data) ? latest.data.id : null)

  const job = useTrackedJob(trackedId, (j) => {
    FORECAST_DEPENDENT_KEYS.forEach((key) => qc.invalidateQueries({ queryKey: key }))
    if (j.status === 'SUCCEEDED') {
      const r = j.result as { succeeded?: number; items?: number; failed?: number } | null
      toast.success('All forecasts refreshed', { description: `${r?.succeeded ?? 0} of ${r?.items ?? 0} items forecast${r?.failed ? ` · ${r.failed} failed` : ''}` })
    } else toast.error('Re-forecast failed', { description: j.error ?? 'The background job failed.' })
  })

  const run = useMutation({
    mutationFn: () => api.post<Job>('/forecasts/run-all', { horizon_days: horizon, warehouse_id: warehouseId ? Number(warehouseId) : null }),
    onSuccess: (j) => {
      setConfirm(false)
      setJobId(j.id)
      qc.setQueryData(qk.job(j.id), j)
      toast.info(j.status === 'QUEUED' ? 'Re-forecast queued' : 'Re-forecast already running', {
        description: 'The background worker is processing every item. You can keep working.',
      })
    },
  })

  const current = job.data ?? (trackedId ? undefined : latest.data)
  const active = isActive(current) || (!!trackedId && !job.data)
  const canRun = can('run_forecasts')

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="size-4 text-muted-foreground" aria-hidden /> Re-forecast all items
        </CardTitle>
        <CardDescription>Regenerates forecasts for every active product × warehouse with the auto-selected model.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {canRun && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field id="runall-horizon" label="Horizon" className="sm:w-32">
              <NativeSelect id="runall-horizon" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} disabled={active}>
                {HORIZONS.map((h) => (
                  <option key={h} value={h}>
                    {h} days
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="runall-wh" label="Scope" className="sm:w-44">
              <NativeSelect id="runall-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} disabled={active}>
                <option value="">All warehouses</option>
                <LookupFailedOption query={warehouses} />
                {warehouses.data
                  ?.filter((w) => w.status === 'ACTIVE')
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
            <Button onClick={() => setConfirm(true)} disabled={active} className="sm:ml-auto">
              <RefreshCw className={cn(active && 'animate-spin')} /> {active ? 'Running…' : 'Re-forecast'}
            </Button>
          </div>
        )}
        {canRun && <LookupError lookups={{ warehouses }} context="— you can still re-forecast all warehouses" />}
        {run.error && !confirm && <InlineError error={run.error} />}
        {latest.isLoading && !current ? (
          <Skeleton className="h-16 w-full" />
        ) : latest.error && !current ? (
          <ErrorState error={latest.error} onRetry={() => latest.refetch()} className="py-4" />
        ) : current ? (
          <div className="space-y-2" aria-live="polite">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">{active ? 'Current run' : 'Last run'} · {fmt.relative(current.created_at)}</span>
              <JobStatusBadge status={current.status} />
            </div>
            {isActive(current) && (
              <>
                <Progress value={current.status === 'QUEUED' ? 2 : current.progress} label="Re-forecast progress" />
                <p className="text-xs text-muted-foreground">
                  {current.status === 'QUEUED' ? 'Waiting for the background worker…' : `${current.progress}% · running in the background worker for ${jobDuration(current)}`}
                </p>
              </>
            )}
            {current.status === 'SUCCEEDED' && <RunAllSummary job={current} />}
            {current.status === 'FAILED' && <InlineError error={new Error(current.error ?? 'The job failed.')} />}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No full re-forecast has been run yet{canRun ? '.' : ' — ask a user with forecasting permission to start one.'}</p>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirm}
        onOpenChange={(o) => !run.isPending && setConfirm(o)}
        title="Re-forecast all items?"
        description={
          <>
            This regenerates a <strong>{horizon}-day</strong> forecast for every active item
            {warehouseId ? ` in ${warehouses.data?.find((w) => String(w.id) === warehouseId)?.code}` : ' in all warehouses'}. It runs in the background
            worker and replaces the latest forecasts used for stock-risk and restocking calculations.
          </>
        }
        confirmLabel="Start re-forecast"
        loading={run.isPending}
        onConfirm={() => run.mutate()}
      >
        {run.error && <InlineError error={run.error} />}
      </ConfirmDialog>
    </Card>
  )
}

export function ModelMixCard() {
  const q = useForecastAccuracy()
  const rows = [...(q.data?.by_model ?? [])].sort((a, b) => b.items - a.items)
  const total = rows.reduce((s, r) => s + r.items, 0)
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Model mix</CardTitle>
        <CardDescription>
          {q.data ? `${fmt.int(q.data.items_forecasted)} items forecast · last ${fmt.relative(q.data.last_generated_at)}` : 'Which models the auto-selector picked'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} className="py-4" />
        ) : !q.data ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title="No forecasts yet" description="Run a forecast to see which models fit your demand." className="py-6" />
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Forecast items and average accuracy by model</caption>
            <thead>
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="pb-2 text-left font-medium">Model</th>
                <th scope="col" className="pb-2 text-right font-medium">Items</th>
                <th scope="col" className="pb-2 text-right font-medium">Avg MAE</th>
                <th scope="col" className="pb-2 text-right font-medium">Avg WAPE</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model_name} className="border-t">
                  <td className="py-2 pr-2">
                    <p className="font-medium">{modelLabel(r.model_name)}</p>
                    <div className="mt-1 h-1.5 w-full max-w-36 rounded-full bg-muted" aria-hidden>
                      <div className="h-full rounded-full bg-[var(--chart-1)]" style={{ width: `${(r.items / Math.max(total, 1)) * 100}%` }} />
                    </div>
                  </td>
                  <td className="py-2 text-right tabular">
                    {r.items}
                    <span className="block text-xs text-muted-foreground">{fmt.pct(r.items / Math.max(total, 1), 0)}</span>
                  </td>
                  <td className="py-2 text-right tabular text-muted-foreground">{fmt.num(r.avg_mae)}</td>
                  <td className="py-2 text-right tabular">{fmt.pct(r.avg_wape, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}
