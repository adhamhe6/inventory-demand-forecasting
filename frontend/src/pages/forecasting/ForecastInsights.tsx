import { AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip'
import type { ForecastMetrics, ForecastRun } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { describeBias } from './lib'
import { METRIC_HELP, PATTERN_META, SELECTION_METRIC_HELP, modelLabel } from './meta'

function InfoTip({ text, label }: { text: ReactNode; label: string }) {
  return (
    <Tooltip content={text}>
      <button type="button" aria-label={`About ${label}`} className="inline-flex rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <Info className="size-3.5" aria-hidden />
      </button>
    </Tooltip>
  )
}

function Metric({ label, value, hint, help }: { label: string; value: ReactNode; hint?: ReactNode; help: string }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {label}
        <InfoTip text={help} label={label} />
      </dt>
      <dd className="mt-1 text-lg font-semibold tabular">{value}</dd>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  )
}


export function ModelAccuracyCard({ run }: { run: ForecastRun }) {
  const m = run.metrics
  const d = run.details
  const bias = describeBias(m.bias, d.profile?.mean)
  const BiasIcon = bias.icon
  const noMetrics = m.mae == null && m.rmse == null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Model &amp; accuracy</CardTitle>
        <CardDescription>
          Measured by backtesting on the most recent {m.holdout_days ? `${m.holdout_days} days` : 'history'} the model did not see.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="text-sm">{modelLabel(run.model_name)}</Badge>
          <span className="font-mono text-xs text-muted-foreground">v{run.model_version}</span>
          <Badge variant={d.selection === 'explicit' ? 'muted' : d.selection === 'auto' ? 'info' : 'warning'}>
            {d.selection === 'explicit' ? 'Chosen manually' : d.selection === 'auto' ? 'Auto-selected' : fmt.label(d.selection ?? 'baseline')}
          </Badge>
        </div>
        {noMetrics ? (
          <p className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            Not enough history to backtest this item, so accuracy can’t be measured yet. A moving-average baseline is used.
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-3">
            <Metric label="MAE" value={fmt.num(m.mae)} hint="units / day" help={METRIC_HELP.mae} />
            <Metric label="RMSE" value={fmt.num(m.rmse)} hint="units / day" help={METRIC_HELP.rmse} />
            <Metric label="WAPE" value={fmt.pct(m.wape)} hint="of total demand" help={METRIC_HELP.wape} />
            <Metric label="MAPE" value={fmt.pct(m.mape)} hint="non-zero days only" help={METRIC_HELP.mape} />
          </dl>
        )}
        <div className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-sm', bias.tone === 'warn' && 'border-amber-500/40 bg-amber-500/5')}>
          <BiasIcon className={cn('size-4 shrink-0', bias.tone === 'good' ? 'text-emerald-600' : bias.tone === 'warn' ? 'text-amber-600' : 'text-muted-foreground')} aria-hidden />
          <span className="flex-1">
            <span className="text-muted-foreground">Bias: </span>
            <span className="font-medium">{bias.text}</span>
          </span>
          <InfoTip text={METRIC_HELP.bias} label="bias" />
        </div>
        <dl className="divide-y border-t">
          <Detail label="Generated">
            <span title={fmt.dateTime(run.generated_at)}>{fmt.relative(run.generated_at)}</span>
          </Detail>
          <Detail label="Training history">
            {run.history_days} days
            {run.history_start && (
              <span className="block text-xs font-normal text-muted-foreground">
                {fmt.date(run.history_start)} – {fmt.date(run.history_end)}
              </span>
            )}
          </Detail>
          <Detail label="Horizon">{run.horizon_days} days</Detail>
          <Detail label="Total predicted">{fmt.num(run.total_predicted)} units</Detail>
          <Detail label="Average per day">{fmt.num(run.avg_daily_demand)} units</Detail>
          {d.interval && (
            <Detail label="Prediction interval">
              {Math.round(d.interval.level * 100)}%
              <span className="block text-xs font-normal text-muted-foreground">{d.interval.method}</span>
            </Detail>
          )}
        </dl>
      </CardContent>
    </Card>
  )
}

type Candidate = ForecastMetrics & { error?: string }

