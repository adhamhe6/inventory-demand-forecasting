import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { STOCK_KEYS, useAllProducts, useAllWarehouses } from '@/api/queries'
import { Field } from '@/components/common/Field'
import { InlineError } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, NativeSelect, Textarea } from '@/components/ui/input'
import { ApiError, api, newIdempotencyKey } from '@/lib/api'
import type { InventoryItem, StockOperationResult } from '@/lib/types'
import { fmt } from '@/lib/utils'

export type StockOp = 'receive' | 'issue' | 'adjust' | 'transfer' | 'reserve' | 'release' | 'return'

export const OP_META: Record<StockOp, { title: string; description: string; verb: string }> = {
  receive: { title: 'Receive stock', description: 'Add goods received outside a purchase order.', verb: 'Receive' },
  issue: { title: 'Issue stock', description: 'Remove available stock (e.g. internal use, write-off).', verb: 'Issue' },
  adjust: { title: 'Adjust stock', description: 'Correct on-hand quantity after a cycle count or damage. A reason is required.', verb: 'Adjust' },
  transfer: { title: 'Transfer stock', description: 'Move units between warehouses. Both sides update atomically.', verb: 'Transfer' },
  reserve: { title: 'Reserve stock', description: 'Hold available units for an order. On-hand is unchanged.', verb: 'Reserve' },
  release: { title: 'Release reservation', description: 'Return reserved units to available stock.', verb: 'Release' },
  return: { title: 'Customer return', description: 'Add units returned by a customer back to stock.', verb: 'Record return' },
}

const schema = z
  .object({
    product_id: z.coerce.number().int().positive('Select a product'),
    warehouse_id: z.coerce.number().int().positive('Select a warehouse'),
    to_warehouse_id: z.coerce.number().int().optional(),
    quantity: z.coerce.number({ invalid_type_error: 'Enter a number' }).int('Whole units only'),
    reference: z.string().max(120).optional(),
    note: z.string().max(1000).optional(),
    op: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.op === 'adjust') {
      if (v.quantity === 0) ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Change cannot be zero' })
      if (!v.note || v.note.trim().length < 3)
        ctx.addIssue({ code: 'custom', path: ['note'], message: 'Give a reason (at least 3 characters)' })
    } else if (v.quantity <= 0) ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Quantity must be greater than zero' })
    if (v.op === 'transfer') {
      if (!v.to_warehouse_id) ctx.addIssue({ code: 'custom', path: ['to_warehouse_id'], message: 'Select a destination' })
      else if (v.to_warehouse_id === v.warehouse_id)
        ctx.addIssue({ code: 'custom', path: ['to_warehouse_id'], message: 'Destination must differ from source' })
    }
  })
type Values = z.infer<typeof schema>

interface Props {
  op: StockOp | null
  onOpenChange: (open: boolean) => void
  item?: Pick<InventoryItem, 'product_id' | 'warehouse_id' | 'sku' | 'product_name' | 'warehouse_code' | 'available_quantity' | 'reserved_quantity' | 'quantity_on_hand'> | null
  defaultProductId?: number
  defaultWarehouseId?: number
}

