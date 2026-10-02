import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { qk, STOCK_KEYS, useAllProducts, useAllWarehouses } from '@/api/queries'
import { Field } from '@/components/common/Field'
import { InlineError } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, NativeSelect } from '@/components/ui/input'
import { ApiError, api, newIdempotencyKey } from '@/lib/api'
import type { InventoryItem, Page, Sale } from '@/lib/types'
import { fmt } from '@/lib/utils'
import { Checkbox } from '../purchasing/shared'
import { applyServerErrors } from '../purchasing/utils'
import { LookupError, LookupFailedOption } from '../shared/LookupError'

const MONEY = /^\d{1,10}(\.\d{1,2})?$/

const schema = z.object({
  product_id: z.coerce.number({ invalid_type_error: 'Select a product' }).int().positive('Select a product'),
  warehouse_id: z.coerce.number({ invalid_type_error: 'Select a warehouse' }).int().positive('Select a warehouse'),
  quantity: z.coerce.number({ invalid_type_error: 'Enter a quantity' }).int('Whole units only').positive('Must be greater than 0').max(1_000_000, 'At most 1,000,000'),
  unit_price: z
    .string()
    .trim()
    .refine((v) => v === '' || MONEY.test(v), 'Use a positive amount with up to 2 decimals')
    .optional(),
  order_reference: z.string().trim().min(1, 'Order reference is required').max(100, 'At most 100 characters'),
  sold_at: z
    .string()
    .optional()
    .refine((v) => !v || new Date(v).getTime() <= Date.now() + 60_000, 'Sale time cannot be in the future'),
  issue_stock: z.boolean(),
})
type Values = z.infer<typeof schema>

/** Maps the API's business errors onto the field the user should fix. */
function saleErrorField(e: unknown): keyof Values | null {
  if (!(e instanceof ApiError)) return null
  if (e.code === 'INSUFFICIENT_STOCK') return 'quantity'
  if (e.code === 'DUPLICATE_SALE') return 'order_reference'
  if (e.code === 'PRODUCT_INACTIVE') return 'product_id'
  if (e.code === 'WAREHOUSE_INACTIVE') return 'warehouse_id'
  return null
}

