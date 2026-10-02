import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BarChart3, ExternalLink, LineChart, Play, TrendingUp } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { qk, useAllProducts, useAllWarehouses } from '@/api/queries'
import { Field } from '@/components/common/Field'
import { KpiCard } from '@/components/common/KpiCard'
import { PageHeader } from '@/components/common/PageHeader'
import { CardsSkeleton, EmptyState, ErrorState, InlineError } from '@/components/common/States'
import { JobStatusBadge } from '@/components/common/StatusBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useUrlState } from '@/lib/hooks'
import type { ForecastRunSummary, ForecastWithHistory, InventoryItem, Job, Page } from '@/lib/types'
import { fmt } from '@/lib/utils'
import { ChartLegend, ForecastChart } from './forecasting/ForecastChart'
import { CandidatesCard, DemandProfileCard, ModelAccuracyCard } from './forecasting/ForecastInsights'
import { LatestForecastsTable, ModelMixCard, RunAllCard } from './forecasting/LatestForecasts'
import { FORECAST_DEPENDENT_KEYS, useIntervalPct } from './forecasting/lib'
import { LookupError, LookupFailedOption } from './shared/LookupError'
import { HISTORY_WINDOWS, HORIZONS, MODEL_CHOICES, MODEL_META, type ModelChoice, modelLabel } from './forecasting/meta'
import { isActive, jobDuration, useTrackedJob } from './forecasting/useTrackedJob'

const SEL_DEFAULTS = { product_id: 0, warehouse_id: 0, horizon: 30, model: 'auto', history: 90, ma: 0 }