export function StockOperationDialog({ op, onOpenChange, item, defaultProductId, defaultWarehouseId }: Props) {
  const qc = useQueryClient()
  const products = useAllProducts()
  const warehouses = useAllWarehouses()
  // One idempotency key per dialog session: a double-click or network retry can't apply twice.
  const [idemKey, setIdemKey] = useState(newIdempotencyKey)
  const form = useForm<Values>({ resolver: zodResolver(schema) })
  const { register, handleSubmit, reset, watch, setError, formState } = form

  useEffect(() => {
    if (op) {
      setIdemKey(newIdempotencyKey())
      reset({
        op,
        product_id: item?.product_id ?? defaultProductId ?? ('' as unknown as number),
        warehouse_id: item?.warehouse_id ?? defaultWarehouseId ?? ('' as unknown as number),
        to_warehouse_id: undefined,
        quantity: '' as unknown as number,
        reference: '',
        note: '',
      })
    }
  }, [op, item, defaultProductId, defaultWarehouseId, reset])

  const mutation = useMutation({
    mutationFn: (v: Values) => {
      const base = { product_id: v.product_id, reference: v.reference || null, note: v.note || null }
      const body =
        v.op === 'transfer'
          ? { ...base, from_warehouse_id: v.warehouse_id, to_warehouse_id: v.to_warehouse_id, quantity: v.quantity }
          : v.op === 'adjust'
            ? { ...base, warehouse_id: v.warehouse_id, quantity_change: v.quantity }
            : { ...base, warehouse_id: v.warehouse_id, quantity: v.quantity }
      return api.post<StockOperationResult>(`/inventory/${v.op}`, body, { 'Idempotency-Key': idemKey })
    },
    onSuccess: (res, v) => {
      STOCK_KEYS.forEach((key) => qc.invalidateQueries({ queryKey: key }))
      const summary = res.items.map((i) => `${i.warehouse_code}: ${fmt.int(i.available_quantity)} available`).join(' · ')
      toast.success(`${OP_META[v.op as StockOp].title} completed`, { description: summary })
      onOpenChange(false)
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        for (const [field, message] of Object.entries(e.fieldErrors)) {
          const name = field === 'from_warehouse_id' ? 'warehouse_id' : field === 'quantity_change' ? 'quantity' : field
          setError(name as keyof Values, { message })
        }
      }
    },
  })

  const productId = Number(watch('product_id'))
  const warehouseId = Number(watch('warehouse_id'))
  const toWarehouseId = Number(watch('to_warehouse_id'))
  const product = useMemo(() => products.data?.find((p) => p.id === productId), [products.data, productId])
  const lockedItem = !!item
  const meta = op ? OP_META[op] : null
  const errors = formState.errors

  return (
    <Dialog open={!!op} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent>
        {meta && (
          <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{meta.title}</DialogTitle>
              <DialogDescription>{meta.description}</DialogDescription>
            </DialogHeader>
            {item && (
              <div className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/40 p-3 text-center text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">On hand</p>
                  <p className="font-semibold tabular">{fmt.int(item.quantity_on_hand)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Reserved</p>
                  <p className="font-semibold tabular">{fmt.int(item.reserved_quantity)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Available</p>
                  <p className="font-semibold tabular">{fmt.int(item.available_quantity)}</p>
                </div>
              </div>
            )}
            <InlineError error={mutation.error && !(mutation.error instanceof ApiError && Object.keys(mutation.error.fieldErrors).length) ? mutation.error : null} />
            <Field id="op-product" label="Product" error={errors.product_id?.message} required>
              {lockedItem ? (
                <Input id="op-product" value={`${item!.sku} — ${item!.product_name}`} disabled />
              ) : (
                <NativeSelect id="op-product" aria-invalid={!!errors.product_id} {...register('product_id')} disabled={products.isLoading}>
                  <option value="">{products.isLoading ? 'Loading products…' : 'Select a product'}</option>
                  {products.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sku} — {p.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <div className={op === 'transfer' ? 'grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]' : 'grid'}>
              <Field id="op-wh" label={op === 'transfer' ? 'From warehouse' : 'Warehouse'} error={errors.warehouse_id?.message} required>
                {lockedItem ? (
                  <Input id="op-wh" value={item!.warehouse_code} disabled />
                ) : (
                  <NativeSelect id="op-wh" aria-invalid={!!errors.warehouse_id} {...register('warehouse_id')}>
                    <option value="">Select a warehouse</option>
                    {warehouses.data?.filter((w) => w.status === 'ACTIVE').map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.code} — {w.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              {op === 'transfer' && (
                <>
                  <ArrowRight className="mx-auto mb-2.5 hidden size-4 text-muted-foreground sm:block" aria-hidden />
                  <Field id="op-to" label="To warehouse" error={errors.to_warehouse_id?.message} required>
                    <NativeSelect id="op-to" aria-invalid={!!errors.to_warehouse_id} {...register('to_warehouse_id')}>
                      <option value="">Select destination</option>
                      {warehouses.data
                        ?.filter((w) => w.status === 'ACTIVE' && w.id !== warehouseId)
                        .map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.code} — {w.name}
                          </option>
                        ))}
                    </NativeSelect>
                  </Field>
                </>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="op-qty"
                label={op === 'adjust' ? 'Quantity change (±)' : `Quantity${product ? ` (${product.unit})` : ''}`}
                error={errors.quantity?.message}
                hint={op === 'adjust' ? 'Negative to remove, positive to add' : undefined}
                required
              >
                <Input id="op-qty" type="number" inputMode="numeric" step={1} aria-invalid={!!errors.quantity} {...register('quantity')} />
              </Field>
              <Field id="op-ref" label="Reference" error={errors.reference?.message} hint="Document or order number">
                <Input id="op-ref" placeholder="e.g. DOC-1042" {...register('reference')} />
              </Field>
            </div>
            <Field id="op-note" label={op === 'adjust' ? 'Reason' : 'Note'} error={errors.note?.message} required={op === 'adjust'}>
              <Textarea id="op-note" rows={2} aria-invalid={!!errors.note} {...register('note')} />
            </Field>
            {op === 'transfer' && toWarehouseId > 0 && warehouseId > 0 && (
              <p className="rounded-md bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                Units leave <strong>{warehouses.data?.find((w) => w.id === warehouseId)?.code}</strong> and arrive in{' '}
                <strong>{warehouses.data?.find((w) => w.id === toWarehouseId)?.code}</strong> in a single transaction — if
                anything fails, nothing moves.
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
                Cancel
              </Button>
              <Button type="submit" loading={mutation.isPending}>
                {meta.verb}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
