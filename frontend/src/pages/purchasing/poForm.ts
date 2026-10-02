import { z } from 'zod'
import { ApiError } from '@/lib/api'

const MONEY = /^\d{1,10}(\.\d{1,2})?$/

export const lineSchema = z.object({
  product_id: z.coerce.number({ invalid_type_error: 'Select a product' }).int().positive('Select a product'),
  quantity: z.coerce
    .number({ invalid_type_error: 'Enter a quantity' })
    .int('Whole units only')
    .positive('Must be greater than 0')
    .max(1_000_000, 'At most 1,000,000'),
  unit_cost: z
    .string()
    .trim()
    .min(1, 'Enter a unit cost')
    .regex(MONEY, 'Use a positive amount with up to 2 decimals'),
})

/**
 * Purchase-order form schema. `minDate` is the earliest allowed expected delivery date
 * (today for new orders, the order date when editing a draft).
 */
export function poSchema(minDate: string, minDateMessage = 'Expected delivery cannot be in the past') {
  return z
    .object({
      supplier_id: z.coerce.number({ invalid_type_error: 'Select a supplier' }).int().positive('Select a supplier'),
      warehouse_id: z.coerce.number({ invalid_type_error: 'Select a warehouse' }).int().positive('Select a warehouse'),
      expected_delivery_date: z
        .string()
        .min(1, 'Choose an expected delivery date')
        .refine((d) => d >= minDate, minDateMessage),
      notes: z.string().max(2000, 'Keep notes under 2,000 characters').optional(),
      lines: z.array(lineSchema).min(1, 'Add at least one line item').max(200, 'At most 200 lines per order'),
    })
    .superRefine((v, ctx) => {
      const seen = new Set<number>()
      v.lines.forEach((l, i) => {
        if (!l.product_id) return
        if (seen.has(l.product_id))
          ctx.addIssue({ code: 'custom', path: ['lines', i, 'product_id'], message: 'This product is already on the order — adjust the quantity instead' })
        seen.add(l.product_id)
      })
    })
}

export type POFormValues = z.infer<ReturnType<typeof poSchema>>
export type POLineValues = z.infer<typeof lineSchema>

export const emptyLine = (): POLineValues => ({ product_id: '' as unknown as number, quantity: '' as unknown as number, unit_cost: '' })

/** Translate API field paths (lines.0.quantity_ordered) to form paths (lines.0.quantity). */
export function renamePoField(field: string): string {
  return field.replace(/quantity_ordered$/, 'quantity')
}

/** Business-rule error codes that belong to a specific form field. */
export function poBusinessErrorField(e: unknown): keyof POFormValues | null {
  if (!(e instanceof ApiError)) return null
  if (e.code === 'INVALID_DATE') return 'expected_delivery_date'
  if (e.code === 'SUPPLIER_INACTIVE') return 'supplier_id'
  if (e.code === 'WAREHOUSE_INACTIVE') return 'warehouse_id'
  return null
}

export function lineTotal(quantity: unknown, unitCost: unknown): number {
  const q = Number(quantity)
  const c = Number(unitCost)
  return Number.isFinite(q) && Number.isFinite(c) && q > 0 && c >= 0 ? q * c : 0
}

/** Body for POST/PATCH /purchase-orders lines. */
export function toApiLines(lines: POLineValues[]) {
  return lines.map((l) => ({ product_id: Number(l.product_id), quantity_ordered: Number(l.quantity), unit_cost: l.unit_cost.trim() }))
}