export default function ForecastingPage() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const [s, setS] = useUrlState(SEL_DEFAULTS)
  const products = useAllProducts()
  const warehouses = useAllWarehouses()
  const productId = s.product_id
  const warehouseId = s.warehouse_id
  const model = (MODEL_CHOICES.includes(s.model as ModelChoice) ? s.model : 'auto') as ModelChoice
  const canRun = can('run_forecasts')

  // Warehouses that actually stock the selected product are listed first.
  const stocked = useQuery({
    queryKey: qk.inventory({ product_id: productId, page_size: 100 }),
    queryFn: () => api.get<Page<InventoryItem>>('/inventory', { product_id: productId, page_size: 100 }),
    enabled: productId > 0,
    select: (p) => p.items,
  })
  const stockedIds = useMemo(() => new Set(stocked.data?.map((i) => i.warehouse_id)), [stocked.data])

  // Nothing chosen yet: open the item with the largest predicted demand so the page is useful immediately.
  const top = useQuery({
    queryKey: qk.forecasts({ page_size: 1, sort: '-total_predicted' }),
    queryFn: () => api.get<Page<ForecastRunSummary>>('/forecasts', { page_size: 1, sort: '-total_predicted' }),
    enabled: productId === 0,
  })
  useEffect(() => {
    const first = top.data?.items[0]
    if (productId === 0 && first) setS({ product_id: first.product_id, warehouse_id: first.warehouse_id })
  }, [top.data, productId, setS])

  // Product changed and the chosen warehouse doesn't stock it: switch to the first one that does.
  useEffect(() => {
    if (!productId || !stocked.data) return
    if (stocked.data.length && !stockedIds.has(warehouseId)) setS({ warehouse_id: stocked.data[0].warehouse_id })
  }, [productId, stocked.data, stockedIds, warehouseId, setS])

  const ready = productId > 0 && warehouseId > 0
  const item = useQuery({
    queryKey: qk.forecastItem(productId, warehouseId, s.history),
    queryFn: ({ signal }) =>
      api.get<ForecastWithHistory>('/forecasts/item', { product_id: productId, warehouse_id: warehouseId, history_days: s.history }, signal),
    enabled: ready,
    placeholderData: (prev, prevQuery) =>
      // Keep the chart while only the history window changes; never show another item's data.
      prevQuery && prevQuery.queryKey[2] === productId && prevQuery.queryKey[3] === warehouseId ? prev : undefined,
  })

  // ---- run a single forecast in the background worker
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobItem, setJobItem] = useState<{ p: number; w: number } | null>(null)
  const job = useTrackedJob(jobId, (j) => {
    FORECAST_DEPENDENT_KEYS.forEach((key) => qc.invalidateQueries({ queryKey: key }))
    if (j.status === 'SUCCEEDED') {
      const r = j.result as { model_name?: string; total_predicted?: number } | null
      toast.success('Forecast ready', {
        description: `${modelLabel(r?.model_name)} · ${fmt.int(r?.total_predicted)} units over ${String(j.params.horizon_days ?? '')} days`,
      })
    } else toast.error('Forecast failed', { description: j.error ?? 'The background job failed.' })
  })
  const runningHere = jobItem?.p === productId && jobItem?.w === warehouseId
  const shownJob = runningHere ? job.data : undefined
  const busy = isActive(shownJob) || (runningHere && !!jobId && !job.data)

  const run = useMutation({
    mutationFn: () => api.post<Job>('/forecasts/run', { product_id: productId, warehouse_id: warehouseId, horizon_days: s.horizon, model }),
    onSuccess: (j) => {
      qc.setQueryData(qk.job(j.id), j)
      setJobItem({ p: productId, w: warehouseId })
      setJobId(j.id)
    },
    onError: (e) => toast.error('Could not start forecast', { description: e.message }),
  })

  const product = products.data?.find((p) => p.id === productId)
  const warehouse = warehouses.data?.find((w) => w.id === warehouseId)
  const data = item.data
  const fc = data?.forecast ?? null
  const levelPct = useIntervalPct(fc?.details?.interval?.level)
  const hasHistory = !!data && data.history.some((h) => h.quantity > 0)
  const recent = useMemo(() => {
    const h = data?.history.slice(-28) ?? []
    return h.length ? h.reduce((a, b) => a + b.quantity, 0) / h.length : null
  }, [data])
  const change = fc && recent ? ((fc.avg_daily_demand - recent) / recent) * 100 : null

  const runButton = canRun ? (
    <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!ready || busy}>
      {!run.isPending && <Play />} {busy ? 'Forecasting…' : 'Run forecast'}
    </Button>
  ) : null

  return (
    <>
      <PageHeader
        title="Demand forecasting"
        description="Daily demand history, statistical forecasts with prediction intervals, and backtested model accuracy."
      />

      {/* ---------------- control bar */}
      <Card className="mb-6">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_auto] lg:items-end">
          <Field id="fc-product" label="Product" className="sm:col-span-2 lg:col-span-1">
            <NativeSelect
              id="fc-product"
              value={productId || ''}
              disabled={products.isLoading}
              onChange={(e) => setS({ product_id: Number(e.target.value) || 0 })}
            >
              <option value="">{products.isLoading ? 'Loading products…' : 'Select a product'}</option>
              <LookupFailedOption query={products} />
              {products.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="fc-wh" label="Warehouse">
            <NativeSelect id="fc-wh" value={warehouseId || ''} onChange={(e) => setS({ warehouse_id: Number(e.target.value) || 0 })} disabled={!productId}>
              <option value="">Select a warehouse</option>
              <LookupFailedOption query={warehouses} />
              {stocked.data && stocked.data.length > 0 && (
                <optgroup label="Stocks this product">
                  {warehouses.data
                    ?.filter((w) => stockedIds.has(w.id))
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.code} — {w.name}
                      </option>
                    ))}
                </optgroup>
              )}
              <optgroup label={stocked.data?.length ? 'Other warehouses' : 'Warehouses'}>
                {warehouses.data
                  ?.filter((w) => w.status === 'ACTIVE' && !stockedIds.has(w.id))
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
              </optgroup>
            </NativeSelect>
          </Field>
          <Field id="fc-horizon" label="Horizon">
            <NativeSelect id="fc-horizon" value={s.horizon} onChange={(e) => setS({ horizon: Number(e.target.value) })}>
              {HORIZONS.map((h) => (
                <option key={h} value={h}>
                  {h} days
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="fc-model" label="Model">
            <NativeSelect id="fc-model" aria-describedby="fc-model-hint" value={model} onChange={(e) => setS({ model: e.target.value })}>
              {MODEL_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {MODEL_META[m].label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="fc-history" label="Chart history">
            <NativeSelect id="fc-history" value={s.history} onChange={(e) => setS({ history: Number(e.target.value) })}>
              {HISTORY_WINDOWS.map((h) => (
                <option key={h} value={h}>
                  Last {h} days
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex sm:col-span-2 lg:col-span-1 [&>button]:w-full lg:[&>button]:w-auto">{runButton}</div>
        </div>
        <p className="flex flex-wrap gap-x-2 border-t px-4 py-2.5 text-xs text-muted-foreground" id="fc-model-hint">
          <span className="font-medium text-foreground">{MODEL_META[model].label}:</span>
          <span>{MODEL_META[model].description}</span>
          {!canRun && <span className="w-full sm:ml-auto sm:w-auto">Your role can view forecasts but not run them.</span>}
        </p>
        <LookupError
          className="mx-4 mb-3"
          context=""
          lookups={{ products, warehouses, 'stocking warehouses': stocked, 'the default item': productId === 0 ? top : undefined }}
        />
      </Card>

      {/* ---------------- background job state */}
      {runningHere && shownJob && shownJob.status !== 'SUCCEEDED' && (
        <Card className="mb-6 p-4" aria-live="polite">
          {shownJob.status === 'FAILED' ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Forecast job failed</p>
                <Button variant="ghost" size="sm" onClick={() => setJobId(null)}>
                  Dismiss
                </Button>
              </div>
              <InlineError error={new Error(shownJob.error ?? 'The background job failed.')} />
            </div>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <JobStatusBadge status={shownJob.status} />
                <p className="text-sm">
                  {shownJob.status === 'QUEUED' ? 'Queued — waiting for the background worker…' : 'Running in the background worker…'}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {modelLabel(String(shownJob.params.model ?? 'auto'))} · {String(shownJob.params.horizon_days)} days · {jobDuration(shownJob)}
                  </span>
                </p>
              </div>
              <Progress value={shownJob.status === 'QUEUED' ? 5 : Math.max(shownJob.progress, 35)} className="sm:w-48" label="Forecast progress" />
            </div>
          )}
        </Card>
      )}

      {/* ---------------- main chart */}
      {!ready ? (
        <Card className="mb-6">
          {top.isLoading && productId === 0 ? (
            <div className="p-5">
              <Skeleton className="h-[380px] w-full" />
            </div>
          ) : (
            <EmptyState
              icon={<LineChart className="size-6" aria-hidden />}
              title={productId ? 'Choose a warehouse' : 'Choose a product to forecast'}
              description="Forecasts are made per product and warehouse. Pick one above, or select a row from the latest forecasts below."
            />
          )}
        </Card>
      ) : item.error ? (
        <Card className="mb-6">
          <ErrorState error={item.error} onRetry={() => item.refetch()} />
        </Card>
      ) : !data ? (
        <div className="mb-6 space-y-4">
          <CardsSkeleton count={4} />
          <Skeleton className="h-[440px] w-full rounded-xl" />
        </div>
      ) : (
        <div className="mb-8 space-y-6">
          {fc && (
            <section aria-label="Forecast summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard label="Predicted demand" value={`${fmt.int(fc.total_predicted)} units`} hint={`next ${fc.horizon_days} days from ${fmt.shortDate(fc.points[0]?.date)}`} icon={<TrendingUp />} />
              <KpiCard
                label="Forecast avg / day"
                value={fmt.num(fc.avg_daily_demand)}
                change={change}
                hint={recent != null ? `vs ${fmt.num(recent)}/day last 28 days` : undefined}
                icon={<BarChart3 />}
              />
              <KpiCard label="Model" value={<span className="text-xl">{modelLabel(fc.model_name)}</span>} hint={`generated ${fmt.relative(fc.generated_at)}`} icon={<LineChart />} />
              <KpiCard
                label="Forecast error (WAPE)"
                value={fmt.pct(fc.metrics.wape)}
                hint={fc.metrics.mae != null ? `MAE ${fmt.num(fc.metrics.mae)} units/day` : 'not enough history to backtest'}
                icon={<BarChart3 />}
                tone={fc.metrics.wape == null ? 'default' : fc.metrics.wape <= 0.3 ? 'success' : fc.metrics.wape <= 0.6 ? 'warning' : 'danger'}
              />
            </section>
          )}

          <Card>
            <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span className="truncate">{product?.name ?? fc?.product_name ?? 'Item'}</span>
                  <Badge variant="outline" className="font-mono">
                    {product?.sku ?? fc?.sku}
                  </Badge>
                  <Badge variant="secondary">{warehouse?.code ?? fc?.warehouse_code}</Badge>
                </CardTitle>
                <CardDescription>
                  Daily units sold over the last {s.history} days
                  {fc ? `, then the ${fc.horizon_days}-day forecast with its ${levelPct == null ? '' : `${levelPct}% `}prediction interval.` : '.'}
                </CardDescription>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--primary)]"
                    checked={s.ma === 1}
                    onChange={(e) => setS({ ma: e.target.checked ? 1 : 0 })}
                  />
                  7-day average
                </label>
                <Button variant="ghost" size="sm" asChild>
                  <Link to={`/products/${productId}`}>
                    Product <ExternalLink />
                  </Link>
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {!hasHistory && !fc ? (
                <EmptyState
                  icon={<LineChart className="size-6" aria-hidden />}
                  title="No sales history"
                  description={`This item has no recorded sales in ${warehouse?.code ?? 'this warehouse'} over the last ${s.history} days, so there is nothing to learn from yet. Try a longer history window or another warehouse.`}
                  action={runButton && <span className="text-xs text-muted-foreground">You can still run a baseline forecast.</span>}
                />
              ) : (
                <>
                  <ChartLegend showMa={s.ma === 1} hasForecast={!!fc} levelPct={levelPct} />
                  <div className={item.isFetching ? 'opacity-70 transition-opacity' : undefined}>
                    <ForecastChart data={data} showMa={s.ma === 1} levelPct={levelPct} />
                  </div>
                  {fc && fc.horizon_days !== s.horizon && (
                    <p className="text-xs text-muted-foreground">
                      Showing the stored {fc.horizon_days}-day forecast. Run a forecast to generate a {s.horizon}-day horizon.
                    </p>
                  )}
                </>
              )}
              {!fc && (
                <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium">No forecast yet for this item</p>
                    <p className="text-sm text-muted-foreground">
                      {canRun
                        ? `Run a ${s.horizon}-day forecast — it is computed by the background worker and appears here when ready.`
                        : 'A user with forecasting permission can generate one.'}
                    </p>
                  </div>
                  {runButton}
                </div>
              )}
            </CardContent>
          </Card>

          {fc && (
            <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2 xl:grid-cols-3">
              <ModelAccuracyCard run={fc} />
              <CandidatesCard run={fc} />
              <DemandProfileCard run={fc} />
            </div>
          )}
        </div>
      )}

      {/* ---------------- portfolio */}
      <section aria-labelledby="portfolio-heading" className="space-y-6">
        <h2 id="portfolio-heading" className="text-lg font-semibold tracking-tight">
          All items
        </h2>
        <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
          <RunAllCard />
          <ModelMixCard />
        </div>
        <LatestForecastsTable
          selected={ready ? { productId, warehouseId } : null}
          onSelect={(r) => {
            setS({ product_id: r.product_id, warehouse_id: r.warehouse_id })
            window.scrollTo({ top: 0, behavior: 'smooth' })
          }}
        />
      </section>
    </>
  )
}
