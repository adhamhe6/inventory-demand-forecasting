import { Link } from 'react-router-dom'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { qk, useAllWarehouses, usePaged } from '@/api/queries'
import { ChartCard, chartTheme } from '@/components/common/ChartCard'
import { type Column, DataTable } from '@/components/common/DataTable'
import { CardsSkeleton, EmptyState, ErrorState, TableSkeleton } from '@/components/common/States'
import { ActiveBadge, StockStatusBadge } from '@/components/common/StatusBadge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { useUrlState } from '@/lib/hooks'
import type { InventoryItem, WarehouseSummary } from '@/lib/types'
import { fmt } from '@/lib/utils'
import { ExportButton, Segmented, SimpleTable, Stat, StatGrid, Toolbar } from './shared'
import { hideCls, useReport } from './lib'

interface InventoryValue {
  group_by: 'warehouse' | 'category'
  rows: Array<{ group: string; products: number; units: number; cost_value: number; retail_value: number }>
  total_cost_value: number
  total_retail_value: number
}

const INV_DEFAULTS = { group_by: 'warehouse', trend_days: 90, trend_wh: '' }

export function InventoryReport() {
  const [f, setF] = useUrlState(INV_DEFAULTS)
  const warehouses = useAllWarehouses()
  const value = useReport<InventoryValue>('inventory-value', '/reports/inventory-value', { group_by: f.group_by })
  const trend = useReport<Array<{ date: string; units: number; value: number }>>('inventory-trend', '/reports/inventory-trend', {
    days: f.trend_days,
    warehouse_id: f.trend_wh,
  })
  const v = value.data
  const units = v?.rows.reduce((s, r) => s + r.units, 0) ?? 0
  const margin = v ? v.total_retail_value - v.total_cost_value : 0

  return (
    <>
      <Toolbar
        actions={
          <>
            <ExportButton path="/reports/inventory-value" query={{ group_by: f.group_by }} label="Export summary" />
            <ExportButton path="/inventory" label="Export full inventory" />
          </>
        }
      >
        <span className="text-sm text-muted-foreground">Group by</span>
        <Segmented
          label="Group inventory value by"
          value={f.group_by}
          onChange={(group_by) => setF({ group_by })}
          options={[
            { value: 'warehouse', label: 'Warehouse' },
            { value: 'category', label: 'Category' },
          ]}
        />
      </Toolbar>

      {value.error ? (
        <Card className="mb-6">
          <ErrorState error={value.error} onRetry={() => value.refetch()} />
        </Card>
      ) : !v ? (
        <div className="mb-6">
          <CardsSkeleton count={4} />
        </div>
      ) : (
        <StatGrid>
          <Stat label="Stock value (cost)" value={fmt.moneyCompact(v.total_cost_value)} hint={fmt.money(v.total_cost_value)} />
          <Stat label="Stock value (retail)" value={fmt.moneyCompact(v.total_retail_value)} hint={fmt.money(v.total_retail_value)} />
          <Stat label="Potential gross margin" value={fmt.moneyCompact(margin)} hint={v.total_retail_value ? `${fmt.pct(margin / v.total_retail_value)} of retail value` : undefined} />
          <Stat label="Units on hand" value={fmt.int(units)} hint={`across ${v.rows.length} ${f.group_by === 'warehouse' ? 'warehouses' : 'categories'}`} />
        </StatGrid>
      )}

      <div className="grid gap-6 [&>*]:min-w-0 xl:grid-cols-5">
        <ChartCard className="xl:col-span-2" title={`Value by ${f.group_by}`} description="Cost vs retail value of stock on hand" loading={!v && !value.error}>
          {v && v.rows.length === 0 ? (
            <EmptyState title="No stock" description="Receive stock to see inventory value." />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={v?.rows} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 0 }} barGap={2}>
                <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tickFormatter={(x) => fmt.moneyCompact(x)} tick={chartTheme.axis} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="group" tick={chartTheme.axis} tickLine={false} axisLine={false} width={f.group_by === 'category' ? 128 : 80} />
                <Tooltip {...chartTheme.tooltip} cursor={{ fill: 'var(--muted)' }} formatter={(x, n) => [fmt.money(Number(x)), n === 'cost_value' ? 'Cost value' : 'Retail value']} />
                <Bar dataKey="cost_value" fill="var(--chart-1)" radius={[0, 4, 4, 0]} maxBarSize={14} animationDuration={500} />
                <Bar dataKey="retail_value" fill="var(--chart-2)" radius={[0, 4, 4, 0]} maxBarSize={14} animationDuration={500} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Breakdown by {f.group_by}</CardTitle>
            <CardDescription className="flex flex-wrap gap-x-4 gap-y-1">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-sm bg-[var(--chart-1)]" aria-hidden /> Cost value
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-sm bg-[var(--chart-2)]" aria-hidden /> Retail value
              </span>
            </CardDescription>
          </CardHeader>
          {!v ? (
            <TableSkeleton rows={4} cols={5} />
          ) : (
            <SimpleTable
              caption="Inventory value breakdown"
              head={[
                { label: f.group_by === 'warehouse' ? 'Warehouse' : 'Category' },
                { label: 'Products', align: 'right', hideBelow: 'sm' },
                { label: 'Units', align: 'right' },
                { label: 'Cost value', align: 'right' },
                { label: 'Retail value', align: 'right', hideBelow: 'md' },
                { label: 'Share', align: 'right', hideBelow: 'sm' },
              ]}
            >
              {v.rows.map((r) => (
                <tr key={r.group}>
                  <td className="font-medium">{r.group}</td>
                  <td className={`text-right tabular ${hideCls.sm}`}>{r.products}</td>
                  <td className="text-right tabular">{fmt.int(r.units)}</td>
                  <td className="text-right tabular">{fmt.money(r.cost_value)}</td>
                  <td className={`text-right tabular ${hideCls.md}`}>{fmt.money(r.retail_value)}</td>
                  <td className={`text-right tabular text-muted-foreground ${hideCls.sm}`}>{fmt.pct(v.total_cost_value ? r.cost_value / v.total_cost_value : 0)}</td>
                </tr>
              ))}
              <tr className="bg-muted/40 font-semibold">
                <td>Total</td>
                <td className={hideCls.sm} />
                <td className="text-right tabular">{fmt.int(units)}</td>
                <td className="text-right tabular">{fmt.money(v.total_cost_value)}</td>
                <td className={`text-right tabular ${hideCls.md}`}>{fmt.money(v.total_retail_value)}</td>
                <td className={`text-right tabular ${hideCls.sm}`}>100%</td>
              </tr>
            </SimpleTable>
          )}
        </Card>
      </div>

      <ChartCard
        className="mt-6"
        title="Inventory value over time"
        description="End-of-day stock value at cost, reconstructed from the stock ledger"
        action={
          <div className="flex flex-wrap justify-end gap-2">
            <NativeSelect aria-label="Trend warehouse" className="h-8 w-40" value={f.trend_wh} onChange={(e) => setF({ trend_wh: e.target.value })}>
              <option value="">All warehouses</option>
              {warehouses.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect aria-label="Trend period" className="h-8 w-32" value={f.trend_days} onChange={(e) => setF({ trend_days: Number(e.target.value) })}>
              {[30, 90, 180, 365].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </NativeSelect>
          </div>
        }
        loading={!trend.data && !trend.error}
      >
        {trend.error ? (
          <ErrorState error={trend.error} onRetry={() => trend.refetch()} />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trend.data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="rptValueFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tickFormatter={fmt.shortDate} tick={chartTheme.axis} tickLine={false} axisLine={false} minTickGap={32} />
              <YAxis tickFormatter={(x) => fmt.moneyCompact(x)} tick={chartTheme.axis} tickLine={false} axisLine={false} width={56} />
              <Tooltip
                {...chartTheme.tooltip}
                labelFormatter={(x) => fmt.date(String(x))}
                formatter={(x, _n, item) => [`${fmt.money(Number(x))} · ${fmt.int((item.payload as { units: number }).units)} units`, 'Stock value']}
              />
              <Area type="monotone" dataKey="value" stroke="var(--chart-1)" strokeWidth={2} fill="url(#rptValueFill)" animationDuration={500} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </>
  )
}

const LOW_DEFAULTS = { ls_page: 1, ls_size: 25, ls_wh: '', ls_sort: '' }

export function LowStockReport() {
  const [f, setF] = useUrlState(LOW_DEFAULTS)
  const warehouses = useAllWarehouses()
  const query = { page: f.ls_page, page_size: f.ls_size, warehouse_id: f.ls_wh, sort: f.ls_sort }
  const q = usePaged<InventoryItem>(qk.reports('low-stock', query), '/reports/low-stock', query)
  const columns: Column<InventoryItem>[] = [
    {
      key: 'sku',
      header: 'SKU',
      sortKey: 'sku',
      cell: (i) => (
        <Link to={`/products/${i.product_id}`} className="whitespace-nowrap font-mono text-xs font-medium text-primary hover:underline">
          {i.sku}
        </Link>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      sortKey: 'product_name',
      hideBelow: 'sm',
      cell: (i) => (
        <div className="min-w-0 max-w-[16rem]">
          <p className="truncate font-medium">{i.product_name}</p>
          <p className="truncate text-xs text-muted-foreground">{i.category}</p>
        </div>
      ),
    },
    { key: 'wh', header: 'Warehouse', sortKey: 'warehouse_code', cell: (i) => <span className="whitespace-nowrap">{i.warehouse_code}</span> },
    { key: 'onhand', header: 'On hand', sortKey: 'quantity_on_hand', align: 'right', hideBelow: 'md', cell: (i) => <span className="tabular">{fmt.int(i.quantity_on_hand)}</span> },
    { key: 'avail', header: 'Available', sortKey: 'available_quantity', align: 'right', cell: (i) => <span className="font-semibold tabular">{fmt.int(i.available_quantity)}</span> },
    { key: 'safety', header: 'Safety', align: 'right', hideBelow: 'lg', cell: (i) => <span className="tabular text-muted-foreground">{fmt.int(i.safety_stock)}</span> },
    { key: 'rop', header: 'Reorder pt.', sortKey: 'reorder_point', align: 'right', hideBelow: 'md', cell: (i) => <span className="tabular text-muted-foreground">{fmt.int(i.reorder_point)}</span> },
    { key: 'status', header: 'Status', sortKey: 'status', cell: (i) => <StockStatusBadge status={i.status} /> },
  ]
  return (
    <>
      <Toolbar actions={<ExportButton path="/reports/low-stock" query={{ warehouse_id: f.ls_wh, sort: f.ls_sort }} />}>
        <NativeSelect aria-label="Warehouse" className="w-44" value={f.ls_wh} onChange={(e) => setF({ ls_wh: e.target.value, ls_page: 1 })}>
          <option value="">All warehouses</option>
          {warehouses.data?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code}
            </option>
          ))}
        </NativeSelect>
        {q.data && <span className="text-sm text-muted-foreground">{fmt.int(q.data.total)} items at or below reorder point</span>}
      </Toolbar>
      <Card>
        <DataTable
          caption="Low stock items"
          columns={columns}
          rows={q.data?.items}
          rowKey={(i) => i.id}
          loading={q.isFetching}
          error={q.error}
          onRetry={() => q.refetch()}
          sort={f.ls_sort || 'status'}
          onSortChange={(ls_sort) => setF({ ls_sort, ls_page: 1 })}
          empty={<EmptyState title="Nothing is low on stock" description="Every item is above its reorder point." />}
          page={f.ls_page}
          pageSize={f.ls_size}
          total={q.data?.total}
          onPageChange={(ls_page) => setF({ ls_page })}
          onPageSizeChange={(ls_size) => setF({ ls_size, ls_page: 1 })}
        />
      </Card>
    </>
  )
}

export function WarehousesReport() {
  const q = useReport<WarehouseSummary[]>('warehouse-summary', '/warehouses/summary')
  const rows = q.data ?? []
  const total = rows.reduce((s, r) => s + r.inventory_value, 0)
  if (q.error)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    )
  return (
    <>
      {q.data && (
        <StatGrid>
          <Stat label="Warehouses" value={rows.length} hint={`${rows.filter((r) => r.status === 'ACTIVE').length} active`} />
          <Stat label="Stock value" value={fmt.moneyCompact(total)} hint="at cost" />
          <Stat label="Units on hand" value={fmt.int(rows.reduce((s, r) => s + r.total_units, 0))} hint={`${fmt.int(rows.reduce((s, r) => s + r.reserved_units, 0))} reserved`} />
          <Stat
            label="Low-stock items"
            value={fmt.int(rows.reduce((s, r) => s + r.low_stock_items, 0))}
            tone={rows.some((r) => r.low_stock_items) ? 'warning' : 'success'}
            hint="at or below reorder point"
          />
        </StatGrid>
      )}
      <div className="grid gap-6 [&>*]:min-w-0 xl:grid-cols-5">
        <ChartCard className="xl:col-span-2" title="Stock value by warehouse" description="At cost" loading={!q.data}>
          {rows.length === 0 ? (
            <EmptyState title="No warehouses" description="Create a warehouse to get started." />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="code" tick={chartTheme.axis} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={(x) => fmt.moneyCompact(x)} tick={chartTheme.axis} tickLine={false} axisLine={false} width={56} />
                <Tooltip
                  {...chartTheme.tooltip}
                  cursor={{ fill: 'var(--muted)' }}
                  labelFormatter={(x, p) => (p?.[0]?.payload as { name?: string } | undefined)?.name ?? String(x)}
                  formatter={(x, _n, item) => [`${fmt.money(Number(x))} · ${fmt.int((item.payload as WarehouseSummary).total_units)} units`, 'Value']}
                />
                <Bar dataKey="inventory_value" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={56} animationDuration={500} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Warehouse summary</CardTitle>
          </CardHeader>
          {!q.data ? (
            <TableSkeleton rows={3} cols={5} />
          ) : (
            <SimpleTable
              caption="Warehouse summary"
              head={[
                { label: 'Warehouse' },
                { label: 'Status', hideBelow: 'md' },
                { label: 'Products', align: 'right', hideBelow: 'sm' },
                { label: 'Units', align: 'right' },
                { label: 'Reserved', align: 'right', hideBelow: 'lg' },
                { label: 'Value', align: 'right' },
                { label: 'Low', align: 'right', hideBelow: 'sm' },
              ]}
            >
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/warehouses/${r.id}`} className="font-medium text-primary hover:underline">
                      {r.code}
                    </Link>
                    <p className="max-w-[14rem] truncate text-xs text-muted-foreground">
                      {r.name}
                      {r.location ? ` · ${r.location}` : ''}
                    </p>
                  </td>
                  <td className={hideCls.md}>
                    <ActiveBadge active={r.status === 'ACTIVE'} />
                  </td>
                  <td className={`text-right tabular ${hideCls.sm}`}>{r.product_count}</td>
                  <td className="text-right tabular">{fmt.int(r.total_units)}</td>
                  <td className={`text-right tabular text-muted-foreground ${hideCls.lg}`}>{fmt.int(r.reserved_units)}</td>
                  <td className="text-right tabular">{fmt.money(r.inventory_value)}</td>
                  <td className={`text-right tabular ${hideCls.sm} ${r.low_stock_items ? 'font-semibold text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
                    {r.low_stock_items}
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
