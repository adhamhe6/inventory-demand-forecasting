import type { DemandSource, StockRisk } from '@/lib/types'

/** Inbound that actually offsets risk: submitted/confirmed POs due within the lead time (drafts excluded). */
export const effectiveInbound = (r: StockRisk) => r.inbound_within_lead_time ?? r.inbound_quantity

export const DEMAND_SOURCE_LABEL: Record<DemandSource, string> = {
  FORECAST: 'Demand: forecast',
  HISTORICAL_AVERAGE: 'Demand: historical average',
  NONE: 'No demand data',
}