export function RecordSaleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const products = useAllProducts()
  const warehouses = useAllWarehouses()
  // One key per submission attempt: a double-submit or network retry can't record the sale twice.
  const idemKey = useRef<string | null>(null)
  const form = useForm<Values>({ resolver: zodResolver(schema) })
  const { register, handleSubmit, reset, setError, control, formState } = form
  const errors = formState.errors
  const productId = Number(useWatch({ control, name: 'product_id' })) || 0
  const warehouseId = Number(useWatch({ control, name: 'warehouse_id' })) || 0
  const qty = Number(useWatch({ control, name: 'quantity' })) || 0
  const issueStock = useWatch({ control, name: 'issue_stock' })
  const product = useMemo(() => products.data?.find((p) => p.id === productId), [products.data, productId])

  const stock = useQuery({
    queryKey: qk.inventory({ product_id: productId, warehouse_id: warehouseId, page_size: 1 }),
    queryFn: () => api.get<Page<InventoryItem>>('/inventory', { product_id: productId, warehouse_id: warehouseId, page_size: 1 }),
    enabled: open && productId > 0 && warehouseId > 0,
    select: (p) => p.items[0] ?? null,
  })
  const available = stock.data === undefined ? null : (stock.data?.available_quantity ?? 0)

  useEffect(() => {
    if (open) {
      idemKey.current = null
      reset({
        product_id: '' as unknown as number,
        warehouse_id: '' as unknown as number,
        quantity: '' as unknown as number,
        unit_price: '',
        order_reference: '',
        sold_at: '',
        issue_stock: true,
      })
    }
  }, [open, reset])

  const mutation = useMutation({
    mutationFn: (v: Values) => {
      idemKey.current ??= newIdempotencyKey()
      return api.post<Sale>(
        '/sales',
        {
          product_id: v.product_id,
          warehouse_id: v.warehouse_id,
          quantity: v.quantity,
          unit_price: v.unit_price ? v.unit_price : null,
          order_reference: v.order_reference.trim(),
          sold_at: v.sold_at ? new Date(v.sold_at).toISOString() : null,
          issue_stock: v.issue_stock,
        },
        { 'Idempotency-Key': idemKey.current },
      )
    },
    onSuccess: (sale, v) => {
      ;[['sales'], ['reports'], ['dashboard'], ...(v.issue_stock ? STOCK_KEYS : [])].forEach((key) => qc.invalidateQueries({ queryKey: key }))
      toast.success(`Sale ${sale.order_reference} recorded`, {
        description: `${fmt.int(sale.quantity)} × ${sale.sku} at ${sale.warehouse_code} · ${fmt.money(sale.revenue)}${v.issue_stock ? ' · stock issued' : ''}`,
      })
      onOpenChange(false)
    },
    onError: (e) => {
      // A rejected request isn't stored server-side, so a fresh key lets the user correct and resubmit.
      // (Network/5xx errors keep the key: the server may have applied it, and a retry must replay.)
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) idemKey.current = null
      applyServerErrors(e, setError)
      const field = saleErrorField(e)
      if (field && e instanceof ApiError) setError(field, { type: 'server', message: e.message })
    },
  })

  const generalError =
    mutation.error && !(mutation.error instanceof ApiError && (Object.keys(mutation.error.fieldErrors).length || saleErrorField(mutation.error)))
      ? mutation.error
      : null

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Record sale</DialogTitle>
            <DialogDescription>Log a customer order line. Sales history feeds demand forecasts.</DialogDescription>
          </DialogHeader>
          <InlineError error={generalError} />
          <LookupError lookups={{ products, warehouses }} context="" />
          <Field id="sale-product" label="Product" error={errors.product_id?.message} required>
            <NativeSelect id="sale-product" aria-invalid={!!errors.product_id} disabled={products.isLoading} {...register('product_id')}>
              <option value="">{products.isLoading ? 'Loading products…' : 'Select a product'}</option>
              <LookupFailedOption query={products} />
              {products.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="sale-wh" label="Warehouse" error={errors.warehouse_id?.message} required>
              <NativeSelect id="sale-wh" aria-invalid={!!errors.warehouse_id} {...register('warehouse_id')}>
                <option value="">Select a warehouse</option>
                <LookupFailedOption query={warehouses} />
                {warehouses.data
                  ?.filter((w) => w.status === 'ACTIVE')
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
            <Field
              id="sale-qty"
              label={`Quantity${product ? ` (${product.unit})` : ''}`}
              error={errors.quantity?.message}
              hint={
                available != null
                  ? `${fmt.int(available)} available in this warehouse`
                  : stock.isFetching
                    ? 'Checking stock…'
                    : stock.error
                      ? 'Couldn’t check stock here — the server still verifies availability when you save.'
                      : undefined
              }
              required
            >
              <Input id="sale-qty" type="number" inputMode="numeric" min={1} step={1} aria-invalid={!!errors.quantity} {...register('quantity')} />
            </Field>
            <Field id="sale-ref" label="Order reference" error={errors.order_reference?.message} hint="Unique per product & warehouse" required>
              <Input id="sale-ref" placeholder="e.g. SO-100045" aria-invalid={!!errors.order_reference} {...register('order_reference')} />
            </Field>
            <Field id="sale-price" label="Unit price" error={errors.unit_price?.message} hint={product ? `Defaults to list price ${fmt.money(product.price)}` : 'Defaults to the list price'}>
              <Input id="sale-price" type="number" inputMode="decimal" min={0} step="0.01" placeholder={product ? Number(product.price).toFixed(2) : ''} aria-invalid={!!errors.unit_price} {...register('unit_price')} />
            </Field>
          </div>
          <Field id="sale-at" label="Sold at" error={errors.sold_at?.message} hint="Leave empty for now. Back-date historical sales here.">
            <Input id="sale-at" type="datetime-local" aria-invalid={!!errors.sold_at} {...register('sold_at')} />
          </Field>
          <label htmlFor="sale-issue" className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
            <Checkbox id="sale-issue" className="mt-0.5" {...register('issue_stock')} />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">Issue stock</span>
              <span className="text-xs text-muted-foreground">Deduct the quantity from the warehouse now. Turn off for historical sales already reflected in stock.</span>
            </span>
          </label>
          {issueStock && available != null && qty > available && (
            <p role="status" className="-mt-2 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="size-3.5" aria-hidden /> Only {fmt.int(available)} available here. Choose another warehouse, or turn off “Issue stock” to record it as history only.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Record sale
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