export function CandidatesCard({ run }: { run: ForecastRun }) {
  const cands = Object.entries(run.details.candidates ?? {}) as Array<[string, Candidate]>
  const metric = (run.details.selection_metric ?? 'mae') as 'mae' | 'rmse'
  const valid = cands.filter(([, c]) => !c.error && c[metric] != null)
  const max = Math.max(...valid.map(([, c]) => Number(c[metric])), 0.0001)
  const best = valid.length ? Math.min(...valid.map(([, c]) => Number(c[metric]))) : null
  const sorted = [...cands].sort(([, a], [, b]) => (a.error ? 1 : b.error ? -1 : Number(a[metric]) - Number(b[metric])))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model comparison</CardTitle>
        <CardDescription>
          {run.details.selection === 'explicit'
            ? 'A single model was requested, so only it was backtested.'
            : `Candidates backtested on the same holdout; lowest ${metric.toUpperCase()} wins.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {cands.length === 0 ? (
          <p className="text-sm text-muted-foreground">No candidate comparison is available for this run (insufficient history to backtest).</p>
        ) : (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Candidate model backtest errors</caption>
              <thead>
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-1 pb-2 text-left font-medium">Model</th>
                  <th scope="col" className="px-1 pb-2 text-right font-medium">MAE</th>
                  <th scope="col" className="px-1 pb-2 text-right font-medium">RMSE</th>
                  <th scope="col" className="px-1 pb-2 text-right font-medium">WAPE</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(([name, c]) => {
                  const selected = name === run.model_name
                  return (
                    <tr key={name} className={cn('border-t align-top', selected && 'bg-primary/5')}>
                      <td className="px-1 py-2">
                        <div className="flex items-center gap-1.5 font-medium">
                          {modelLabel(name)}
                          {selected && (
                            <Badge variant="success" className="px-1.5">
                              <CheckCircle2 aria-hidden /> Selected
                            </Badge>
                          )}
                        </div>
                        {c.error ? (
                          <p className="mt-1 flex items-start gap-1 text-xs text-destructive">
                            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                            <span className="break-words">Failed: {c.error}</span>
                          </p>
                        ) : (
                          <div className="mt-1.5 h-1.5 w-full max-w-40 rounded-full bg-muted" aria-hidden>
                            <div
                              className={cn('h-full rounded-full', selected ? 'bg-[var(--chart-1)]' : 'bg-muted-foreground/40')}
                              style={{ width: `${(Number(c[metric]) / max) * 100}%` }}
                            />
                          </div>
                        )}
                      </td>
                      {(['mae', 'rmse', 'wape'] as const).map((k) => (
                        <td
                          key={k}
                          className={cn(
                            'px-1 py-2 text-right tabular',
                            k === metric && c[k] != null && Number(c[k]) === best ? 'font-semibold text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {c.error ? '—' : k === 'wape' ? fmt.pct(c[k]) : fmt.num(c[k])}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {run.details.selection_metric && run.details.selection !== 'explicit' && (
          <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {SELECTION_METRIC_HELP[run.details.selection_metric] ?? `Selection metric: ${run.details.selection_metric.toUpperCase()}.`}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export function DemandProfileCard({ run }: { run: ForecastRun }) {
  const p = run.details.profile
  const bt = run.details.backtest
  const pattern = p ? (PATTERN_META[p.pattern] ?? { label: fmt.label(p.pattern), description: '', variant: 'muted' as const }) : null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Demand profile &amp; backtest</CardTitle>
        <CardDescription>How this item sells and how the forecast was validated.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pattern && p ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant={pattern.variant} className="text-sm">
                {pattern.label}
              </Badge>
              <span className="text-xs text-muted-foreground">demand pattern</span>
            </div>
            <p className="text-sm text-muted-foreground">{pattern.description}</p>
            <div>
              <div className="mb-1 flex justify-between text-xs">
                <span className="text-muted-foreground">Days with zero sales</span>
                <span className="font-medium tabular">{fmt.pct(p.zero_ratio)}</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted" aria-hidden>
                <div className="h-full rounded-full bg-[var(--chart-1)]" style={{ width: `${Math.min(100, p.zero_ratio * 100)}%` }} />
              </div>
            </div>
            <dl className="grid grid-cols-3 gap-2 pt-1 text-center">
              <div className="rounded-lg border p-2">
                <dt className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
                  Mean/day
                </dt>
                <dd className="font-semibold tabular">{fmt.num(p.mean)}</dd>
              </div>
              <div className="rounded-lg border p-2">
                <dt className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
                  ADI <InfoTip label="ADI" text="Average Demand Interval: average number of days between non-zero sales. Above 1.32 suggests intermittent demand." />
                </dt>
                <dd className="font-semibold tabular">{fmt.num(p.adi)}</dd>
              </div>
              <div className="rounded-lg border p-2">
                <dt className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
                  CV² <InfoTip label="CV squared" text="Squared coefficient of variation of non-zero order sizes. Above 0.49 means sizes vary a lot (erratic / lumpy)." />
                </dt>
                <dd className="font-semibold tabular">{fmt.num(p.cv2)}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No demand profile recorded for this run.</p>
        )}
        <div className="rounded-lg border p-3">
          <p className="text-xs font-medium text-muted-foreground">Rolling-origin backtest</p>
          {bt ? (
            <>
              <p className="mt-1 text-lg font-semibold tabular">
                {bt.folds} × {bt.fold_days} days
              </p>
              <p className="text-xs text-muted-foreground">
                {bt.folds} forecast origin{bt.folds === 1 ? '' : 's'}, each predicting the next {bt.fold_days} days — {bt.evaluated_days} days evaluated in total.
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">Not backtested (insufficient history).</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
