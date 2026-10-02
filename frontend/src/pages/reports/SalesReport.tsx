import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useAllWarehouses, useCategories } from '@/api/queries'
import { ChartCard, chartTheme } from '@/components/common/ChartCard'
import { CardsSkeleton, EmptyState, ErrorState, InlineError, TableSkeleton } from '@/components/common/States'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, NativeSelect } from '@/components/ui/input'
import { useUrlState } from '@/lib/hooks'
import { daysAgo, fmt, isoDate } from '@/lib/utils'
import { ExportButton, Segmented, SimpleTable, Stat, StatGrid, Toolbar } from './shared'
import { hideCls, useReport } from './lib'

interface SalesSummary {
  date_from: string
  date_to: string
  granularity: 'day' | 'week' | 'month'
  totals: { units: number; revenue: number; orders: number; avg_order_value: number }
  series: Array<{ period: string; units: number; revenue: number; orders: number }>
  top_products: Array<{ product_id: number; sku: string; name: string; category: string; units: number; revenue: number }>
}

const QUICK = [30, 90, 180, 365] as const
const DEFAULTS = { date_from: '', date_to: '', granularity: 'week', s_wh: '', s_cat: '' }

function periodLabel(p: string, g: string) {
  if (g === 'month') return new Date(`${p}T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  return fmt.shortDate(p)
}

export function SalesReport() {
  const [f, setF] = useUrlState(DEFAULTS)
  const warehouses = useAllWarehouses()
  const categories = useCategories()
  const [today] = useState(() => isoDate(new Date()))
  const from = f.date_from || daysAgo(89)
  const to = f.date_to || today
  const invalid = from > to ? 'Start date must be on or before the end date.' : null
  const query = { date_from: from, date_to: to, granularity: f.granularity, warehouse_id: f.s_wh, category: f.s_cat, top: 10 }
  const q = useReport<SalesSummary>('sales-summary', '/reports/sales-summary', query, !invalid)
  const d = q.data
  const activeQuick = QUICK.find((n) => to === today && from === daysAgo(n - 1))

  const tooltipLabel = (x: unknown) => {
    const p = String(x)
    return f.granularity === 'day' ? fmt.date(p) : f.granularity === 'week' ? `Week of ${fmt.date(p)}` : periodLabel(p, 'month')
  }

  return (
    <>
      <Toolbar actions={<ExportButton path="/reports/sales-summary" query={query} />}>
        <Segmented
          label="Quick date range"
          value={activeQuick ?? 0}
          onChange={(n) => setF({ date_from: daysAgo(n - 1), date_to: '' })}
          options={QUICK.map((n) => ({ value: n, label: n === 365 ? '1y' : `${n}d` }))}
        />
        <div className="flex items-center gap-1.5">
          <Input type="date" aria-label="From date" className="w-[9.5rem]" value={from} max={to} onChange={(e) => setF({ date_from: e.target.value })} />
          <span className="text-muted-foreground" aria-hidden>
            –
          </span>
          <Input type="date" aria-label="To date" className="w-[9.5rem]" value={to} max={today} onChange={(e) => setF({ date_to: e.target.value === today ? '' : e.target.value })} />
        </div>
        <NativeSelect aria-label="Granularity" className="w-28" value={f.granularity} onChange={(e) => setF({ granularity: e.target.value })}>
          <option value="day">Daily</option>
          <option value="week">Weekly</option>
          <option value="month">Monthly</option>
        </NativeSelect>
        <NativeSelect aria-label="Warehouse" className="w-40" value={f.s_wh} onChange={(e) => setF({ s_wh: e.target.value })}>
          <option value="">All warehouses</option>
          {warehouses.data?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Category" className="w-44" value={f.s_cat} onChange={(e) => setF({ s_cat: e.target.value })}>
          <option value="">All categories</option>
          {categories.data?.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </NativeSelect>
      </Toolbar>

      {invalid ? (
        <InlineError error={new Error(invalid)} />
      ) : q.error ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : !d ? (
        <div className="space-y-4">
          <CardsSkeleton count={4} />
          <TableSkeleton />
        </div>
      ) : (
        <div className={q.isFetching ? 'opacity-70 transition-opacity' : undefined}>
          <StatGrid>
            <Stat label="Units sold" value={fmt.int(d.totals.units)} hint={`${fmt.date(d.date_from)} – ${fmt.date(d.date_to)}`} />
            <Stat label="Revenue" value={fmt.moneyCompact(d.totals.revenue)} hint={fmt.money(d.totals.revenue)} />
            <Stat label="Orders" value={fmt.int(d.totals.orders)} hint={`${fmt.num(d.totals.orders ? d.totals.units / d.totals.orders : 0)} units / order`} />
            <Stat label="Avg order value" value={fmt.money(d.totals.avg_order_value)} />
          </StatGrid>
          {d.series.length === 0 ? (
            <Card>
              <EmptyState title="No sales in this period" description="Try a wider date range or clear the warehouse and category filters." />
            </Card>
          ) : (
            <>
              <div className="grid gap-6 [&>*]:min-w-0 xl:grid-cols-2">
                <ChartCard title="Units sold" description={`Per ${f.granularity}`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={d.series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                      <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="period" tickFormatter={(p) => periodLabel(p, f.granularity)} tick={chartTheme.axis} tickLine={false} axisLine={false} minTickGap={24} />
                      <YAxis tick={chartTheme.axis} tickLine={false} axisLine={false} width={48} />
                      <Tooltip
                        {...chartTheme.tooltip}
                        cursor={{ fill: 'var(--muted)' }}
                        labelFormatter={tooltipLabel}
                        formatter={(x, _n, item) => [`${fmt.int(Number(x))} units · ${fmt.int((item.payload as { orders: number }).orders)} orders`, 'Sold']}
                      />
                      <Bar dataKey="units" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={40} animationDuration={500} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
                <ChartCard title="Revenue" description={`Per ${f.granularity}, gross sales value`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={d.series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="period" tickFormatter={(p) => periodLabel(p, f.granularity)} tick={chartTheme.axis} tickLine={false} axisLine={false} minTickGap={24} />
                      <YAxis tickFormatter={(x) => fmt.moneyCompact(x)} tick={chartTheme.axis} tickLine={false} axisLine={false} width={56} />
                      <Tooltip {...chartTheme.tooltip} cursor={{ fill: 'var(--muted)' }} labelFormatter={tooltipLabel} formatter={(x) => [fmt.money(Number(x)), 'Revenue']} />
                      <Bar dataKey="revenue" fill="var(--chart-3)" radius={[4, 4, 0, 0]} maxBarSize={40} animationDuration={500} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>
              <Card className="mt-6">
                <CardHeader>
                  <CardTitle>Top products</CardTitle>
                  <CardDescription>Best sellers by revenue in the selected period</CardDescription>
                </CardHeader>
                <SimpleTable
                  caption="Top products by revenue"
                  head={[{ label: '#' }, { label: 'Product' }, { label: 'Category', hideBelow: 'md' }, { label: 'Units', align: 'right', hideBelow: 'sm' }, { label: 'Revenue', align: 'right' }, { label: 'Share', align: 'right', hideBelow: 'lg' }]}
                >
                  {d.top_products.map((p, i) => (
                    <tr key={p.product_id}>
                      <td className="w-8 tabular text-muted-foreground">{i + 1}</td>
                      <td>
                        <Link to={`/products/${p.product_id}`} className="font-medium hover:text-primary hover:underline">
                          {p.name}
                        </Link>
                        <p className="font-mono text-xs text-muted-foreground">{p.sku}</p>
                      </td>
                      <td className={`text-muted-foreground ${hideCls.md}`}>{p.category}</td>
                      <td className={`text-right tabular ${hideCls.sm}`}>{fmt.int(p.units)}</td>
                      <td className="text-right font-semibold tabular">{fmt.money(p.revenue)}</td>
                      <td className={`text-right tabular text-muted-foreground ${hideCls.lg}`}>{fmt.pct(d.totals.units ? p.units / d.totals.units : 0)}</td>
                    </tr>
                  ))}
                </SimpleTable>
              </Card>
            </>
          )}
        </div>
      )}
    </>
  )
}
