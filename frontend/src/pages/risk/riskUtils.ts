import type { DemandSource, StockRisk } from '@/lib/types'
import { RISK_RANK } from '../purchasing/utils'

/** Inbound that actually offsets risk: submitted/confirmed POs due within the lead time (drafts excluded). */
export const effectiveInbound = (r: StockRisk) => r.inbound_within_lead_time ?? r.inbound_quantity

export const DEMAND_SOURCE_LABEL: Record<DemandSource, string> = {
  FORECAST: 'Demand: forecast',
  HISTORICAL_AVERAGE: 'Demand: historical average',
  NONE: 'No demand data',
}

/** Client-side sort for the (unpaged) shortages list. `risk` = most severe first. */
export function sortRisks(rows: StockRisk[], sort: string): StockRisk[] {
  const desc = sort.startsWith('-')
  const key = sort.replace(/^-/, '')
  const cover = (r: StockRisk) => (r.days_of_cover == null ? Number.POSITIVE_INFINITY : r.days_of_cover)
  const cmp: Record<string, (a: StockRisk, b: StockRisk) => number> = {
    risk: (a, b) => RISK_RANK[b.risk_level] - RISK_RANK[a.risk_level] || cover(a) - cover(b) || a.projected_stock_at_lead_time - b.projected_stock_at_lead_time,
    days_of_cover: (a, b) => cover(a) - cover(b),
    projected: (a, b) => a.projected_stock_at_lead_time - b.projected_stock_at_lead_time,
    available_quantity: (a, b) => a.available_quantity - b.available_quantity,
    sku: (a, b) => a.sku.localeCompare(b.sku) || a.warehouse_code.localeCompare(b.warehouse_code),
  }
  const fn = cmp[key] ?? cmp.risk
  return [...rows].sort((a, b) => (desc ? -fn(a, b) : fn(a, b)) || a.inventory_item_id - b.inventory_item_id)
}
