import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  ClipboardList,
  DollarSign,
  Package,
  PackageX,
  RefreshCw,
  ShieldAlert,
  ShoppingCart,
  TrendingUp,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { qk } from '@/api/queries'
import { ChartCard, chartTheme } from '@/components/common/ChartCard'
import { KpiCard } from '@/components/common/KpiCard'
import { PageHeader } from '@/components/common/PageHeader'
import { CardsSkeleton, EmptyState, ErrorState } from '@/components/common/States'
import { RISK_COLORS, RiskBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api'
import type { Dashboard, StockRisk } from '@/lib/types'
import { fmt } from '@/lib/utils'

const RISK_LABEL: Record<string, string> = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', NONE: 'None' }

export default function DashboardPage() {
  const dash = useQuery({ queryKey: qk.dashboard, queryFn: () => api.get<Dashboard>('/reports/dashboard') })
  const risks = useQuery({
    queryKey: qk.shortages({ min_risk: 'HIGH' }),
    queryFn: () => api.get<StockRisk[]>('/shortages', { min_risk: 'HIGH' }),
  })
  const d = dash.data
  const k = d?.kpis

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={d ? `Live overview · updated ${fmt.relative(d.generated_at)}` : 'Live overview of stock, sales and replenishment'}
        actions={
          <Button variant="outline" size="sm" onClick={() => dash.refetch()} loading={dash.isFetching}>
            {!dash.isFetching && <RefreshCw />} Refresh
          </Button>
        }
      />
      {dash.error ? (
        <Card>
          <ErrorState error={dash.error} onRetry={() => dash.refetch()} />
        </Card>
      ) : !k ? (
        <div className="space-y-4">
          <CardsSkeleton count={4} />
          <CardsSkeleton count={4} />
        </div>
      ) : (
        <div className="space-y-6">
          <section aria-label="Key metrics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Inventory value" value={fmt.moneyCompact(k.inventory_value)} hint={`${fmt.int(k.total_units)} units on hand`} icon={<DollarSign />} to="/reports" />
            <KpiCard label="Active products" value={fmt.int(k.active_products)} hint={`${k.stocked_products} currently in stock`} icon={<Package />} to="/products" />
            <KpiCard
              label="Low-stock items"
              value={fmt.int(k.low_stock_items)}
              hint={`${k.out_of_stock_items} out of stock`}
              icon={<PackageX />}
              tone={k.out_of_stock_items ? 'danger' : 'warning'}
              to="/inventory?status=LOW_STOCK"
            />
            <KpiCard
              label="Shortage risks"
              value={fmt.int(k.shortage_risk_items)}
              hint="High or critical within lead time"
              icon={<ShieldAlert />}
              tone={k.shortage_risk_items ? 'danger' : 'success'}
              to="/stock-risks"
            />
            <KpiCard
              label="Sales (30 days)"
              value={`${fmt.int(k.sales_units_30d)} units`}
              change={k.sales_units_change_pct}
              hint="vs previous 30 days"
              icon={<TrendingUp />}
              tone="success"
              to="/sales"
            />
            <KpiCard label="Revenue (30 days)" value={fmt.moneyCompact(k.revenue_30d)} hint="Gross sales value" icon={<DollarSign />} tone="success" to="/reports" />
            <KpiCard
              label="Forecast demand (30 days)"
              value={`${fmt.int(k.forecast_units_30d)} units`}
              hint="Sum of latest item forecasts"
              icon={<TrendingUp />}
              to="/forecasting"
            />
            <KpiCard
              label="Open purchase orders"
              value={fmt.int(k.open_purchase_orders)}
              hint={`${fmt.moneyCompact(k.open_purchase_order_value)} outstanding · ${k.restock_recommendations} to reorder`}
              icon={<ClipboardList />}
              to="/purchase-orders"
            />
          </section>

          <div className="grid gap-6 xl:grid-cols-3">
            <ChartCard className="xl:col-span-2" title="Units sold per day" description="Last 90 days, all warehouses">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={d.sales_trend} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="period" tickFormatter={fmt.shortDate} tick={chartTheme.axis} tickLine={false} axisLine={false} minTickGap={32} />
                  <YAxis tick={chartTheme.axis} tickLine={false} axisLine={false} width={48} />
                  <Tooltip
                    {...chartTheme.tooltip}
                    labelFormatter={(v) => fmt.date(String(v))}
                    formatter={(v, _n, item) => [
                      `${fmt.int(Number(v))} units · ${fmt.money((item.payload as { revenue: number }).revenue)}`,
                      'Sold',
                    ]}
                  />
                  <Area type="monotone" dataKey="units" stroke="var(--chart-1)" strokeWidth={2} fill="url(#salesFill)" activeDot={{ r: 4 }} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Stock-risk distribution" description="Items by shortage risk level">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={[...d.risk_distribution].reverse()}
                  layout="vertical"
                  margin={{ top: 4, right: 36, left: 4, bottom: 0 }}
                >
                  <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tick={chartTheme.axis} tickLine={false} axisLine={false} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="risk_level"
                    tickFormatter={(v) => RISK_LABEL[v] ?? v}
                    tick={chartTheme.axis}
                    tickLine={false}
                    axisLine={false}
                    width={64}
                  />
                  <Tooltip {...chartTheme.tooltip} cursor={{ fill: 'var(--muted)' }} formatter={(v) => [`${v} items`, 'Count']} labelFormatter={(v) => `${RISK_LABEL[String(v)]} risk`} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={22} label={{ position: 'right', fontSize: 12, fill: 'var(--muted-foreground)' }}>
                    {[...d.risk_distribution].reverse().map((r) => (
                      <Cell key={r.risk_level} fill={RISK_COLORS[r.risk_level]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <ChartCard
              title="Forecasted demand"
              description="Next 30 days · sum of item forecasts with 80% interval"
              action={
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/forecasting">
                    Details <ArrowRight />
                  </Link>
                </Button>
              }
            >
              {d.forecast_trend.length === 0 ? (
                <EmptyState title="No forecasts yet" description="Run forecasting to see predicted demand." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={d.forecast_trend.map((p) => ({ ...p, band: [p.lower, p.upper] }))}
                    margin={{ top: 8, right: 8, left: -8, bottom: 0 }}
                  >
                    <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={fmt.shortDate} tick={chartTheme.axis} tickLine={false} axisLine={false} minTickGap={32} />
                    <YAxis tick={chartTheme.axis} tickLine={false} axisLine={false} width={48} />
                    <Tooltip
                      {...chartTheme.tooltip}
                      labelFormatter={(v) => fmt.date(String(v))}
                      formatter={(v, name) =>
                        name === 'band'
                          ? [`${fmt.int((v as number[])[0])} – ${fmt.int((v as number[])[1])}`, '80% interval']
                          : [`${fmt.int(Number(v))} units`, 'Forecast']
                      }
                    />
                    <Area dataKey="band" stroke="none" fill="var(--chart-1)" fillOpacity={0.15} activeDot={false} />
                    <Line dataKey="predicted" stroke="var(--chart-1)" strokeWidth={2} dot={false} strokeDasharray="5 3" />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            <ChartCard title="Inventory value" description="End-of-day stock value at cost, last 90 days">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={d.inventory_trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-3)" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="var(--chart-3)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={fmt.shortDate} tick={chartTheme.axis} tickLine={false} axisLine={false} minTickGap={32} />
                  <YAxis tickFormatter={(v) => fmt.moneyCompact(v)} tick={chartTheme.axis} tickLine={false} axisLine={false} width={56} />
                  <Tooltip
                    {...chartTheme.tooltip}
                    labelFormatter={(v) => fmt.date(String(v))}
                    formatter={(v, _n, item) => [`${fmt.money(Number(v))} · ${fmt.int((item.payload as { units: number }).units)} units`, 'Value']}
                  />
                  <Area type="monotone" dataKey="value" stroke="var(--chart-3)" strokeWidth={2} fill="url(#valueFill)" activeDot={{ r: 4 }} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <div className="grid gap-6 xl:grid-cols-5">
            <ChartCard className="xl:col-span-2" title="Stock value by warehouse" description="At cost" height={240}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={d.warehouse_distribution} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="code" tick={chartTheme.axis} tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={(v) => fmt.moneyCompact(v)} tick={chartTheme.axis} tickLine={false} axisLine={false} width={56} />
                  <Tooltip
                    {...chartTheme.tooltip}
                    cursor={{ fill: 'var(--muted)' }}
                    formatter={(v, _n, item) => {
                      const p = item.payload as { units: number; low_stock_items: number }
                      return [`${fmt.money(Number(v))} · ${fmt.int(p.units)} units · ${p.low_stock_items} low`, 'Value']
                    }}
                    labelFormatter={(v, payload) => (payload?.[0]?.payload as { name?: string } | undefined)?.name ?? String(v)}
                  />
                  <Bar dataKey="value" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={56} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <Card className="xl:col-span-3">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <AlertTriangle className="size-4 text-destructive" /> Items needing attention
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">Highest shortage risks right now</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/restocking">
                      <ShoppingCart /> Restock
                    </Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="px-0 pb-2">
                {risks.error ? (
                  <ErrorState error={risks.error} onRetry={() => risks.refetch()} />
                ) : !risks.data ? (
                  <CardsSkeleton count={2} />
                ) : risks.data.length === 0 ? (
                  <EmptyState title="No high-risk items" description="Stock covers expected demand across all warehouses." />
                ) : (
                  <ul className="divide-y">
                    {risks.data.slice(0, 6).map((r) => (
                      <li key={r.inventory_item_id}>
                        <Link to={`/products/${r.product_id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-muted/50">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{r.product_name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {r.sku} · {r.warehouse_code} · {r.reason}
                            </p>
                          </div>
                          <div className="hidden text-right text-xs sm:block">
                            <p className="font-medium tabular">{fmt.int(r.available_quantity)} avail.</p>
                            <p className="text-muted-foreground">{r.days_of_cover != null ? `${r.days_of_cover} days cover` : '—'}</p>
                          </div>
                          <RiskBadge level={r.risk_level} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </>
  )
}
