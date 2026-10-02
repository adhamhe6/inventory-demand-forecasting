import { useQuery } from '@tanstack/react-query'
import { ArrowRight, LineChart as LineChartIcon } from 'lucide-react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { qk } from '@/api/queries'
import { chartTheme } from '@/components/common/ChartCard'
import { EmptyState, ErrorState } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { ForecastWithHistory } from '@/lib/types'
import { fmt } from '@/lib/utils'
import { buildForecastSeries } from './forecastSeries'

const HISTORY_DAYS = 90

function Swatch({ kind, label }: { kind: 'solid' | 'dashed' | 'band'; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {kind === 'band' ? (
        <span className="h-2.5 w-4 rounded-sm bg-[var(--chart-2)] opacity-25" aria-hidden />
      ) : (
        <svg width="18" height="6" aria-hidden>
          <line
            x1="0"
            y1="3"
            x2="18"
            y2="3"
            stroke={kind === 'solid' ? 'var(--chart-1)' : 'var(--chart-2)'}
            strokeWidth="2"
            strokeDasharray={kind === 'dashed' ? '4 2' : undefined}
          />
        </svg>
      )}
      {label}
    </span>
  )
}

interface Props {
  productId: number
  unit: string
  warehouses: Array<{ id: number; code: string; name: string }>
  warehouseId: number | null
  onWarehouseChange: (id: number) => void
}

export function ProductForecastPanel({ productId, unit, warehouses, warehouseId, onWarehouseChange }: Props) {
  const q = useQuery({
    queryKey: qk.forecastItem(productId, warehouseId ?? 0, HISTORY_DAYS),
    queryFn: ({ signal }) =>
      api.get<ForecastWithHistory>('/forecasts/item', { product_id: productId, warehouse_id: warehouseId, history_days: HISTORY_DAYS }, signal),
    enabled: !!warehouseId,
  })
  const series = useMemo(() => buildForecastSeries(q.data), [q.data])
  const forecast = q.data?.forecast ?? null
  const level = forecast?.details?.interval?.level
  const levelPct = level == null ? 80 : level <= 1 ? Math.round(level * 100) : Math.round(level)
  const forecastStart = forecast?.points[0]?.date
  const m = forecast?.metrics ?? {}
  const forecastingLink = `/forecasting?product_id=${productId}${warehouseId ? `&warehouse_id=${warehouseId}` : ''}`

  if (!warehouses.length) {
    return (
      <Card>
        <EmptyState icon={<LineChartIcon className="size-6" />} title="No warehouses available" description="Demand is tracked per warehouse. Create a warehouse and receive stock to see sales and forecasts." />
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="grid gap-1">
            <CardTitle>Daily demand & forecast</CardTitle>
            <CardDescription>
              Up to {HISTORY_DAYS} days of sales history{forecast ? ` and the next ${forecast.horizon_days} days forecast` : ''} ({unit})
            </CardDescription>
          </div>
          <NativeSelect
            aria-label="Warehouse for demand chart"
            className="sm:w-72"
            value={warehouseId ?? ''}
            onChange={(e) => onWarehouseChange(Number(e.target.value))}
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} — {w.name}
              </option>
            ))}
          </NativeSelect>
        </CardHeader>
        <CardContent>
          {q.error ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : q.isLoading || !q.data ? (
            <Skeleton className="h-[300px] w-full" />
          ) : series.length === 0 ? (
            <EmptyState
              icon={<LineChartIcon className="size-6" />}
              title="No sales history in this warehouse"
              description="Once sales are recorded here, actual demand and forecasts will appear."
            />
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Chart legend">
                <Swatch kind="solid" label="Actual demand" />
                {forecast && <Swatch kind="dashed" label="Forecast" />}
                {forecast && <Swatch kind="band" label={`${levelPct}% interval`} />}
              </div>
              <div className="h-[300px]" role="img" aria-label={`Daily demand chart for the selected warehouse${forecast ? ' with forecast' : ''}`}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                    <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={fmt.shortDate} tick={chartTheme.axis} tickLine={false} axisLine={false} minTickGap={32} />
                    <YAxis tick={chartTheme.axis} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                    <Tooltip
                      {...chartTheme.tooltip}
                      labelFormatter={(v) => fmt.date(String(v))}
                      formatter={(v, name) => {
                        if (name === 'band') {
                          const [lo, hi] = v as unknown as [number, number]
                          return [`${fmt.num(lo)} – ${fmt.num(hi)}`, `${levelPct}% interval`]
                        }
                        return [`${fmt.num(Number(v))} ${unit}`, name === 'actual' ? 'Actual' : 'Forecast']
                      }}
                    />
                    {forecastStart && (
                      <ReferenceLine
                        x={forecastStart}
                        stroke="var(--muted-foreground)"
                        strokeDasharray="2 4"
                        label={{ value: 'Forecast', position: 'insideTopLeft', fontSize: 11, fill: 'var(--muted-foreground)' }}
                      />
                    )}
                    {forecast && <Area dataKey="band" stroke="none" fill="var(--chart-2)" fillOpacity={0.15} activeDot={false} animationDuration={500} connectNulls />}
                    <Line dataKey="actual" stroke="var(--chart-1)" strokeWidth={2} dot={false} animationDuration={500} />
                    {forecast && <Line dataKey="predicted" stroke="var(--chart-2)" strokeWidth={2} strokeDasharray="5 3" dot={false} animationDuration={500} />}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Forecast model</CardTitle>
          <CardDescription>Latest run for this warehouse</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {q.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : !forecast ? (
            <div className="grid gap-3 text-sm">
              <p className="text-muted-foreground">No forecast has been generated for this product in this warehouse yet.</p>
              <Button variant="outline" asChild className="justify-self-start">
                <Link to={forecastingLink}>
                  Open forecasting <ArrowRight />
                </Link>
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="default">{fmt.label(forecast.model_name)}</Badge>
                <span className="text-xs text-muted-foreground">
                  v{forecast.model_version} · {fmt.relative(forecast.generated_at)}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-3">
                {[
                  ['Next ' + forecast.horizon_days + ' days', `${fmt.int(forecast.total_predicted)} ${unit}`],
                  ['Avg / day', fmt.num(forecast.avg_daily_demand)],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg border p-3">
                    <dt className="text-xs text-muted-foreground">{k}</dt>
                    <dd className="mt-1 text-lg font-semibold tabular">{v}</dd>
                  </div>
                ))}
              </dl>
              <div>
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Backtest accuracy{m.holdout_days ? ` · ${m.holdout_days}-day holdout` : ''}
                </h4>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  {(
                    [
                      ['MAE', fmt.num(m.mae), 'Mean absolute error (units/day)'],
                      ['RMSE', fmt.num(m.rmse), 'Root mean squared error (units/day)'],
                      ['WAPE', fmt.pct(m.wape), 'Weighted absolute percentage error'],
                      ['MAPE', fmt.pct(m.mape), 'Mean absolute percentage error'],
                    ] as const
                  ).map(([k, v, title]) => (
                    <div key={k} className="flex items-baseline justify-between gap-2 border-b border-dashed pb-1.5" title={title}>
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="font-medium tabular">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <p className="text-xs text-muted-foreground">
                Trained on {fmt.int(forecast.history_days)} days ({fmt.shortDate(forecast.history_start)} – {fmt.shortDate(forecast.history_end)}).
              </p>
              <Button variant="outline" asChild className="justify-self-start">
                <Link to={forecastingLink}>
                  Forecast details <ArrowRight />
                </Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
