import { useQuery } from '@tanstack/react-query'
import { ArrowDownRight, ArrowUpRight, CheckCircle2, Minus } from 'lucide-react'
import { qk, useMeta } from '@/api/queries'
import { api } from '@/lib/api'
import type { ForecastWithHistory } from '@/lib/types'
import { fmt } from '@/lib/utils'

export interface ChartRow {
  date: string
  actual?: number
  ma7?: number
  forecast?: number
  band?: [number, number]
}

/** Merges history and forecast points into one date-indexed series for Recharts. */
export function buildChartRows(data: ForecastWithHistory, withMa: boolean): ChartRow[] {
  const rows: ChartRow[] = data.history.map((h, i, arr) => {
    const row: ChartRow = { date: h.date, actual: h.quantity }
    if (withMa && i >= 6) {
      let s = 0
      for (let k = i - 6; k <= i; k++) s += arr[k].quantity
      row.ma7 = Math.round((s / 7) * 100) / 100
    }
    return row
  })
  const lastHist = data.history.at(-1)?.date ?? ''
  for (const p of data.forecast?.points ?? []) {
    // Only predictions after the last observed day are "future"; ignore any overlap.
    if (lastHist && p.date <= lastHist) continue
    rows.push({ date: p.date, forecast: p.predicted, band: [p.lower, p.upper] })
  }
  return rows
}

/** Human-readable bias: direction + magnitude relative to mean daily demand when known. */
export function describeBias(bias: number | null | undefined, meanDemand?: number | null) {
  if (bias == null) return { text: '—', tone: 'muted' as const, icon: Minus }
  const rel = meanDemand ? Math.abs(bias) / meanDemand : null
  if (Math.abs(bias) < 0.05 || (rel != null && rel < 0.02)) return { text: 'Unbiased', tone: 'good' as const, icon: CheckCircle2 }
  const over = bias > 0
  const amount = `${fmt.num(Math.abs(bias))} units/day${rel != null ? ` (${(rel * 100).toFixed(0)}%)` : ''}`
  return {
    text: `${over ? 'Over' : 'Under'}-forecasting by ${amount}`,
    tone: rel != null && rel > 0.1 ? ('warn' as const) : ('muted' as const),
    icon: over ? ArrowUpRight : ArrowDownRight,
  }
}

/** Query keys that change when new forecasts are stored. */
export const FORECAST_DEPENDENT_KEYS = [['forecasts'], ['reports'], ['dashboard'], ['shortages'], ['restocking'], ['jobs']]

interface ForecastAccuracy {
  by_model: Array<{ model_name: string; items: number; avg_mae: number | null; avg_wape: number | null; total_predicted: number; last_generated_at: string }>
  items_forecasted: number
  last_generated_at: string | null
}

export function useForecastAccuracy() {
  return useQuery({ queryKey: qk.reports('forecast-accuracy'), queryFn: () => api.get<ForecastAccuracy>('/reports/forecast-accuracy') })
}

/** Normalises an interval level (0.8 or 80) to a whole percentage. */
export function toLevelPct(level: number | null | undefined): number | null {
  if (level == null || !Number.isFinite(level) || level <= 0) return null
  return level <= 1 ? Math.round(level * 100) : Math.round(level)
}

/**
 * Prediction-interval level as a percentage: the forecast run's own `details.interval.level` when known,
 * else the server default from GET /meta. `null` while neither is available.
 */
export function useIntervalPct(runLevel?: number | null): number | null {
  const meta = useMeta()
  return toLevelPct(runLevel) ?? toLevelPct(meta.data?.forecast_interval_level)
}

/** "80% interval" (or "Prediction interval" when the level is unknown). */
export function intervalLabel(pct: number | null, noun = 'interval'): string {
  return pct == null ? `Prediction ${noun}` : `${pct}% ${noun}`
}
