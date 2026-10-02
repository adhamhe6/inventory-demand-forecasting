// Static descriptions used across the forecasting UI (no business data here).

export type ModelChoice = 'auto' | 'moving_average' | 'seasonal_naive' | 'holt_winters' | 'croston'

export const MODEL_META: Record<ModelChoice, { label: string; short: string; description: string }> = {
  auto: {
    label: 'Auto (best backtest)',
    short: 'Auto',
    description:
      'Backtests every model suited to the demand pattern on recent history and keeps the one with the lowest error.',
  },
  moving_average: {
    label: 'Moving average',
    short: 'Moving avg.',
    description: 'Flat forecast equal to the mean of the last 28 days. A transparent, robust baseline.',
  },
  seasonal_naive: {
    label: 'Seasonal naive (weekly)',
    short: 'Seasonal naive',
    description: 'Each weekday is forecast as the average of the same weekday over the last 4 weeks.',
  },
  holt_winters: {
    label: 'Holt-Winters',
    short: 'Holt-Winters',
    description: 'Exponential smoothing with a damped trend and weekly seasonality. Best for smooth, regular demand.',
  },
  croston: {
    label: 'Croston (SBA)',
    short: 'Croston',
    description: 'Separately smooths order size and the interval between orders. Designed for intermittent demand.',
  },
}

export const MODEL_CHOICES = Object.keys(MODEL_META) as ModelChoice[]

export function modelLabel(name: string | null | undefined): string {
  if (!name) return '—'
  return (MODEL_META as Record<string, { label: string }>)[name]?.label ?? name.replace(/_/g, ' ')
}

export function modelShort(name: string | null | undefined): string {
  if (!name) return '—'
  return (MODEL_META as Record<string, { short: string }>)[name]?.short ?? name.replace(/_/g, ' ')
}

export const HORIZONS = [7, 14, 30, 60, 90] as const
export const HISTORY_WINDOWS = [60, 90, 180, 365] as const

export const METRIC_HELP = {
  mae: 'Mean Absolute Error — the average number of units the forecast missed by per day. Lower is better; same unit as demand.',
  rmse: 'Root Mean Squared Error — like MAE but penalises large misses more heavily. Useful when big errors are costly.',
  wape: 'Weighted Absolute Percentage Error — total absolute error divided by total actual demand. Robust to zero-demand days.',
  mape: 'Mean Absolute Percentage Error — average percentage miss, computed on days with non-zero demand only (undefined on zero days).',
  bias: 'Average of (forecast − actual) per day. Positive means systematic over-forecasting, negative means under-forecasting.',
} as const

export const PATTERN_META: Record<string, { label: string; description: string; variant: 'success' | 'info' | 'warning' | 'orange' | 'muted' }> = {
  smooth: { label: 'Smooth', description: 'Regular demand with low variability — easiest to forecast.', variant: 'success' },
  erratic: { label: 'Erratic', description: 'Demand occurs most days but quantities vary a lot.', variant: 'warning' },
  intermittent: { label: 'Intermittent', description: 'Many zero-demand days, fairly consistent order sizes.', variant: 'info' },
  lumpy: { label: 'Lumpy', description: 'Sporadic demand with highly variable order sizes — hardest to forecast.', variant: 'orange' },
  no_demand: { label: 'No demand', description: 'No sales recorded in the history window.', variant: 'muted' },
}

export const SELECTION_METRIC_HELP: Record<string, string> = {
  mae: 'MAE was used to pick the model because demand is regular: it rewards the forecast that is closest on a typical day.',
  rmse: 'RMSE was used to pick the model because demand is intermittent: MAE would favour forecasting zero, which never triggers replenishment.',
}
