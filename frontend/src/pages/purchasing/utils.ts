import type { FieldValues, Path, UseFormSetError } from 'react-hook-form'
import { ApiError } from '@/lib/api'
import type { POStatus, PurchaseOrderSummary } from '@/lib/types'
import { isoDate } from '@/lib/utils'

/** Today as YYYY-MM-DD in the user's local timezone. */
export function todayIso(): string {
  return isoDate(new Date())
}

export function addDaysIso(days: number, from: Date = new Date()): string {
  const d = new Date(from)
  d.setDate(d.getDate() + days)
  return isoDate(d)
}

/** Whole days between today and an ISO date (positive = in the past). */
export function daysPast(iso: string | null | undefined): number {
  if (!iso) return 0
  const target = new Date(`${iso.slice(0, 10)}T00:00:00`)
  const today = new Date(`${todayIso()}T00:00:00`)
  return Math.round((today.getTime() - target.getTime()) / 86_400_000)
}

/**
 * Maps a 422 VALIDATION_ERROR's field paths onto react-hook-form fields.
 * `rename` translates API field names/prefixes into form paths (e.g. quantity_ordered → quantity).
 * Returns true when at least one field error was applied.
 */
export function applyServerErrors<T extends FieldValues>(
  e: unknown,
  setError: UseFormSetError<T>,
  rename: (field: string) => string | null = (f) => f,
): boolean {
  if (!(e instanceof ApiError)) return false
  let applied = false
  for (const [field, message] of Object.entries(e.fieldErrors)) {
    const name = rename(field.replace(/^body\./, ''))
    if (!name) continue
    setError(name as Path<T>, { type: 'server', message })
    applied = true
  }
  return applied
}

/** Invalidates every query family a purchase-order change can affect. */
export const PO_RELATED_KEYS = [['purchase-orders'], ['reports'], ['dashboard'], ['restocking'], ['shortages'], ['suppliers']]

export interface POReport {
  by_status: Array<{ status: POStatus; count: number; value: number; outstanding_units: number }>
  /** Total overdue POs; `overdue` is capped at `overdue_list_limit` (oldest first). */
  overdue_count: number
  overdue_list_limit: number
  overdue: Array<{ id: number; po_number: string; supplier_name: string; expected_delivery_date: string; status: POStatus; days_overdue: number }>
}

export const PO_STATUS_ORDER: POStatus[] = ['DRAFT', 'SUBMITTED', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']
export const PO_STATUS_LABEL: Record<POStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  CONFIRMED: 'Confirmed',
  PARTIALLY_RECEIVED: 'Partially received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
}
export const OPEN_PO_STATUSES: POStatus[] = ['DRAFT', 'SUBMITTED', 'CONFIRMED', 'PARTIALLY_RECEIVED']

export function isOverdue(po: Pick<PurchaseOrderSummary, 'status' | 'expected_delivery_date'>): boolean {
  return OPEN_PO_STATUSES.includes(po.status) && po.status !== 'DRAFT' && !!po.expected_delivery_date && daysPast(po.expected_delivery_date) > 0
}


/** Default goods-received-note number: stable for one dialog session so a retry can't receive twice. */
export function generateGrn(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `GRN-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

