import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Building2, CalendarClock, FileText, Lock, Warehouse as WarehouseIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { useAllProducts, useAllSuppliers, useAllWarehouses } from '@/api/queries'
import { Field } from '@/components/common/Field'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, InlineError } from '@/components/common/States'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, NativeSelect, Textarea } from '@/components/ui/input'
import { ApiError, api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { PurchaseOrder } from '@/lib/types'
import { fmt } from '@/lib/utils'
import { LineItemsEditor } from './LineItemsEditor'
import { emptyLine, lineTotal, poBusinessErrorField, type POFormValues, poSchema, renamePoField, toApiLines } from './poForm'
import { addDaysIso, applyServerErrors, PO_RELATED_KEYS, todayIso } from './utils'

export default function PurchaseOrderCreatePage() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const suppliers = useAllSuppliers()
  const warehouses = useAllWarehouses()
  const products = useAllProducts()
  const [reviewing, setReviewing] = useState(false)
  const today = todayIso()
  const schema = useMemo(() => poSchema(today), [today])

  const activeSuppliers = useMemo(() => suppliers.data?.filter((s) => s.status === 'ACTIVE') ?? [], [suppliers.data])
  const activeWarehouses = useMemo(() => warehouses.data?.filter((w) => w.status === 'ACTIVE') ?? [], [warehouses.data])

  const form = useForm<POFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      supplier_id: (Number(params.get('supplier_id')) || '') as unknown as number,
      warehouse_id: (Number(params.get('warehouse_id')) || '') as unknown as number,
      expected_delivery_date: '',
      notes: '',
      lines: [emptyLine()],
    },
  })
  const { register, handleSubmit, setValue, setError, formState, control, getValues } = form
  const errors = formState.errors
  const supplierId = Number(useWatch({ control, name: 'supplier_id' })) || null
  const warehouseId = Number(useWatch({ control, name: 'warehouse_id' })) || null
  const expected = useWatch({ control, name: 'expected_delivery_date' })
  const lines = useWatch({ control, name: 'lines' }) ?? []
  const supplier = activeSuppliers.find((s) => s.id === supplierId)
  const warehouse = activeWarehouses.find((w) => w.id === warehouseId)

  // Default the expected date to today + supplier lead time until the user picks a date themselves.
  const [dateTouched, setDateTouched] = useState(false)
  useEffect(() => {
    if (supplier && !dateTouched) setValue('expected_delivery_date', addDaysIso(supplier.lead_time_days), { shouldValidate: formState.isSubmitted })
  }, [supplier, dateTouched, setValue, formState.isSubmitted])

  // Native selects can't show a pre-filled value until their options exist: re-apply it once loaded.
  useEffect(() => {
    const id = Number(getValues('supplier_id'))
    if (id && activeSuppliers.length) setValue('supplier_id', activeSuppliers.some((s) => s.id === id) ? id : ('' as unknown as number))
  }, [activeSuppliers, getValues, setValue])
  useEffect(() => {
    if (!activeWarehouses.length) return
    const id = Number(getValues('warehouse_id'))
    // Pre-select the only active warehouse to save a click.
    if (!id && activeWarehouses.length === 1) setValue('warehouse_id', activeWarehouses[0].id)
    else if (id) setValue('warehouse_id', activeWarehouses.some((w) => w.id === id) ? id : ('' as unknown as number))
  }, [activeWarehouses, getValues, setValue])

  const validLines = lines.filter((l) => Number(l?.product_id) > 0)
  const total = lines.reduce((sum, l) => sum + lineTotal(l?.quantity, l?.unit_cost), 0)
  const units = lines.reduce((sum, l) => sum + (Number(l?.quantity) > 0 ? Number(l.quantity) : 0), 0)

  const create = useMutation({
    mutationFn: (v: POFormValues) =>
      api.post<PurchaseOrder>('/purchase-orders', {
        supplier_id: Number(v.supplier_id),
        warehouse_id: Number(v.warehouse_id),
        expected_delivery_date: v.expected_delivery_date,
        notes: v.notes?.trim() || null,
        lines: toApiLines(v.lines),
      }),
    onSuccess: (po) => {
      PO_RELATED_KEYS.forEach((key) => qc.invalidateQueries({ queryKey: key }))
      toast.success(`Purchase order ${po.po_number} created`, { description: `Draft · ${po.line_count} line(s) · ${fmt.money(po.total_amount)}` })
      navigate(`/purchase-orders/${po.id}`)
    },
    onError: (e) => {
      setReviewing(false)
      applyServerErrors(e, setError, renamePoField)
      const field = poBusinessErrorField(e)
      if (field && e instanceof ApiError) setError(field, { type: 'server', message: e.message })
    },
  })

  if (!can('manage_purchase_orders')) {
    return (
      <EmptyState
        icon={<Lock className="size-6" aria-hidden />}
        title="You can't create purchase orders"
        description="Your role doesn't include purchasing. Ask an administrator or purchasing manager."
        action={
          <Button variant="outline" asChild>
            <Link to="/purchase-orders">Back to purchase orders</Link>
          </Button>
        }
      />
    )
  }

  const generalError =
    create.error && !(create.error instanceof ApiError && (Object.keys(create.error.fieldErrors).length || poBusinessErrorField(create.error))) ? create.error : null

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2 text-muted-foreground">
        <Link to="/purchase-orders">
          <ArrowLeft /> Purchase orders
        </Link>
      </Button>
      <PageHeader title="New purchase order" description="Build a draft order. You can review and submit it to the supplier afterwards." />

      <form onSubmit={handleSubmit(() => setReviewing(true))} noValidate className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 gap-4">
          <InlineError error={generalError} />
          <Card>
            <CardHeader>
              <CardTitle>Order details</CardTitle>
              <CardDescription>Who you're buying from and where the goods should arrive.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field id="po-supplier" label="Supplier" error={errors.supplier_id?.message} required>
                <NativeSelect id="po-supplier" aria-invalid={!!errors.supplier_id} disabled={suppliers.isLoading} {...register('supplier_id')}>
                  <option value="">{suppliers.isLoading ? 'Loading suppliers…' : 'Select a supplier'}</option>
                  {activeSuppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field id="po-warehouse" label="Deliver to warehouse" error={errors.warehouse_id?.message} required>
                <NativeSelect id="po-warehouse" aria-invalid={!!errors.warehouse_id} disabled={warehouses.isLoading} {...register('warehouse_id')}>
                  <option value="">{warehouses.isLoading ? 'Loading warehouses…' : 'Select a warehouse'}</option>
                  {activeWarehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {supplier && (
                <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/30 p-3 text-sm sm:col-span-2 sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">Lead time</dt>
                    <dd className="font-medium">{supplier.lead_time_days} days</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Payment terms</dt>
                    <dd className="font-medium">{supplier.payment_terms || '—'}</dd>
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <dt className="text-xs text-muted-foreground">Contact</dt>
                    <dd className="truncate font-medium">{supplier.contact_name || supplier.email || '—'}</dd>
                  </div>
                </dl>
              )}
              <Field
                id="po-expected"
                label="Expected delivery"
                error={errors.expected_delivery_date?.message}
                hint={supplier ? `Defaults to today + ${supplier.lead_time_days}-day lead time` : 'Pick a supplier to use its lead time'}
                required
              >
                <Input
                  id="po-expected"
                  type="date"
                  min={today}
                  aria-invalid={!!errors.expected_delivery_date}
                  {...register('expected_delivery_date', { onChange: () => setDateTouched(true) })}
                />
              </Field>
              <Field id="po-notes" label="Notes" error={errors.notes?.message} hint="Visible on the order, e.g. delivery instructions" className="sm:col-span-2">
                <Textarea id="po-notes" rows={2} aria-invalid={!!errors.notes} {...register('notes')} />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Line items</CardTitle>
              <CardDescription>
                {supplier ? `Products usually bought from ${supplier.name} are listed first.` : 'Select products, quantities and agreed unit costs.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LineItemsEditor form={form} products={products.data} productsLoading={products.isLoading} supplierId={supplierId} supplierName={supplier?.name} />
            </CardContent>
          </Card>
        </div>

        <Card className="lg:sticky lg:top-20">
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <ul className="grid gap-2.5 text-sm">
              <li className="flex items-start gap-2">
                <Building2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 truncate">{supplier?.name ?? <span className="text-muted-foreground">No supplier selected</span>}</span>
              </li>
              <li className="flex items-start gap-2">
                <WarehouseIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 truncate">{warehouse ? `${warehouse.code} — ${warehouse.name}` : <span className="text-muted-foreground">No warehouse selected</span>}</span>
              </li>
              <li className="flex items-start gap-2">
                <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span>{expected ? `Expected ${fmt.date(expected)}` : <span className="text-muted-foreground">No delivery date</span>}</span>
              </li>
              <li className="flex items-start gap-2">
                <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  {validLines.length} line{validLines.length === 1 ? '' : 's'} · {fmt.int(units)} units
                </span>
              </li>
            </ul>
            <div className="flex items-baseline justify-between border-t pt-4">
              <span className="text-sm text-muted-foreground">Order total</span>
              <span className="text-2xl font-semibold tabular" aria-live="polite">
                {fmt.money(total)}
              </span>
            </div>
            <Button type="submit" className="w-full" loading={create.isPending}>
              Review & create
            </Button>
            <p className="text-center text-xs text-muted-foreground">The order is saved as a draft — nothing is sent to the supplier yet.</p>
          </CardContent>
        </Card>
      </form>

      <ConfirmDialog
        open={reviewing}
        onOpenChange={(o) => !create.isPending && setReviewing(o)}
        title="Create draft purchase order?"
        confirmLabel="Create draft"
        loading={create.isPending}
        onConfirm={() => create.mutate(getValues())}
        description={
          <div className="grid gap-3">
            <p>
              <strong className="text-foreground">{supplier?.name}</strong> → <strong className="text-foreground">{warehouse?.code}</strong>, expected{' '}
              {fmt.date(expected)}.
            </p>
            <ul className="max-h-48 divide-y overflow-y-auto rounded-md border text-xs">
              {validLines.map((l) => {
                const p = products.data?.find((x) => x.id === Number(l.product_id))
                return (
                  <li key={l.product_id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span className="min-w-0 truncate">
                      <span className="font-mono">{p?.sku}</span> × {fmt.int(l.quantity)}
                    </span>
                    <span className="shrink-0 tabular text-foreground">{fmt.money(lineTotal(l.quantity, l.unit_cost))}</span>
                  </li>
                )
              })}
            </ul>
            <p className="flex justify-between text-sm">
              <span>Total</span>
              <strong className="tabular text-foreground">{fmt.money(total)}</strong>
            </p>
          </div>
        }
      />
    </>
  )
}
