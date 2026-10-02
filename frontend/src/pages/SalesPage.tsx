import { FileUp, Plus, Receipt, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { qk, useAllProducts, useAllWarehouses, usePaged } from '@/api/queries'
import { type Column, DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { SearchInput } from '@/components/common/SearchInput'
import { EmptyState } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { useAuth } from '@/lib/auth'
import { useUrlState } from '@/lib/hooks'
import type { Sale } from '@/lib/types'
import { fmt } from '@/lib/utils'
import { DateRangeFilter } from './purchasing/shared'
import { ImportSalesDialog } from './sales/ImportSalesDialog'
import { RecordSaleDialog } from './sales/RecordSaleDialog'

const DEFAULTS = { page: 1, page_size: 25, search: '', product_id: '', warehouse_id: '', date_from: '', date_to: '', sort: '-sold_at' }

export default function SalesPage() {
  const { can } = useAuth()
  const [f, setF] = useUrlState(DEFAULTS)
  const products = useAllProducts()
  const warehouses = useAllWarehouses()
  const [recording, setRecording] = useState(false)
  const [importing, setImporting] = useState(false)

  const query = {
    page: f.page,
    page_size: f.page_size,
    search: f.search,
    product_id: f.product_id,
    warehouse_id: f.warehouse_id,
    date_from: f.date_from,
    date_to: f.date_to,
    sort: f.sort,
  }
  const q = usePaged<Sale>(qk.sales(query), '/sales', query)
  const canRecord = can('record_sales')
  const canImport = can('import_sales')

  const columns: Column<Sale>[] = [
    {
      key: 'sold_at',
      header: 'Sold',
      sortKey: 'sold_at',
      cell: (s) => (
        <div className="whitespace-nowrap">
          <p className="tabular">{fmt.date(s.sold_at)}</p>
          <p className="text-xs text-muted-foreground tabular">
            {new Date(s.sold_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </p>
          <p className="font-mono text-xs text-muted-foreground sm:hidden">{s.order_reference}</p>
        </div>
      ),
    },
    { key: 'ref', header: 'Order', hideBelow: 'sm', cell: (s) => <span className="whitespace-nowrap font-mono text-xs">{s.order_reference}</span> },
    {
      key: 'product',
      header: 'Product',
      sortKey: 'sku',
      cell: (s) => (
        <div className="min-w-0 max-w-[8.5rem] sm:max-w-[16rem]">
          <Link to={`/products/${s.product_id}`} className="block truncate font-medium hover:underline">
            {s.product_name}
          </Link>
          <span className="font-mono text-xs text-muted-foreground">{s.sku}</span>
        </div>
      ),
    },
    { key: 'wh', header: 'Warehouse', hideBelow: 'md', cell: (s) => <span className="whitespace-nowrap">{s.warehouse_code}</span> },
    { key: 'qty', header: 'Qty', sortKey: 'quantity', align: 'right', cell: (s) => <span className="font-medium tabular">{fmt.int(s.quantity)}</span> },
    { key: 'price', header: 'Unit price', align: 'right', hideBelow: 'xl', cell: (s) => <span className="tabular text-muted-foreground">{fmt.money(s.unit_price)}</span> },
    { key: 'revenue', header: 'Revenue', sortKey: 'revenue', align: 'right', hideBelow: 'sm', cell: (s) => <span className="font-medium tabular">{fmt.money(s.revenue)}</span> },
  ]

  const filtersActive = f.search || f.product_id || f.warehouse_id || f.date_from || f.date_to
  const clear = () => setF({ search: '', product_id: '', warehouse_id: '', date_from: '', date_to: '' })

  return (
    <>
      <PageHeader
        title="Sales"
        description="Order history that drives demand forecasts and replenishment."
        actions={
          <>
            {canImport && (
              <Button variant="outline" onClick={() => setImporting(true)}>
                <FileUp /> Import CSV
              </Button>
            )}
            {canRecord && (
              <Button onClick={() => setRecording(true)}>
                <Plus /> Record sale
              </Button>
            )}
          </>
        }
      />
      <Card>
        <div className="flex flex-col gap-2 border-b p-4 lg:flex-row lg:flex-wrap lg:items-center">
          <SearchInput value={f.search} onChange={(v) => setF({ search: v })} placeholder="Search order, SKU or product…" />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex">
            <NativeSelect aria-label="Product" className="lg:w-56" value={f.product_id} onChange={(e) => setF({ product_id: e.target.value })}>
              <option value="">All products</option>
              {products.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect aria-label="Warehouse" className="lg:w-40" value={f.warehouse_id} onChange={(e) => setF({ warehouse_id: e.target.value })}>
              <option value="">All warehouses</option>
              {warehouses.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code}
                </option>
              ))}
            </NativeSelect>
          </div>
          <DateRangeFilter from={f.date_from} to={f.date_to} onChange={(p) => setF(p)} labelPrefix="Sold" />
          {filtersActive && (
            <Button variant="ghost" size="sm" className="self-start lg:ml-auto lg:self-auto" onClick={clear}>
              <SlidersHorizontal /> Clear filters
            </Button>
          )}
        </div>
        <DataTable
          caption="Sales"
          columns={columns}
          rows={q.data?.items}
          rowKey={(s) => s.id}
          loading={q.isFetching}
          error={q.error}
          onRetry={() => q.refetch()}
          sort={f.sort}
          onSortChange={(sort) => setF({ sort })}
          empty={
            <EmptyState
              icon={<Receipt className="size-6" aria-hidden />}
              title={filtersActive ? 'No matching sales' : 'No sales recorded yet'}
              description={filtersActive ? 'Try a wider date range or clear the filters.' : 'Record a sale or import your order history from a CSV file.'}
              action={
                filtersActive ? (
                  <Button variant="outline" onClick={clear}>
                    Clear filters
                  </Button>
                ) : canImport ? (
                  <Button onClick={() => setImporting(true)}>
                    <FileUp /> Import CSV
                  </Button>
                ) : undefined
              }
            />
          }
          page={f.page}
          pageSize={f.page_size}
          total={q.data?.total}
          onPageChange={(page) => setF({ page }, { resetPage: false })}
          onPageSizeChange={(page_size) => setF({ page_size })}
        />
      </Card>
      <RecordSaleDialog open={recording} onOpenChange={setRecording} />
      <ImportSalesDialog open={importing} onOpenChange={setImporting} />
    </>
  )
}
