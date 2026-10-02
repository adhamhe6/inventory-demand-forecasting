import { PackagePlus, Trash2 } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useFieldArray, type UseFormReturn, useWatch } from 'react-hook-form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Product } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { emptyLine, lineTotal, type POFormValues } from './poForm'

/**
 * Dynamic purchase-order line items (react-hook-form useFieldArray).
 * Products supplied by the chosen supplier are listed first; any active product can be ordered.
 */
export function LineItemsEditor({
  form,
  products,
  productsLoading,
  supplierId,
  supplierName,
}: {
  form: UseFormReturn<POFormValues>
  products: Product[] | undefined
  productsLoading?: boolean
  supplierId: number | null
  supplierName?: string
}) {
  const { control, register, setValue, getValues, formState } = form
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' })
  const lines = useWatch({ control, name: 'lines' }) ?? []
  const byId = useMemo(() => new Map(products?.map((p) => [p.id, p])), [products])
  const preferred = useMemo(() => (supplierId ? (products ?? []).filter((p) => p.supplier_id === supplierId) : []), [products, supplierId])
  const others = useMemo(() => (products ?? []).filter((p) => !supplierId || p.supplier_id !== supplierId), [products, supplierId])
  const chosen = new Set(lines.map((l) => Number(l?.product_id)).filter(Boolean))
  const errors = formState.errors.lines

  // Native selects can't display a value before their options exist: re-apply line products once loaded.
  useEffect(() => {
    if (!products?.length) return
    getValues('lines')?.forEach((l, i) => {
      if (l?.product_id) setValue(`lines.${i}.product_id`, l.product_id)
    })
  }, [products, getValues, setValue])

  const option = (p: Product, current: number) => (
    <option key={p.id} value={p.id} disabled={chosen.has(p.id) && p.id !== current}>
      {p.sku} — {p.name}
    </option>
  )

  return (
    <div className="grid gap-3">
      <div className="hidden grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_7rem_2.25rem] gap-3 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:grid">
        <span>Product</span>
        <span className="text-right">Quantity</span>
        <span className="text-right">Unit cost</span>
        <span className="text-right">Line total</span>
        <span className="sr-only">Remove</span>
      </div>
      <ul className="grid gap-3">
        {fields.map((field, i) => {
          const line = lines[i]
          const pid = Number(line?.product_id) || 0
          const product = byId.get(pid)
          const e = Array.isArray(errors) ? errors[i] : undefined
          const otherSupplier = product && supplierId && product.supplier_id !== supplierId
          const costDiffers = product && line?.unit_cost !== '' && Number(line?.unit_cost) !== Number(product.cost)
          return (
            <li
              key={field.id}
              className="grid gap-3 rounded-lg border bg-muted/20 p-3 md:grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_7rem_2.25rem] md:items-start md:border-0 md:bg-transparent md:p-1"
            >
              <div className="grid min-w-0 gap-1">
                <Label htmlFor={`line-${i}-product`} className="md:sr-only">
                  Product (line {i + 1})
                </Label>
                <NativeSelect
                  id={`line-${i}-product`}
                  aria-label={`Product for line ${i + 1}`}
                  aria-invalid={!!e?.product_id}
                  disabled={productsLoading}
                  {...register(`lines.${i}.product_id`, {
                    onChange: (ev) => {
                      const p = byId.get(Number(ev.target.value))
                      if (p) setValue(`lines.${i}.unit_cost`, Number(p.cost).toFixed(2), { shouldValidate: formState.isSubmitted })
                    },
                  })}
                >
                  <option value="">{productsLoading ? 'Loading products…' : 'Select a product'}</option>
                  {preferred.length > 0 && <optgroup label={`Supplied by ${supplierName ?? 'this supplier'}`}>{preferred.map((p) => option(p, pid))}</optgroup>}
                  {others.length > 0 &&
                    (preferred.length > 0 ? <optgroup label="Other products">{others.map((p) => option(p, pid))}</optgroup> : others.map((p) => option(p, pid)))}
                </NativeSelect>
                {e?.product_id ? (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {e.product_id.message}
                  </p>
                ) : product ? (
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>
                      {product.category} · per {product.unit}
                    </span>
                    {otherSupplier && (
                      <Badge variant="warning" title={product.supplier ? `Usually supplied by ${product.supplier.name}` : 'No preferred supplier'}>
                        {product.supplier ? `Usually from ${product.supplier.name}` : 'No preferred supplier'}
                      </Badge>
                    )}
                  </p>
                ) : null}
              </div>
              <div className="grid grid-cols-3 gap-3 md:contents">
                <div className="grid gap-1">
                  <Label htmlFor={`line-${i}-qty`} className="md:sr-only">
                    Quantity
                  </Label>
                  <Input
                    id={`line-${i}-qty`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    aria-label={`Quantity for line ${i + 1}`}
                    aria-invalid={!!e?.quantity}
                    className="text-right tabular"
                    {...register(`lines.${i}.quantity`)}
                  />
                  {e?.quantity && (
                    <p role="alert" className="text-xs font-medium text-destructive">
                      {e.quantity.message}
                    </p>
                  )}
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`line-${i}-cost`} className="md:sr-only">
                    Unit cost
                  </Label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground" aria-hidden>
                      $
                    </span>
                    <Input
                      id={`line-${i}-cost`}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      aria-label={`Unit cost for line ${i + 1}`}
                      aria-invalid={!!e?.unit_cost}
                      className="pl-6 text-right tabular"
                      {...register(`lines.${i}.unit_cost`)}
                    />
                  </div>
                  {e?.unit_cost ? (
                    <p role="alert" className="text-xs font-medium text-destructive">
                      {e.unit_cost.message}
                    </p>
                  ) : costDiffers ? (
                    <button
                      type="button"
                      className="cursor-pointer text-right text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => setValue(`lines.${i}.unit_cost`, Number(product.cost).toFixed(2))}
                    >
                      Catalog {fmt.money(product.cost)}
                    </button>
                  ) : null}
                </div>
                <div className="grid gap-1">
                  <span className="text-sm font-medium md:sr-only" aria-hidden>
                    Total
                  </span>
                  <p className="flex h-9 items-center justify-end text-sm font-semibold tabular" aria-label={`Line ${i + 1} total`}>
                    {fmt.money(lineTotal(line?.quantity, line?.unit_cost))}
                  </p>
                </div>
              </div>
              <div className="flex justify-end md:block">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove line ${i + 1}`}
                  onClick={() => remove(i)}
                  disabled={fields.length === 1}
                  className={cn('text-muted-foreground hover:text-destructive')}
                >
                  <Trash2 />
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
      {errors?.root?.message || (errors as { message?: string } | undefined)?.message ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {errors?.root?.message ?? (errors as { message?: string }).message}
        </p>
      ) : null}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => append(emptyLine())} disabled={fields.length >= 200}>
          <PackagePlus /> Add line
        </Button>
      </div>
    </div>
  )
}
