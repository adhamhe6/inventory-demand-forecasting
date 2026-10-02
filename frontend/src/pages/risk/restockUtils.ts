import type { RestockRecommendation } from '@/lib/types'

/** Validation message for an editable order quantity, or null when valid. */
export function qtyError(raw: string): string | null {
  if (raw.trim() === '') return 'Required'
  const n = Number(raw)
  if (!Number.isInteger(n)) return 'Whole units'
  if (n <= 0) return 'Must be > 0'
  if (n > 1_000_000) return 'Too large'
  return null
}

export interface RestockGroup {
  key: string
  supplierId: number
  supplierName: string
  warehouseCode: string
  items: number
  units: number
  cost: number
}

/** Groups selected rows the way the API will (one draft PO per supplier × warehouse) and builds the request items. */
export function buildRestockPlan(
  rows: RestockRecommendation[],
  opts: { qtyOf: (r: RestockRecommendation) => string; supplierOf: (r: RestockRecommendation) => number | null; supplierName: (id: number) => string },
) {
  const groups = new Map<string, RestockGroup>()
  const items: Array<{ product_id: number; warehouse_id: number; quantity: number; supplier_id?: number }> = []
  for (const r of rows) {
    const supplierId = opts.supplierOf(r)
    if (!supplierId) continue
    const quantity = Number(opts.qtyOf(r))
    items.push({
      product_id: r.product_id,
      warehouse_id: r.warehouse_id,
      quantity,
      // Only send an explicit supplier when it differs from the product's preferred one.
      ...(r.supplier_id && r.supplier_id === supplierId ? {} : { supplier_id: supplierId }),
    })
    const key = `${supplierId}:${r.warehouse_id}`
    const g = groups.get(key) ?? { key, supplierId, supplierName: r.supplier_id === supplierId && r.supplier_name ? r.supplier_name : opts.supplierName(supplierId), warehouseCode: r.warehouse_code, items: 0, units: 0, cost: 0 }
    g.items += 1
    g.units += quantity
    g.cost += quantity * r.unit_cost
    groups.set(key, g)
  }
  const list = [...groups.values()].sort((a, b) => a.supplierName.localeCompare(b.supplierName) || a.warehouseCode.localeCompare(b.warehouseCode))
  return { items, groups: list, total: list.reduce((n, g) => n + g.cost, 0) }
}
