import { Eye, MoreHorizontal, Pencil, Plus, Power, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { qk, useAllSuppliers, useCategories, usePaged } from '@/api/queries'
import { type Column, DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { SearchInput } from '@/components/common/SearchInput'
import { EmptyState } from '@/components/common/States'
import { ActiveBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NativeSelect } from '@/components/ui/input'
import { useAuth } from '@/lib/auth'
import { useUrlState } from '@/lib/hooks'
import type { Product } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { marginOf } from './formUtils'
import { ProductFormDialog } from './ProductFormDialog'
import { useProductLifecycle } from './useProductLifecycle'
import { LookupError, LookupFailedOption } from '../shared/LookupError'

const DEFAULTS = { page: 1, page_size: 25, search: '', category: '', supplier_id: '', is_active: '', sort: 'sku' }

export default function ProductsPage() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const [f, setF] = useUrlState(DEFAULTS)
  const categories = useCategories()
  const suppliers = useAllSuppliers()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const lifecycle = useProductLifecycle()

  const query = {
    page: f.page,
    page_size: f.page_size,
    search: f.search,
    category: f.category,
    supplier_id: f.supplier_id,
    is_active: f.is_active,
    sort: f.sort,
  }
  const q = usePaged<Product>(qk.products(query), '/products', query)
  const canManage = can('manage_products')
  const canDelete = can('delete_products')

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (p: Product) => {
    setEditing(p)
    setFormOpen(true)
  }

  const columns: Column<Product>[] = [
    {
      key: 'sku',
      header: 'SKU',
      sortKey: 'sku',
      cell: (p) => (
        <Link to={`/products/${p.id}`} onClick={(e) => e.stopPropagation()} className="block whitespace-nowrap font-mono text-xs font-medium text-primary hover:underline">
          {p.sku}
          <span className={cn('mt-0.5 block max-w-[11rem] truncate font-sans text-sm font-medium text-foreground sm:hidden', !p.is_active && 'text-muted-foreground')}>
            {p.name}
          </span>
        </Link>
      ),
    },
    {
      key: 'name',
      header: 'Product',
      sortKey: 'name',
      hideBelow: 'sm',
      cell: (p) => (
        <div className="min-w-0 max-w-[16rem]">
          <p className={cn('truncate font-medium', !p.is_active && 'text-muted-foreground')}>{p.name}</p>
          <p className="truncate text-xs text-muted-foreground md:hidden">{p.category}</p>
        </div>
      ),
    },
    { key: 'category', header: 'Category', sortKey: 'category', hideBelow: 'md', cell: (p) => <span className="whitespace-nowrap text-muted-foreground">{p.category}</span> },
    {
      key: 'supplier',
      header: 'Supplier',
      hideBelow: 'lg',
      cell: (p) =>
        p.supplier ? (
          <Link
            to={`/suppliers/${p.supplier.id}`}
            onClick={(e) => e.stopPropagation()}
            className="block max-w-[12rem] truncate hover:text-primary hover:underline"
          >
            {p.supplier.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { key: 'cost', header: 'Cost', sortKey: 'cost', align: 'right', hideBelow: 'md', cell: (p) => <span className="tabular text-muted-foreground">{fmt.money(p.cost)}</span> },
    { key: 'price', header: 'Price', sortKey: 'price', align: 'right', cell: (p) => <span className="font-medium tabular">{fmt.money(p.price)}</span> },
    {
      key: 'margin',
      header: 'Margin',
      align: 'right',
      hideBelow: 'xl',
      cell: (p) => {
        const m = marginOf(p)
        return <span className={cn('tabular', m != null && m < 0 ? 'text-destructive' : 'text-muted-foreground')}>{fmt.pct(m)}</span>
      },
    },
    {
      key: 'rop',
      header: 'Reorder pt.',
      align: 'right',
      hideBelow: '2xl',
      cell: (p) => <span className="tabular text-muted-foreground">{fmt.int(p.reorder_point)}</span>,
    },
    {
      key: 'lead',
      header: 'Lead time',
      align: 'right',
      hideBelow: '2xl',
      cell: (p) => <span className="whitespace-nowrap tabular text-muted-foreground">{p.supplier?.lead_time_days ?? p.lead_time_days} d</span>,
    },
    { key: 'status', header: 'Status', hideBelow: 'sm', cell: (p) => <ActiveBadge active={p.is_active} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (p) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.sku}`} onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={() => navigate(`/products/${p.id}`)}>
              <Eye /> View details
            </DropdownMenuItem>
            {canManage && (
              <>
                <DropdownMenuItem onSelect={() => openEdit(p)}>
                  <Pencil /> Edit
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => (p.is_active ? lifecycle.requestDeactivate(p) : lifecycle.reactivate(p))}>
                  <Power /> {p.is_active ? 'Deactivate' : 'Reactivate'}
                </DropdownMenuItem>
              </>
            )}
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => lifecycle.requestDelete(p)}>
                  <Trash2 /> Delete…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ]

  const filtersActive = f.search || f.category || f.supplier_id || f.is_active

  return (
    <>
      <PageHeader
        title="Products"
        description={q.data ? `${fmt.int(q.data.total)} ${filtersActive ? 'matching' : 'catalog'} products · pricing, suppliers and replenishment settings` : 'Catalog items, pricing, suppliers and replenishment settings.'}
        actions={
          canManage && (
            <Button onClick={openCreate}>
              <Plus /> New product
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center">
          <SearchInput value={f.search} onChange={(v) => setF({ search: v })} placeholder="Search SKU, name or category…" className="lg:w-72" />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:flex">
            <NativeSelect aria-label="Category" className="lg:w-44" value={f.category} onChange={(e) => setF({ category: e.target.value })}>
              <option value="">All categories</option>
              <LookupFailedOption query={categories} />
              {categories.data?.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect aria-label="Supplier" className="lg:w-52" value={f.supplier_id} onChange={(e) => setF({ supplier_id: e.target.value })}>
              <option value="">All suppliers</option>
              <LookupFailedOption query={suppliers} />
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect aria-label="Status" className="lg:w-36" value={f.is_active} onChange={(e) => setF({ is_active: e.target.value })}>
              <option value="">All statuses</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </NativeSelect>
          </div>
          <LookupError lookups={{ categories, suppliers }} />
          {filtersActive && (
            <Button variant="ghost" size="sm" className="lg:ml-auto" onClick={() => setF({ search: '', category: '', supplier_id: '', is_active: '' })}>
              <SlidersHorizontal /> Clear filters
            </Button>
          )}
        </div>
        <DataTable
          caption="Products"
          columns={columns}
          rows={q.data?.items}
          rowKey={(p) => p.id}
          loading={q.isFetching}
          error={q.error}
          onRetry={() => q.refetch()}
          sort={f.sort}
          onSortChange={(sort) => setF({ sort })}
          onRowClick={(p) => navigate(`/products/${p.id}`)}
          empty={
            <EmptyState
              title={filtersActive ? 'No matching products' : 'No products yet'}
              description={filtersActive ? 'Try a different search or clear the filters.' : 'Create your first product to start tracking stock and demand.'}
              action={
                filtersActive ? (
                  <Button variant="outline" onClick={() => setF({ search: '', category: '', supplier_id: '', is_active: '' })}>
                    Clear filters
                  </Button>
                ) : canManage ? (
                  <Button onClick={openCreate}>
                    <Plus /> New product
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

      <ProductFormDialog open={formOpen} onOpenChange={setFormOpen} product={editing} onSaved={(p) => !editing && navigate(`/products/${p.id}`)} />
      {lifecycle.dialogs}
    </>
  )
}
