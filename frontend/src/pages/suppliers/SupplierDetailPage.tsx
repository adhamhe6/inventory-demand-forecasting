import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Building2, CalendarClock, ClipboardList, Clock, DollarSign, FilePlus2, Mail, MapPin, Package, Pencil, Phone, Receipt, User } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { qk, usePaged } from '@/api/queries'
import { type Column, DataTable } from '@/components/common/DataTable'
import { KpiCard } from '@/components/common/KpiCard'
import { CardsSkeleton, EmptyState, ErrorState } from '@/components/common/States'
import { ActiveBadge, POStatusBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError, api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { POStatus, Product, PurchaseOrderSummary, SupplierDetail } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { SupplierFormDialog } from './SupplierFormDialog'

export default function SupplierDetailPage() {
  const { id: rawId } = useParams()
  const id = Number(rawId)
  const validId = Number.isInteger(id) && id > 0
  const { can } = useAuth()
  const [editOpen, setEditOpen] = useState(false)

  const q = useQuery({
    queryKey: qk.supplier(id),
    queryFn: ({ signal }) => api.get<SupplierDetail>(`/suppliers/${id}`, undefined, signal),
    enabled: validId,
    retry: (count, e) => !(e instanceof ApiError && e.status === 404) && count < 2,
  })

  if (!validId || (q.error instanceof ApiError && q.error.status === 404)) {
    return (
      <Card className="mx-auto mt-8 max-w-lg">
        <EmptyState
          icon={<Building2 className="size-6" />}
          title="Supplier not found"
          description={`We couldn't find a supplier with ID “${rawId}”. The link may be incorrect.`}
          action={
            <Button asChild>
              <Link to="/suppliers">
                <ArrowLeft /> Back to suppliers
              </Link>
            </Button>
          }
        />
      </Card>
    )
  }
  if (q.error) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    )
  }

  const s = q.data
  const st = s?.stats
  const active = s?.status === 'ACTIVE'
  const leadDelta = st?.avg_actual_lead_time_days != null && s ? st.avg_actual_lead_time_days - s.lead_time_days : null
  const onTimeTone = st?.on_time_rate == null ? 'default' : st.on_time_rate >= 0.9 ? 'success' : st.on_time_rate >= 0.7 ? 'warning' : 'danger'

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link to="/suppliers" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Suppliers
        </Link>
      </nav>

      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        {s ? (
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <ActiveBadge active={active} />
              {s.payment_terms && <span className="text-xs text-muted-foreground">{s.payment_terms}</span>}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">{s.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">Supplier since {fmt.date(s.created_at)}</p>
          </div>
        ) : (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-72" />
          </div>
        )}
        {s && (
          <div className="flex flex-wrap items-center gap-2">
            {can('manage_suppliers') && (
              <Button variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {can('manage_purchase_orders') &&
              (active ? (
                <Button asChild>
                  <Link to={`/purchase-orders/new?supplier_id=${s.id}`}>
                    <FilePlus2 /> New purchase order
                  </Link>
                </Button>
              ) : (
                <Button disabled title="Reactivate this supplier to raise purchase orders">
                  <FilePlus2 /> New purchase order
                </Button>
              ))}
          </div>
        )}
      </div>

      {!st ? (
        <CardsSkeleton count={4} />
      ) : (
        <section aria-label="Supplier performance" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <KpiCard label="Purchase orders" value={fmt.int(st.total_purchase_orders)} hint={`${fmt.int(st.open_purchase_orders)} open`} icon={<ClipboardList />} />
          <KpiCard label="Total spend" value={fmt.moneyCompact(st.total_spend)} hint={`${fmt.money(st.total_spend)} excl. cancelled`} icon={<DollarSign />} />
          <KpiCard
            label="On-time delivery"
            value={fmt.pct(st.on_time_rate, 0)}
            hint={st.on_time_rate == null ? 'No received orders yet' : 'Received on or before expected date'}
            icon={<CalendarClock />}
            tone={onTimeTone}
          />
          <KpiCard
            label="Avg. actual lead time"
            value={st.avg_actual_lead_time_days == null ? '—' : `${fmt.num(st.avg_actual_lead_time_days)} days`}
            hint={
              <span>
                Promised {s!.lead_time_days} days
                {leadDelta != null && Math.abs(leadDelta) >= 0.1 && (
                  <span className={cn('ml-1 font-medium', leadDelta > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600')}>
                    ({leadDelta > 0 ? '+' : ''}
                    {fmt.num(leadDelta)} d)
                  </span>
                )}
              </span>
            }
            icon={<Clock />}
            tone={leadDelta != null && leadDelta > 1 ? 'warning' : 'default'}
          />
          <KpiCard label="Products supplied" value={fmt.int(st.product_count)} hint="Preferred supplier for" icon={<Package />} />
        </section>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Contact</CardTitle>
            <CardDescription>How to reach this supplier</CardDescription>
          </CardHeader>
          <CardContent>
            {!s ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <dl className="grid gap-4 text-sm">
                <ContactRow icon={<User />} label="Contact person" value={s.contact_name} />
                <ContactRow
                  icon={<Mail />}
                  label="Email"
                  value={
                    s.email && (
                      <a href={`mailto:${s.email}`} className="break-all text-primary hover:underline">
                        {s.email}
                      </a>
                    )
                  }
                />
                <ContactRow
                  icon={<Phone />}
                  label="Phone"
                  value={
                    s.phone && (
                      <a href={`tel:${s.phone.replace(/\s/g, '')}`} className="text-primary hover:underline">
                        {s.phone}
                      </a>
                    )
                  }
                />
                <ContactRow icon={<MapPin />} label="Address" value={s.address && <span className="whitespace-pre-line">{s.address}</span>} />
                <ContactRow icon={<Receipt />} label="Payment terms" value={s.payment_terms} />
                <ContactRow icon={<Clock />} label="Promised lead time" value={`${s.lead_time_days} days`} />
              </dl>
            )}
          </CardContent>
        </Card>
        <div className="xl:col-span-2">{validId && <SupplierProducts supplierId={id} />}</div>
      </div>

      <div className="mt-6">{validId && <SupplierPurchaseOrders supplierId={id} />}</div>

      <SupplierFormDialog open={editOpen} onOpenChange={setEditOpen} supplier={s ?? null} />
    </>
  )
}

function ContactRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="mt-0.5 font-medium">{value || <span className="font-normal text-muted-foreground">Not provided</span>}</dd>
      </div>
    </div>
  )
}

function SupplierProducts({ supplierId }: { supplierId: number }) {
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState('sku')
  const query = { supplier_id: supplierId, page, page_size: 10, sort }
  const q = usePaged<Product>(qk.products(query), '/products', query)
  const columns: Column<Product>[] = [
    {
      key: 'sku',
      header: 'SKU',
      sortKey: 'sku',
      cell: (p) => (
        <Link to={`/products/${p.id}`} onClick={(e) => e.stopPropagation()} className="whitespace-nowrap font-mono text-xs font-medium text-primary hover:underline">
          {p.sku}
        </Link>
      ),
    },
    { key: 'name', header: 'Product', sortKey: 'name', cell: (p) => <span className="block max-w-[16rem] truncate">{p.name}</span> },
    { key: 'category', header: 'Category', hideBelow: 'lg', cell: (p) => <span className="text-muted-foreground">{p.category}</span> },
    { key: 'cost', header: 'Cost', sortKey: 'cost', align: 'right', hideBelow: 'sm', cell: (p) => <span className="tabular">{fmt.money(p.cost)}</span> },
    { key: 'status', header: 'Status', hideBelow: 'md', cell: (p) => <ActiveBadge active={p.is_active} /> },
  ]
  return (
    <Card className="h-full">
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="grid gap-1">
          <CardTitle>Products</CardTitle>
          <CardDescription>{q.data ? `${fmt.int(q.data.total)} products use this preferred supplier` : 'Products using this preferred supplier'}</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/products?supplier_id=${supplierId}`}>View in catalog</Link>
        </Button>
      </CardHeader>
      <DataTable
        caption="Products from this supplier"
        columns={columns}
        rows={q.data?.items}
        rowKey={(p) => p.id}
        loading={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        sort={sort}
        onSortChange={(v) => {
          setSort(v)
          setPage(1)
        }}
        onRowClick={(p) => navigate(`/products/${p.id}`)}
        empty={<EmptyState title="No products linked" description="Set this supplier as the preferred supplier on a product to see it here." />}
        page={page}
        pageSize={10}
        total={q.data?.total}
        onPageChange={setPage}
      />
    </Card>
  )
}

const PO_STATUSES: POStatus[] = ['DRAFT', 'SUBMITTED', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']

function SupplierPurchaseOrders({ supplierId }: { supplierId: number }) {
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState('-order_date')
  const query = { supplier_id: supplierId, status, page, page_size: pageSize, sort }
  const q = usePaged<PurchaseOrderSummary>(qk.purchaseOrders(query), '/purchase-orders', query)
  const columns: Column<PurchaseOrderSummary>[] = [
    {
      key: 'po',
      header: 'PO',
      sortKey: 'po_number',
      cell: (o) => (
        <Link to={`/purchase-orders/${o.id}`} onClick={(e) => e.stopPropagation()} className="whitespace-nowrap font-mono text-xs font-medium text-primary hover:underline">
          {o.po_number}
        </Link>
      ),
    },
    { key: 'status', header: 'Status', sortKey: 'status', cell: (o) => <POStatusBadge status={o.status} /> },
    { key: 'wh', header: 'Warehouse', hideBelow: 'sm', cell: (o) => o.warehouse_code },
    { key: 'ordered', header: 'Ordered', sortKey: 'order_date', hideBelow: 'md', cell: (o) => <span className="whitespace-nowrap text-muted-foreground">{fmt.date(o.order_date)}</span> },
    {
      key: 'expected',
      header: 'Expected',
      sortKey: 'expected_delivery_date',
      hideBelow: 'lg',
      cell: (o) => <span className="whitespace-nowrap text-muted-foreground">{fmt.date(o.expected_delivery_date)}</span>,
    },
    {
      key: 'received',
      header: 'Received',
      hideBelow: 'xl',
      cell: (o) => (
        <span className="whitespace-nowrap tabular text-muted-foreground">
          {fmt.int(o.received_units)} / {fmt.int(o.total_units)}
          {o.received_date ? ` · ${fmt.shortDate(o.received_date)}` : ''}
        </span>
      ),
    },
    { key: 'total', header: 'Total', sortKey: 'total_amount', align: 'right', cell: (o) => <span className="font-medium tabular">{fmt.money(o.total_amount)}</span> },
  ]
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1">
          <CardTitle>Purchase orders</CardTitle>
          <CardDescription>{q.data ? `${fmt.int(q.data.total)} orders${status ? ' with this status' : ''}` : 'All orders with this supplier'}</CardDescription>
        </div>
        <NativeSelect
          aria-label="Purchase order status"
          className="sm:w-48"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(1)
          }}
        >
          <option value="">All statuses</option>
          {PO_STATUSES.map((st) => (
            <option key={st} value={st}>
              {fmt.label(st)}
            </option>
          ))}
        </NativeSelect>
      </CardHeader>
      <DataTable
        caption="Purchase orders with this supplier"
        columns={columns}
        rows={q.data?.items}
        rowKey={(o) => o.id}
        loading={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        sort={sort}
        onSortChange={(v) => {
          setSort(v)
          setPage(1)
        }}
        onRowClick={(o) => navigate(`/purchase-orders/${o.id}`)}
        empty={<EmptyState title={status ? 'No orders with this status' : 'No purchase orders yet'} description="Purchase orders raised with this supplier will appear here." />}
        page={page}
        pageSize={pageSize}
        total={q.data?.total}
        onPageChange={setPage}
        onPageSizeChange={(v) => {
          setPageSize(v)
          setPage(1)
        }}
      />
    </Card>
  )
}
