import type { ForecastWithHistory } from '@/lib/types'

export interface Row {
  date: string
  actual?: number
  predicted?: number
  band?: [number, number]
}

/** Merges actual daily demand with the forecast so both share one x-axis; the forecast line
 *  starts at the last actual point so the transition is continuous. */
export function buildForecastSeries(data: ForecastWithHistory | undefined): Row[] {
  if (!data) return []
  const rows = new Map<string, Row>()
  for (const h of data.history) rows.set(h.date, { date: h.date, actual: h.quantity })
  const points = data.forecast?.points ?? []
  const last = data.history[data.history.length - 1]
  if (last && points.length && last.date < points[0].date) {
    rows.set(last.date, { date: last.date, actual: last.quantity, predicted: last.quantity, band: [last.quantity, last.quantity] })
  }
  for (const p of points) {
    const prev = rows.get(p.date) ?? { date: p.date }
    rows.set(p.date, { ...prev, predicted: p.predicted, band: [Math.max(0, p.lower), p.upper] })
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date))
}
