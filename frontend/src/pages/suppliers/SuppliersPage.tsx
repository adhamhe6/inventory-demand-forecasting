import { Eye, Mail, MoreHorizontal, Pencil, Phone, Plus, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { qk, usePaged } from '@/api/queries'
import { type Column, DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { SearchInput } from '@/components/common/SearchInput'
import { EmptyState } from '@/components/common/States'
import { ActiveBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NativeSelect } from '@/components/ui/input'
import { useAuth } from '@/lib/auth'
import { useUrlState } from '@/lib/hooks'
import type { Supplier } from '@/lib/types'
import { fmt } from '@/lib/utils'
import { SupplierFormDialog } from './SupplierFormDialog'

const DEFAULTS = { page: 1, page_size: 25, search: '', status: '', sort: 'name' }

export default function SuppliersPage() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const canManage = can('manage_suppliers')
  const [f, setF] = useUrlState(DEFAULTS)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const query = { page: f.page, page_size: f.page_size, search: f.search, status: f.status, sort: f.sort }
  const q = usePaged<Supplier>(qk.suppliers(query), '/suppliers', query)

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (s: Supplier) => {
    setEditing(s)
    setFormOpen(true)
  }

  const columns: Column<Supplier>[] = [
    {
      key: 'name',
      header: 'Supplier',
      sortKey: 'name',
      cell: (s) => (
        <div className="min-w-0 max-w-[18rem]">
          <Link to={`/suppliers/${s.id}`} onClick={(e) => e.stopPropagation()} className="block truncate font-medium hover:text-primary hover:underline">
            {s.name}
          </Link>
          <p className="truncate text-xs text-muted-foreground">{s.contact_name ?? 'No contact person'}</p>
        </div>
      ),
    },
    {
      key: 'email',
      header: 'Email',
      hideBelow: 'md',
      cell: (s) =>
        s.email ? (
          <a href={`mailto:${s.email}`} onClick={(e) => e.stopPropagation()} className="inline-flex max-w-[16rem] items-center gap-1.5 truncate hover:text-primary hover:underline">
            <Mail className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{s.email}</span>
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'phone',
      header: 'Phone',
      hideBelow: 'xl',
      cell: (s) =>
        s.phone ? (
          <a href={`tel:${s.phone.replace(/\s/g, '')}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 whitespace-nowrap hover:text-primary hover:underline">
            <Phone className="size-3.5 text-muted-foreground" aria-hidden />
            {s.phone}
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { key: 'terms', header: 'Terms', hideBelow: 'lg', cell: (s) => <span className="whitespace-nowrap text-muted-foreground">{s.payment_terms ?? '—'}</span> },
    {
      key: 'lead',
      header: 'Lead time',
      sortKey: 'lead_time_days',
      align: 'right',
      cell: (s) => (
        <span className="whitespace-nowrap tabular">
          {s.lead_time_days} <span className="text-muted-foreground">days</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', hideBelow: 'sm', cell: (s) => <ActiveBadge active={s.status === 'ACTIVE'} /> },
    {
      key: 'created',
      header: 'Added',
      sortKey: 'created_at',
      hideBelow: '2xl',
      cell: (s) => <span className="whitespace-nowrap text-muted-foreground">{fmt.date(s.created_at)}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (s) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${s.name}`} onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={() => navigate(`/suppliers/${s.id}`)}>
              <Eye /> View details
            </DropdownMenuItem>
            {canManage && (
              <DropdownMenuItem onSelect={() => openEdit(s)}>
                <Pencil /> Edit
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ]

  const filtersActive = f.search || f.status

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Vendors, contact details, payment terms and promised lead times."
        actions={
          canManage && (
            <Button onClick={openCreate}>
              <Plus /> New supplier
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
          <SearchInput value={f.search} onChange={(v) => setF({ search: v })} placeholder="Search name, contact or email…" className="sm:w-72" />
          <NativeSelect aria-label="Status" className="sm:w-40" value={f.status} onChange={(e) => setF({ status: e.target.value })}>
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </NativeSelect>
          {filtersActive && (
            <Button variant="ghost" size="sm" className="sm:ml-auto" onClick={() => setF({ search: '', status: '' })}>
              <SlidersHorizontal /> Clear filters
            </Button>
          )}
        </div>
        <DataTable
          caption="Suppliers"
          columns={columns}
          rows={q.data?.items}
          rowKey={(s) => s.id}
          loading={q.isFetching}
          error={q.error}
          onRetry={() => q.refetch()}
          sort={f.sort}
          onSortChange={(sort) => setF({ sort })}
          onRowClick={(s) => navigate(`/suppliers/${s.id}`)}
          empty={
            <EmptyState
              title={filtersActive ? 'No matching suppliers' : 'No suppliers yet'}
              description={filtersActive ? 'Try a different search or status.' : 'Add the vendors you buy from to raise purchase orders and plan lead times.'}
              action={
                filtersActive ? (
                  <Button variant="outline" onClick={() => setF({ search: '', status: '' })}>
                    Clear filters
                  </Button>
                ) : canManage ? (
                  <Button onClick={openCreate}>
                    <Plus /> New supplier
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
      <SupplierFormDialog open={formOpen} onOpenChange={setFormOpen} supplier={editing} onSaved={(s) => !editing && navigate(`/suppliers/${s.id}`)} />
    </>
  )
}
