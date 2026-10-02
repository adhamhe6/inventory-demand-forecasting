import { AlertTriangle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartCard, chartTheme } from '@/components/common/ChartCard'
import { CardsSkeleton, EmptyState, ErrorState, TableSkeleton } from '@/components/common/States'
import { ActiveBadge, POStatusBadge } from '@/components/common/StatusBadge'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { POStatus } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { ExportButton, SimpleTable, Stat, StatGrid, Toolbar } from './shared'
import { hideCls, useReport } from './lib'

interface SupplierPerf {
  supplier_id: number
  supplier_name: string
  promised_lead_time_days: number
  status: 'ACTIVE' | 'INACTIVE'
  total_purchase_orders: number
  open_purchase_orders: number
  received_purchase_orders: number
  total_spend: number
  on_time_rate: number | null
  avg_actual_lead_time_days: number | null
  fill_rate: number | null
  overdue_purchase_orders: number
}

function RateBar({ value, label }: { value: number | null; label: string }) {
  if (value == null) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="hidden h-1.5 w-16 rounded-full bg-muted lg:block" aria-hidden>
        <div className="h-full rounded-full bg-[var(--chart-1)]" style={{ width: `${Math.min(100, value * 100)}%` }} />
      </div>
      <span className="w-12 text-right tabular" aria-label={`${label} ${fmt.pct(value)}`}>
        {fmt.pct(value, 0)}
      </span>
    </div>
  )
}

