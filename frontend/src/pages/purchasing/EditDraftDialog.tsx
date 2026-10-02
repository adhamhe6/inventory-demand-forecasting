import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import { qk, useAllProducts } from '@/api/queries'
import { Field } from '@/components/common/Field'
import { InlineError } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, Textarea } from '@/components/ui/input'
import { ApiError, api } from '@/lib/api'
import type { Product, PurchaseOrder } from '@/lib/types'
import { fmt } from '@/lib/utils'
import { LookupError } from '../shared/LookupError'
import { LineItemsEditor } from './LineItemsEditor'
import { lineTotal, poBusinessErrorField, type POFormValues, poSchema, renamePoField, toApiLines } from './poForm'
import { applyServerErrors, PO_RELATED_KEYS } from './utils'

/** Edit a DRAFT order's delivery date, notes and lines (PATCH replaces all lines). */
export function EditDraftDialog({ po, open, onOpenChange }: { po: PurchaseOrder; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  // Include inactive products so existing lines that reference one still resolve.
  const products = useAllProducts({ includeInactive: true })
  const lineProducts = useMemo<Product[] | undefined>(() => {
    if (!products.data) return undefined
    const known = new Set(products.data.map((p) => p.id))
    // Anything the catalogue no longer returns is synthesised from the PO line so the row still renders.
    const missing: Product[] = po.lines
      .filter((l) => !known.has(l.product_id))
      .map((l) => ({
        id: l.product_id,
        sku: l.sku,
        name: l.product_name,
        description: null,
        category: '—',
        unit: 'unit',
        cost: l.unit_cost,
        price: l.unit_cost,
        min_stock: 0,
        reorder_point: 0,
        safety_stock: 0,
        lead_time_days: 0,
        is_active: false,
        supplier_id: po.supplier_id,
        supplier: null,
        created_at: po.created_at,
        updated_at: po.created_at,
      }))
    return missing.length ? [...products.data, ...missing] : products.data
  }, [products.data, po])
  const schema = useMemo(() => poSchema(po.order_date, 'Cannot be before the order date'), [po.order_date])
  const form = useForm<POFormValues>({ resolver: zodResolver(schema) })
  const { register, handleSubmit, reset, setError, control, formState } = form
  const errors = formState.errors
  const lines = useWatch({ control, name: 'lines' }) ?? []
  const total = lines.reduce((n, l) => n + lineTotal(l?.quantity, l?.unit_cost), 0)

  useEffect(() => {
    if (open)
      reset({
        supplier_id: po.supplier_id,
        warehouse_id: po.warehouse_id,
        expected_delivery_date: po.expected_delivery_date ?? '',
        notes: po.notes ?? '',
        lines: po.lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity_ordered, unit_cost: Number(l.unit_cost).toFixed(2) })),
      })
    // Reset only when (re)opened so a background refetch doesn't wipe edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const save = useMutation({
    mutationFn: (v: POFormValues) =>
      api.patch<PurchaseOrder>(`/purchase-orders/${po.id}`, {
        expected_delivery_date: v.expected_delivery_date,
        notes: v.notes?.trim() || null,
        lines: toApiLines(v.lines),
      }),
    onSuccess: (updated) => {
      qc.setQueryData(qk.purchaseOrder(po.id), updated)
      PO_RELATED_KEYS.forEach((key) => qc.invalidateQueries({ queryKey: key }))
      toast.success(`${updated.po_number} updated`, { description: `${updated.line_count} line(s) · ${fmt.money(updated.total_amount)}` })
      onOpenChange(false)
    },
    onError: (e) => {
      applyServerErrors(e, setError, renamePoField)
      const field = poBusinessErrorField(e)
      if (field && e instanceof ApiError) setError(field, { type: 'server', message: e.message })
    },
  })

  const generalError =
    save.error && !(save.error instanceof ApiError && (Object.keys(save.error.fieldErrors).length || poBusinessErrorField(save.error))) ? save.error : null

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent size="xl">
        <form onSubmit={handleSubmit((v) => save.mutate(v))} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Edit draft {po.po_number}</DialogTitle>
            <DialogDescription>
              {po.supplier_name} → {po.warehouse_code}. Drafts can be changed freely until they are submitted.
            </DialogDescription>
          </DialogHeader>
          <InlineError error={generalError} />
          <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <Field id="edit-expected" label="Expected delivery" error={errors.expected_delivery_date?.message} required>
              <Input id="edit-expected" type="date" min={po.order_date} aria-invalid={!!errors.expected_delivery_date} {...register('expected_delivery_date')} />
            </Field>
            <Field id="edit-notes" label="Notes" error={errors.notes?.message}>
              <Textarea id="edit-notes" rows={1} className="min-h-9" {...register('notes')} />
            </Field>
          </div>
          <LookupError lookups={{ products }} context="— existing lines still show, but the product list may be incomplete" />
          <LineItemsEditor form={form} products={lineProducts} productsLoading={products.isLoading} supplierId={po.supplier_id} supplierName={po.supplier_name} />
          <DialogFooter className="items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              New total <span className="font-semibold text-foreground tabular">{fmt.money(total)}</span>
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
                Cancel
              </Button>
              <Button type="submit" loading={save.isPending}>
                Save changes
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
