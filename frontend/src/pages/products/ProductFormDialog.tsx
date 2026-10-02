import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { STOCK_KEYS, useAllSuppliers, useCategories } from '@/api/queries'
import { Field } from '@/components/common/Field'
import { InlineError } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, NativeSelect, Textarea } from '@/components/ui/input'
import { api } from '@/lib/api'
import type { Product } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { applyServerErrors, changedFields, isFieldLevelError, nullable } from './formUtils'

export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/

const money = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine((v) => v === '' || Number.isFinite(Number(v)), 'Enter a valid amount')
    .refine((v) => !Number.isFinite(Number(v)) || Number(v) >= 0, `${label} cannot be negative`)
    .refine((v) => !Number.isFinite(Number(v)) || Number(v) < 0 || /^\d{1,10}(\.\d{1,2})?$/.test(v), 'Up to 10 digits and 2 decimal places')

const wholeNumber = (label: string, max?: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine((v) => /^\d+$/.test(v), 'Enter a whole number of 0 or more')
    .refine((v) => max == null || !/^\d+$/.test(v) || Number(v) <= max, `Must be ${max} or less`)

function makeSchema(mode: 'create' | 'edit') {
  return z.object({
    sku:
      mode === 'create'
        ? z
            .string()
            .trim()
            .min(1, 'SKU is required')
            .regex(SKU_PATTERN, "2–64 characters: letters, digits, '.', '_' or '-' (must start with a letter or digit)")
        : z.string(),
    name: z.string().trim().min(1, 'Name is required').max(200, 'At most 200 characters'),
    description: z.string().max(5000, 'At most 5000 characters'),
    category: z.string().trim().min(1, 'Category is required').max(100, 'At most 100 characters'),
    unit: z.string().trim().min(1, 'Unit is required').max(20, 'At most 20 characters'),
    cost: money('Cost'),
    price: money('Price'),
    min_stock: wholeNumber('Min stock'),
    reorder_point: wholeNumber('Reorder point'),
    safety_stock: wholeNumber('Safety stock'),
    lead_time_days: wholeNumber('Lead time', 365),
    supplier_id: z.string(),
    is_active: z.boolean(),
  })
}

export type ProductFormValues = z.infer<ReturnType<typeof makeSchema>>
const FIELDS = [
  'sku',
  'name',
  'description',
  'category',
  'unit',
  'cost',
  'price',
  'min_stock',
  'reorder_point',
  'safety_stock',
  'lead_time_days',
  'supplier_id',
  'is_active',
] as const

const EMPTY: ProductFormValues = {
  sku: '',
  name: '',
  description: '',
  category: '',
  unit: 'pcs',
  cost: '',
  price: '',
  min_stock: '0',
  reorder_point: '0',
  safety_stock: '0',
  lead_time_days: '7',
  supplier_id: '',
  is_active: true,
}

function toValues(p: Product): ProductFormValues {
  return {
    sku: p.sku,
    name: p.name,
    description: p.description ?? '',
    category: p.category,
    unit: p.unit,
    cost: p.cost,
    price: p.price,
    min_stock: String(p.min_stock),
    reorder_point: String(p.reorder_point),
    safety_stock: String(p.safety_stock),
    lead_time_days: String(p.lead_time_days),
    supplier_id: p.supplier_id ? String(p.supplier_id) : '',
    is_active: p.is_active,
  }
}

/** Converts form strings to the API payload (without sku). */
function toPayload(v: ProductFormValues) {
  return {
    name: v.name.trim(),
    description: nullable(v.description),
    category: v.category.trim(),
    unit: v.unit.trim(),
    cost: v.cost.trim(),
    price: v.price.trim(),
    min_stock: Number(v.min_stock),
    reorder_point: Number(v.reorder_point),
    safety_stock: Number(v.safety_stock),
    lead_time_days: Number(v.lead_time_days),
    supplier_id: v.supplier_id ? Number(v.supplier_id) : null,
    is_active: v.is_active,
  }
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set the dialog edits this product; otherwise it creates a new one. */
  product?: Product | null
  onSaved?: (p: Product) => void
}

export function ProductFormDialog({ open, onOpenChange, product, onSaved }: Props) {
  const mode = product ? 'edit' : 'create'
  const qc = useQueryClient()
  const suppliers = useAllSuppliers()
  const categories = useCategories()
  const schema = useMemo(() => makeSchema(mode), [mode])
  const form = useForm<ProductFormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY })
  const { register, handleSubmit, reset, setError, control, formState } = form
  const errors = formState.errors

  useEffect(() => {
    if (open) reset(product ? toValues(product) : EMPTY)
  }, [open, product, reset])

  const mutation = useMutation({
    mutationFn: async (v: ProductFormValues): Promise<Product | null> => {
      if (product) {
        const changes = changedFields(toPayload(toValues(product)), toPayload(v))
        if (Object.keys(changes).length === 0) return null
        return api.patch<Product>(`/products/${product.id}`, changes)
      }
      return api.post<Product>('/products', { sku: v.sku.trim(), ...toPayload(v) })
    },
    onSuccess: (saved) => {
      if (!saved) {
        toast.info('No changes to save')
        onOpenChange(false)
        return
      }
      STOCK_KEYS.forEach((key) => qc.invalidateQueries({ queryKey: key }))
      toast.success(product ? 'Product updated' : 'Product created', { description: `${saved.sku} — ${saved.name}` })
      onSaved?.(saved)
      onOpenChange(false)
    },
    onError: (e) => applyServerErrors(e, setError, FIELDS, 'sku'),
  })

  const [costRaw, priceRaw, supplierRaw] = useWatch({ control, name: ['cost', 'price', 'supplier_id'] })
  const cost = Number(costRaw)
  const price = Number(priceRaw)
  const supplierId = Number(supplierRaw)
  const supplier = suppliers.data?.find((s) => s.id === supplierId)
  const margin = Number.isFinite(cost) && Number.isFinite(price) && price > 0 ? (price - cost) / price : null
  const showBanner = mutation.error && !isFieldLevelError(mutation.error, FIELDS, true)

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent size="lg">
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{product ? `Edit ${product.sku}` : 'New product'}</DialogTitle>
            <DialogDescription>
              {product ? 'Update catalog details, pricing and replenishment parameters.' : 'Add an item to the catalog. Stock is added afterwards via receipts or purchase orders.'}
            </DialogDescription>
          </DialogHeader>
          {showBanner && <InlineError error={mutation.error} />}

          <fieldset>
            <legend className="sr-only">Identity</legend>
            <div className="grid gap-4 sm:grid-cols-2">
            <Field id="p-sku" label="SKU" error={errors.sku?.message} required={mode === 'create'} hint={mode === 'create' ? 'Unique, stored in upper case' : 'SKU cannot be changed'}>
              <Input
                id="p-sku"
                className="font-mono uppercase placeholder:normal-case"
                autoComplete="off"
                placeholder="e.g. ELEC-USB-C-01"
                disabled={mode === 'edit'}
                aria-invalid={!!errors.sku}
                {...register('sku')}
              />
            </Field>
            <Field id="p-name" label="Name" error={errors.name?.message} required>
              <Input id="p-name" placeholder="e.g. USB-C Cable 1m" aria-invalid={!!errors.name} {...register('name')} />
            </Field>
            <Field id="p-category" label="Category" error={errors.category?.message} required hint="Pick an existing category or type a new one">
              <Input id="p-category" list="p-category-list" autoComplete="off" aria-invalid={!!errors.category} {...register('category')} />
              <datalist id="p-category-list">
                {categories.data?.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field id="p-unit" label="Unit" error={errors.unit?.message} required hint="e.g. pcs, box, kg">
              <Input id="p-unit" aria-invalid={!!errors.unit} {...register('unit')} />
            </Field>
            <Field id="p-desc" label="Description" error={errors.description?.message} className="sm:col-span-2">
              <Textarea id="p-desc" rows={2} aria-invalid={!!errors.description} {...register('description')} />
            </Field>
            </div>
          </fieldset>

          <fieldset className="border-t pt-4">
            <legend className="sr-only">Pricing</legend>
            <h3 className="mb-3 text-sm font-semibold" aria-hidden>Pricing</h3>
            <div className="grid gap-4 sm:grid-cols-3">
            <Field id="p-cost" label="Unit cost (USD)" error={errors.cost?.message} required>
              <Input id="p-cost" type="number" inputMode="decimal" min={0} step="0.01" aria-invalid={!!errors.cost} {...register('cost')} />
            </Field>
            <Field id="p-price" label="Sale price (USD)" error={errors.price?.message} required>
              <Input id="p-price" type="number" inputMode="decimal" min={0} step="0.01" aria-invalid={!!errors.price} {...register('price')} />
            </Field>
            <div className="grid content-start gap-1.5">
              <span className="text-sm font-medium">Gross margin</span>
              <p
                className={cn(
                  'flex h-9 items-center rounded-md bg-muted/60 px-3 text-sm font-semibold tabular',
                  margin != null && margin < 0 && 'text-destructive',
                )}
                aria-live="polite"
              >
                {margin == null ? '—' : `${fmt.pct(margin)} · ${fmt.money(price - cost)}`}
              </p>
            </div>
            </div>
          </fieldset>

          <fieldset className="border-t pt-4">
            <legend className="sr-only">Replenishment</legend>
            <h3 className="mb-3 text-sm font-semibold" aria-hidden>Replenishment</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field id="p-min" label="Min stock" error={errors.min_stock?.message} required>
              <Input id="p-min" type="number" inputMode="numeric" min={0} step={1} aria-invalid={!!errors.min_stock} {...register('min_stock')} />
            </Field>
            <Field id="p-rop" label="Reorder point" error={errors.reorder_point?.message} required>
              <Input id="p-rop" type="number" inputMode="numeric" min={0} step={1} aria-invalid={!!errors.reorder_point} {...register('reorder_point')} />
            </Field>
            <Field id="p-ss" label="Safety stock" error={errors.safety_stock?.message} required>
              <Input id="p-ss" type="number" inputMode="numeric" min={0} step={1} aria-invalid={!!errors.safety_stock} {...register('safety_stock')} />
            </Field>
            <Field id="p-lead" label="Lead time (days)" error={errors.lead_time_days?.message} required>
              <Input id="p-lead" type="number" inputMode="numeric" min={0} max={365} step={1} aria-invalid={!!errors.lead_time_days} {...register('lead_time_days')} />
            </Field>
            <Field
              id="p-supplier"
              label="Preferred supplier"
              error={errors.supplier_id?.message}
              className="sm:col-span-2"
              hint={supplier ? `Supplier lead time (${supplier.lead_time_days} days) is used for planning; the product lead time is the fallback.` : 'Optional — used for restocking suggestions and purchase orders'}
            >
              <NativeSelect id="p-supplier" aria-invalid={!!errors.supplier_id} disabled={suppliers.isLoading} {...register('supplier_id')}>
                <option value="">{suppliers.isLoading ? 'Loading suppliers…' : 'No preferred supplier'}</option>
                {suppliers.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.status === 'INACTIVE' ? ' (inactive)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div className="flex items-start gap-3 rounded-lg border p-3 sm:col-span-2">
              <input id="p-active" type="checkbox" className="mt-0.5 size-4 cursor-pointer accent-[var(--primary)]" {...register('is_active')} />
              <label htmlFor="p-active" className="grid cursor-pointer gap-0.5 text-sm">
                <span className="font-medium">Active</span>
                <span className="text-xs text-muted-foreground">Inactive products are hidden from ordering and stock operations but keep their history.</span>
              </label>
            </div>
            </div>
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {product ? 'Save changes' : 'Create product'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
