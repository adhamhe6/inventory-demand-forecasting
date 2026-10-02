/**
 * Small helpers shared by the master-data forms (products, warehouses, suppliers).
 * Kept local to the catalog pages so the shared lib stays untouched.
 */
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form'
import { ApiError } from '@/lib/api'

/** Returns only the keys of `next` whose value differs from `initial` (PATCH bodies only need changes). */
export function changedFields<T extends Record<string, unknown>>(initial: T, next: T): Partial<T> {
  const out: Partial<T> = {}
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (!Object.is(normalise(initial[key]), normalise(next[key]))) out[key] = next[key]
  }
  return out
}

function normalise(v: unknown): unknown {
  // Money arrives as "22.00" but the form may produce "22" or "22.0" – compare numerically.
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

/** Empty / whitespace-only strings become null (the API treats null as "clear this field"). */
export function nullable(v: string | undefined | null): string | null {
  const t = (v ?? '').trim()
  return t ? t : null
}

/**
 * Maps a server error onto form fields.
 * - 422 VALIDATION_ERROR → each `details[].field`
 * - 409 DUPLICATE → `duplicateField` (e.g. sku / code / name)
 * Returns true when at least one field received the error (so the caller can skip a generic banner).
 */
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly string[],
  duplicateField?: Path<T>,
): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.status === 409 && error.code === 'DUPLICATE' && duplicateField) {
    setError(duplicateField, { type: 'server', message: error.message }, { shouldFocus: true })
    return true
  }
  let mapped = false
  for (const [field, message] of Object.entries(error.fieldErrors)) {
    if (fields.includes(field)) {
      setError(field as Path<T>, { type: 'server', message })
      mapped = true
    }
  }
  return mapped
}

/** True when the error has been fully explained on individual fields. */
export function isFieldLevelError(error: unknown, fields: readonly string[], duplicate = false): boolean {
  if (!(error instanceof ApiError)) return false
  if (duplicate && error.status === 409 && error.code === 'DUPLICATE') return true
  const keys = Object.keys(error.fieldErrors)
  return keys.length > 0 && keys.every((k) => fields.includes(k))
}

/** Gross margin as a fraction of price (money fields arrive as decimal strings). */
export function marginOf(p: { cost: string | number; price: string | number }): number | null {
  const price = Number(p.price)
  const cost = Number(p.cost)
  return price > 0 ? (price - cost) / price : null
}
