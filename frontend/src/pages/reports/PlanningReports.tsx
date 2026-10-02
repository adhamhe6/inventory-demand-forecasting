import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { qk, useAllWarehouses } from '@/api/queries'
import { ChartCard, chartTheme } from '@/components/common/ChartCard'
import { CardsSkeleton, EmptyState, ErrorState, TableSkeleton } from '@/components/common/States'
import { RISK_COLORS, RiskBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { api } from '@/lib/api'
import { useUrlState } from '@/lib/hooks'
import type { RiskLevel, StockRisk } from '@/lib/types'
import { fmt } from '@/lib/utils'
import { modelLabel } from '../forecasting/meta'
import { ExportButton, SimpleTable, Stat, StatGrid, Toolbar } from './shared'
import { hideCls, useReport } from './lib'

interface ForecastAccuracy {
  by_model: Array<{ model_name: string; items: number; avg_mae: number | null; avg_wape: number | null; total_predicted: number; last_generated_at: string }>
  items_forecasted: number
  last_generated_at: string | null
}

const FC_DEFAULTS = { fc_days: 30, fc_wh: '' }

export function ForecastsReport() {
  const [f, setF] = useUrlState(FC_DEFAULTS)
  const warehouses = useAllWarehouses()
  const acc = useReport<ForecastAccuracy>('forecast-accuracy', '/reports/forecast-accuracy')
  const agg = useReport<Array<{ date: string; predicted: number; lower: number; upper: number }>>('forecast-aggregate', '/reports/forecast-aggregate', {
    days: f.fc_days,
    warehouse_id: f.fc_wh,
  })
  const a = acc.data
  const rows = [...(a?.by_model ?? [])].sort((x, y) => y.items - x.items)
  const total = rows.reduce((s, r) => s + r.total_predicted, 0)
  const weightedWape = rows.length ? rows.reduce((s, r) => s + (r.avg_wape ?? 0) * r.items, 0) / Math.max(1, rows.reduce((s, r) => s + r.items, 0)) : null
  const aggTotal = agg.data?.reduce((s, p) => s + p.predicted, 0) ?? 0

  return (
    <>
      <Toolbar
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/forecasting">
              Open forecasting <ArrowRight />
            </Link>
          </Button>
        }
      >
        <NativeSelect aria-label="Forecast warehouse" className="w-40" value={f.fc_wh} onChange={(e) => setF({ fc_wh: e.target.value })}>
          <option value="">All warehouses</option>
          {warehouses.data?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Forecast horizon" className="w-36" value={f.fc_days} onChange={(e) => setF({ fc_days: Number(e.target.value) })}>
          {[14, 30, 60, 90].map((d) => (
            <option key={d} value={d}>
              Next {d} days
            </option>
          ))}
        </NativeSelect>
      </Toolbar>
      {acc.error ? (
        <Card className="mb-6">
          <ErrorState error={acc.error} onRetry={() => acc.refetch()} />
        </Card>
      ) : !a ? (
        <div className="mb-6">
          <CardsSkeleton count={4} />
        </div>
      ) : (
        <StatGrid>
          <Stat label="Items forecast" value={fmt.int(a.items_forecasted)} hint={a.last_generated_at ? `latest ${fmt.relative(a.last_generated_at)}` : 'never run'} />
          <Stat label={`Predicted demand · ${f.fc_days}d`} value={fmt.int(aggTotal)} hint={f.fc_wh ? 'selected warehouse' : 'all warehouses'} />
          <Stat label="Avg WAPE" value={fmt.pct(weightedWape, 0)} hint="weighted by items" tone={weightedWape != null && weightedWape > 0.6 ? 'warning' : undefined} />
          <Stat label="Models in use" value={rows.length} hint={rows[0] ? `mostly ${modelLabel(rows[0].model_name)}` : undefined} />
        </StatGrid>
      )}
      <div className="grid gap-6 [&>*]:min-w-0 xl:grid-cols-2">
        <ChartCard

          title="Aggregate forecast"
          description="Sum of all item forecasts per day, with the summed 80% interval"
          loading={!agg.data && !agg.error}
        >
          {agg.error ? (
            <ErrorState error={agg.error} onRetry={() => agg.refetch()} />
          ) : agg.data && agg.data.length === 0 ? (
            <EmptyState title="No forecasts yet" description="Run forecasting to see predicted demand." />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={agg.data?.map((p) => ({ ...p, band: [p.lower, p.upper] }))} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tickFormatter={fmt.shortDate} tick={chartTheme.axis} tickLine={false} axisLine={false} minTickGap={32} />
                <YAxis tick={chartTheme.axis} tickLine={false} axisLine={false} width={48} />
                <Tooltip
                  {...chartTheme.tooltip}
                  labelFormatter={(x) => fmt.date(String(x))}
                  formatter={(x, name) =>
                    name === 'band' ? [`${fmt.int((x as number[])[0])} – ${fmt.int((x as number[])[1])}`, '80% interval'] : [`${fmt.int(Number(x))} units`, 'Forecast']
                  }
                />
                <Area dataKey="band" stroke="none" fill="var(--chart-2)" fillOpacity={0.18} activeDot={false} isAnimationActive={false} />
                <Line dataKey="predicted" stroke="var(--chart-2)" strokeWidth={2} dot={false} strokeDasharray="6 4" animationDuration={500} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
        <Card>
          <CardHeader>
            <CardTitle>Accuracy by model</CardTitle>
            <CardDescription>Backtest error averaged over the items each model forecasts</CardDescription>
          </CardHeader>
          {!a ? (
            <TableSkeleton rows={4} cols={4} />
          ) : rows.length === 0 ? (
            <EmptyState title="No forecasts yet" />
          ) : (
            <SimpleTable
              caption="Forecast accuracy by model"
              head={[{ label: 'Model' }, { label: 'Items', align: 'right' }, { label: 'Avg MAE', align: 'right', hideBelow: 'sm' }, { label: 'Avg WAPE', align: 'right' }, { label: 'Predicted', align: 'right', hideBelow: 'lg' }]}
            >
              {rows.map((r) => (
                <tr key={r.model_name}>
                  <td className="whitespace-nowrap font-medium">
                    <Link to={`/forecasting?model_name=${r.model_name}`} className="hover:text-primary hover:underline">
                      {modelLabel(r.model_name)}
                    </Link>
                  </td>
                  <td className="text-right tabular">{r.items}</td>
                  <td className={`text-right tabular text-muted-foreground ${hideCls.sm}`}>{fmt.num(r.avg_mae)}</td>
                  <td className="text-right tabular">{fmt.pct(r.avg_wape, 0)}</td>
                  <td className={`text-right tabular text-muted-foreground ${hideCls.lg}`}>
                    {fmt.int(r.total_predicted)}
                    <span className="block text-xs">{fmt.pct(total ? r.total_predicted / total : 0, 0)}</span>
                  </td>
                </tr>
              ))}
            </SimpleTable>
          )}
        </Card>
      </div>
    </>
  )
}

const LEVELS: RiskLevel[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
const SH_DEFAULTS = { min_risk: 'LOW', sh_wh: '' }

export function ShortagesReport() {
  const [f, setF] = useUrlState(SH_DEFAULTS)
  const warehouses = useAllWarehouses()
  const query = { min_risk: f.min_risk, warehouse_id: f.sh_wh }
  const q = useQuery({ queryKey: qk.shortages(query), queryFn: ({ signal }) => api.get<StockRisk[]>('/shortages', query, signal), placeholderData: (p) => p })
  const rows = q.data ?? []
  const counts = LEVELS.map((l) => ({ level: l, count: rows.filter((r) => r.risk_level === l).length }))
  const byWh = Object.values(
    rows.reduce<Record<string, { code: string; CRITICAL: number; HIGH: number; MEDIUM: number; LOW: number }>>((acc, r) => {
      acc[r.warehouse_code] ??= { code: r.warehouse_code, CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
      if (r.risk_level !== 'NONE') acc[r.warehouse_code][r.risk_level] += 1
      return acc
    }, {}),
  )
  const visibleLevels = LEVELS.slice(0, LEVELS.indexOf(f.min_risk as RiskLevel) + 1)

  return (
    <>
      <Toolbar actions={<ExportButton path="/shortages" query={query} />}>
        <NativeSelect aria-label="Minimum risk level" className="w-44" value={f.min_risk} onChange={(e) => setF({ min_risk: e.target.value })}>
          <option value="CRITICAL">Critical only</option>
          <option value="HIGH">High and above</option>
          <option value="MEDIUM">Medium and above</option>
          <option value="LOW">Low and above</option>
        </NativeSelect>
        <NativeSelect aria-label="Warehouse" className="w-40" value={f.sh_wh} onChange={(e) => setF({ sh_wh: e.target.value })}>
          <option value="">All warehouses</option>
          {warehouses.data?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code}
            </option>
          ))}
        </NativeSelect>
      </Toolbar>
      {q.error ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : !q.data ? (
        <div className="space-y-4">
          <CardsSkeleton count={4} />
          <TableSkeleton />
        </div>
      ) : (
        <div className={q.isFetching ? 'opacity-70 transition-opacity' : undefined}>
          <StatGrid>
            {counts.map((c) => (
              <Card key={c.level} className="p-4">
                <RiskBadge level={c.level} />
                <p className="mt-2 text-2xl font-semibold tracking-tight tabular">{visibleLevels.includes(c.level) ? c.count : '—'}</p>
                <p className="text-xs text-muted-foreground">items</p>
              </Card>
            ))}
          </StatGrid>
          {rows.length === 0 ? (
            <Card>
              <EmptyState title="No shortage risks" description="Stock and open purchase orders cover expected demand for every item at this risk level." />
            </Card>
          ) : (
            <div className="grid items-start gap-6 [&>*]:min-w-0 xl:grid-cols-5">
              <ChartCard className="xl:col-span-2" title="Risk by warehouse" description={
                  <span className="flex flex-wrap gap-x-3 gap-y-1">
                    {visibleLevels.map((l) => (
                      <span key={l} className="inline-flex items-center gap-1.5 text-xs">
                        <span className="size-2 rounded-sm" style={{ background: RISK_COLORS[l] }} aria-hidden />
                        {fmt.label(l)}
                      </span>
                    ))}
                  </span>
                }
                height={Math.max(180, byWh.length * 56)}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={byWh} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 0 }}>
                    <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} tick={chartTheme.axis} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="code" tick={chartTheme.axis} tickLine={false} axisLine={false} width={80} />
                    <Tooltip {...chartTheme.tooltip} cursor={{ fill: 'var(--muted)' }} formatter={(x, n) => [`${x} items`, fmt.label(String(n))]} />
                    {visibleLevels.map((l) => (
                      <Bar key={l} dataKey={l} stackId="r" fill={RISK_COLORS[l]} barSize={22} animationDuration={500} stroke="var(--card)" strokeWidth={1} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
              <Card className="xl:col-span-3">
                <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
                  <div>
                    <CardTitle>Most urgent items</CardTitle>
                    <CardDescription>Sorted by severity, then days of cover · {rows.length} items total</CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link to="/stock-risks">
                      All risks <ArrowRight />
                    </Link>
                  </Button>
                </CardHeader>
                <SimpleTable
                  caption="Most urgent shortage risks"
                  head={[{ label: 'Item' }, { label: 'Available', align: 'right', hideBelow: 'sm' }, { label: 'Cover', align: 'right', hideBelow: 'md' }, { label: 'Stock-out', hideBelow: 'lg' }, { label: 'Risk', align: 'right' }]}
                >
                  {rows.slice(0, 10).map((r) => (
                    <tr key={r.inventory_item_id}>
                      <td>
                        <Link to={`/products/${r.product_id}`} className="font-medium hover:text-primary hover:underline">
                          {r.product_name}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          <span className="font-mono">{r.sku}</span> · {r.warehouse_code}
                        </p>
                      </td>
                      <td className={`text-right tabular ${hideCls.sm}`}>{fmt.int(r.available_quantity)}</td>
                      <td className={`text-right tabular ${hideCls.md}`}>{r.days_of_cover != null ? `${fmt.num(r.days_of_cover)}d` : '—'}</td>
                      <td className={`text-muted-foreground ${hideCls.lg}`}>{fmt.date(r.stockout_date)}</td>
                      <td className="text-right">
                        <RiskBadge level={r.risk_level} />
                      </td>
                    </tr>
                  ))}
                </SimpleTable>
              </Card>
            </div>
          )}
        </div>
      )}
    </>
  )
}