export function SuppliersReport() {
  const q = useReport<SupplierPerf[]>('supplier-performance', '/reports/supplier-performance')
  if (q.error)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    )
  const rows = [...(q.data ?? [])].sort((a, b) => b.total_spend - a.total_spend)
  const withPOs = rows.filter((r) => r.received_purchase_orders > 0)
  const spend = rows.reduce((s, r) => s + r.total_spend, 0)
  const weightedOnTime = withPOs.length
    ? withPOs.reduce((s, r) => s + (r.on_time_rate ?? 0) * r.received_purchase_orders, 0) / withPOs.reduce((s, r) => s + r.received_purchase_orders, 0)
    : null
  const chartRows = withPOs.map((r) => ({ name: r.supplier_name, on_time: (r.on_time_rate ?? 0) * 100 })).sort((a, b) => b.on_time - a.on_time)

  return (
    <>
      <Toolbar actions={<ExportButton path="/reports/supplier-performance" />}>
        <p className="text-sm text-muted-foreground">On-time = received on or before the expected delivery date. Fill rate = units received ÷ units ordered.</p>
      </Toolbar>
      {!q.data ? (
        <div className="space-y-4">
          <CardsSkeleton count={4} />
          <TableSkeleton />
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState title="No suppliers yet" description="Add suppliers and purchase orders to measure performance." />
        </Card>
      ) : (
        <>
          <StatGrid>
            <Stat label="Total spend" value={fmt.moneyCompact(spend)} hint={`${rows.length} suppliers`} />
            <Stat label="On-time delivery" value={fmt.pct(weightedOnTime, 0)} hint="weighted by received POs" tone={weightedOnTime != null && weightedOnTime < 0.6 ? 'warning' : undefined} />
            <Stat label="Open POs" value={fmt.int(rows.reduce((s, r) => s + r.open_purchase_orders, 0))} />
            <Stat
              label="Overdue POs"
              value={fmt.int(rows.reduce((s, r) => s + r.overdue_purchase_orders, 0))}
              tone={rows.some((r) => r.overdue_purchase_orders) ? 'danger' : 'success'}
              hint="past expected delivery"
            />
          </StatGrid>
          <div className="grid items-start gap-6 [&>*]:min-w-0 2xl:grid-cols-5">
            <ChartCard className="2xl:col-span-2" title="On-time delivery rate" description="Share of received POs delivered on time" height={Math.max(200, chartRows.length * 40)}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartRows} layout="vertical" margin={{ top: 4, right: 40, left: 4, bottom: 0 }}>
                  <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" domain={[0, 100]} tickFormatter={(x) => `${x}%`} tick={chartTheme.axis} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="name" tick={chartTheme.axis} tickLine={false} axisLine={false} width={132} />
                  <Tooltip {...chartTheme.tooltip} cursor={{ fill: 'var(--muted)' }} formatter={(x) => [`${Number(x).toFixed(1)}%`, 'On time']} />
                  <Bar
                    dataKey="on_time"
                    fill="var(--chart-1)"
                    radius={[0, 4, 4, 0]}
                    barSize={18}
                    animationDuration={500}
                    label={{ position: 'right', fontSize: 11, fill: 'var(--muted-foreground)', formatter: (x: unknown) => `${Math.round(Number(x))}%` }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <Card className="2xl:col-span-3">
              <CardHeader>
                <CardTitle>Supplier scorecard</CardTitle>
                <CardDescription>Lead time: average actual vs promised (days)</CardDescription>
              </CardHeader>
              <SimpleTable
                caption="Supplier performance"
                head={[
                  { label: 'Supplier' },
                  { label: 'On time', align: 'right' },
                  { label: 'Lead time', align: 'right', hideBelow: 'sm' },
                  { label: 'Fill rate', align: 'right', hideBelow: 'md' },
                  { label: 'Spend', align: 'right', hideBelow: 'sm' },
                  { label: 'Open / overdue', align: 'right', hideBelow: 'lg' },
                ]}
              >
                {rows.map((r) => {
                  const delta = r.avg_actual_lead_time_days != null ? r.avg_actual_lead_time_days - r.promised_lead_time_days : null
                  return (
                    <tr key={r.supplier_id}>
                      <td>
                        <Link to={`/suppliers/${r.supplier_id}`} className="font-medium hover:text-primary hover:underline">
                          {r.supplier_name}
                        </Link>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                          {r.total_purchase_orders} POs {r.status === 'INACTIVE' && <ActiveBadge active={false} />}
                        </div>
                      </td>
                      <td className="text-right">
                        <RateBar value={r.on_time_rate} label="On-time rate" />
                      </td>
                      <td className={`whitespace-nowrap text-right tabular ${hideCls.sm}`}>
                        {r.avg_actual_lead_time_days == null ? (
                          <span className="text-muted-foreground">— / {r.promised_lead_time_days}</span>
                        ) : (
                          <>
                            {fmt.num(r.avg_actual_lead_time_days)} <span className="text-muted-foreground">/ {r.promised_lead_time_days}</span>
                            {delta != null && Math.abs(delta) >= 0.1 && (
                              <span className={cn('block text-xs', delta > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')}>
                                {delta > 0 ? '+' : '−'}
                                {fmt.num(Math.abs(delta))}d {delta > 0 ? 'late' : 'early'}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className={`text-right tabular ${hideCls.md}`}>{fmt.pct(r.fill_rate)}</td>
                      <td className={`text-right tabular ${hideCls.sm}`}>{fmt.money(r.total_spend)}</td>
                      <td className={`text-right tabular ${hideCls.lg}`}>
                        {r.open_purchase_orders}
                        {' / '}
                        <span className={r.overdue_purchase_orders ? 'font-semibold text-destructive' : 'text-muted-foreground'}>{r.overdue_purchase_orders}</span>
                      </td>
                    </tr>
                  )
                })}
              </SimpleTable>
            </Card>
          </div>
        </>
      )}
    </>
  )
}

interface POReport {
  by_status: Array<{ status: POStatus; count: number; value: number; outstanding_units: number }>
  overdue: Array<{ id: number; po_number: string; supplier_name: string; expected_delivery_date: string; status: POStatus; days_overdue: number }>
}

const STATUS_ORDER: POStatus[] = ['DRAFT', 'SUBMITTED', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']
const STATUS_LABEL: Record<POStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  CONFIRMED: 'Confirmed',
  PARTIALLY_RECEIVED: 'Partial',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
}

export function PurchaseOrdersReport() {
  const q = useReport<POReport>('purchase-orders', '/reports/purchase-orders')
  if (q.error)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    )
  const d = q.data
  const rows = d ? [...d.by_status].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)) : []
  const open = rows.filter((r) => !['RECEIVED', 'CANCELLED'].includes(r.status))
  return (
    <>
      <Toolbar actions={<ExportButton path="/purchase-orders" label="Export purchase orders" />}>
        <p className="text-sm text-muted-foreground">All-time purchase order pipeline and late deliveries.</p>
      </Toolbar>
      {!d ? (
        <div className="space-y-4">
          <CardsSkeleton count={4} />
          <TableSkeleton />
        </div>
      ) : (
        <>
          <StatGrid>
            <Stat label="Open POs" value={fmt.int(open.reduce((s, r) => s + r.count, 0))} hint="draft → partially received" />
            <Stat label="Open PO value" value={fmt.moneyCompact(open.reduce((s, r) => s + r.value, 0))} />
            <Stat label="Units outstanding" value={fmt.int(open.reduce((s, r) => s + r.outstanding_units, 0))} />
            <Stat label="Overdue" value={fmt.int(d.overdue.length)} tone={d.overdue.length ? 'danger' : 'success'} hint="past expected delivery" />
          </StatGrid>
          <div className="grid gap-6 [&>*]:min-w-0 xl:grid-cols-2">
            <ChartCard title="Open pipeline" description="Open purchase orders by status (received and cancelled are in the table)">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={open} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="status" tickFormatter={(x) => STATUS_LABEL[x as POStatus] ?? x} tick={chartTheme.axis} tickLine={false} axisLine={false} interval={0} />
                  <YAxis tick={chartTheme.axis} tickLine={false} axisLine={false} width={48} allowDecimals={false} />
                  <Tooltip
                    {...chartTheme.tooltip}
                    cursor={{ fill: 'var(--muted)' }}
                    labelFormatter={(x) => STATUS_LABEL[x as POStatus] ?? String(x)}
                    formatter={(x, _n, item) => [`${fmt.int(Number(x))} POs · ${fmt.money((item.payload as { value: number }).value)}`, 'Orders']}
                  />
                  <Bar dataKey="count" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={48} animationDuration={500} label={{ position: 'top', fontSize: 11, fill: 'var(--muted-foreground)' }} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <Card>
              <CardHeader>
                <CardTitle>Status breakdown</CardTitle>
                <CardDescription>All purchase orders, all time. Select a status to open the list.</CardDescription>
              </CardHeader>
              <SimpleTable
                caption="Purchase orders by status"
                head={[{ label: 'Status' }, { label: 'POs', align: 'right' }, { label: 'Value', align: 'right' }, { label: 'Outstanding units', align: 'right', hideBelow: 'sm' }]}
              >
                {rows.map((r) => (
                  <tr key={r.status}>
                    <td>
                      <Link to={`/purchase-orders?status=${r.status}`} className="hover:underline">
                        <POStatusBadge status={r.status} />
                      </Link>
                    </td>
                    <td className="text-right tabular">{fmt.int(r.count)}</td>
                    <td className="text-right tabular">{fmt.money(r.value)}</td>
                    <td className={`text-right tabular text-muted-foreground ${hideCls.sm}`}>{fmt.int(r.outstanding_units)}</td>
                  </tr>
                ))}
              </SimpleTable>
            </Card>
          </div>
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="size-4 text-destructive" aria-hidden /> Overdue purchase orders
              </CardTitle>
              <CardDescription>Open POs whose expected delivery date has passed</CardDescription>
            </CardHeader>
            {d.overdue.length === 0 ? (
              <EmptyState title="Nothing overdue" description="All open purchase orders are within their expected delivery dates." />
            ) : (
              <SimpleTable caption="Overdue purchase orders" head={[{ label: 'PO' }, { label: 'Supplier', hideBelow: 'sm' }, { label: 'Expected', hideBelow: 'md' }, { label: 'Status', hideBelow: 'sm' }, { label: 'Overdue', align: 'right' }]}>
                {[...d.overdue]
                  .sort((a, b) => b.days_overdue - a.days_overdue)
                  .map((o) => (
                    <tr key={o.id}>
                      <td>
                        <Link to={`/purchase-orders/${o.id}`} className="font-mono text-xs font-medium text-primary hover:underline">
                          {o.po_number}
                        </Link>
                        <p className="text-xs text-muted-foreground sm:hidden">{o.supplier_name}</p>
                      </td>
                      <td className={hideCls.sm}>{o.supplier_name}</td>
                      <td className={`text-muted-foreground ${hideCls.md}`}>{fmt.date(o.expected_delivery_date)}</td>
                      <td className={hideCls.sm}>
                        <POStatusBadge status={o.status} />
                      </td>
                      <td className="text-right">
                        <Badge variant={o.days_overdue > 7 ? 'danger' : 'warning'}>
                          {o.days_overdue} day{o.days_overdue === 1 ? '' : 's'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
              </SimpleTable>
            )}
          </Card>
        </>
      )}
    </>
  )
}
