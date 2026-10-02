import { type ReactNode, useMemo } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from 'recharts'
import { chartTheme } from '@/components/common/ChartCard'
import type { ForecastWithHistory } from '@/lib/types'
import { fmt } from '@/lib/utils'
import { buildChartRows, type ChartRow } from './lib'


function ChartTooltip({ active, payload, label }: Partial<TooltipContentProps<number, string>>) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload as ChartRow
  const isForecast = row.forecast != null
  return (
    <div style={chartTheme.tooltip.contentStyle} className="min-w-44 px-3 py-2">
      <p className="mb-1.5 flex items-center justify-between gap-3 font-semibold">
        {fmt.date(String(label))}
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{isForecast ? 'Predicted' : 'Actual'}</span>
      </p>
      {row.actual != null && (
        <Row swatch={<Swatch kind="actual" />} label="Actual demand" value={`${fmt.int(row.actual)} units`} />
      )}
      {row.ma7 != null && <Row swatch={<Swatch kind="ma" />} label="7-day average" value={fmt.num(row.ma7)} />}
      {isForecast && (
        <>
          <Row swatch={<Swatch kind="forecast" />} label="Forecast" value={`${fmt.num(row.forecast)} units`} />
          {row.band && (
            <Row swatch={<Swatch kind="band" />} label="80% interval" value={`${fmt.num(row.band[0])} – ${fmt.num(row.band[1])}`} />
          )}
        </>
      )}
    </div>
  )
}

function Row({ swatch, label, value }: { swatch: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="flex items-center gap-2 text-muted-foreground">
        {swatch}
        {label}
      </span>
      <span className="font-medium tabular text-foreground">{value}</span>
    </div>
  )
}

/** Small legend glyphs that mirror how each series is drawn. */
export function Swatch({ kind }: { kind: 'actual' | 'ma' | 'forecast' | 'band' }) {
  if (kind === 'band')
    return <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: 'var(--chart-2)', opacity: 0.22 }} aria-hidden />
  const color = kind === 'actual' ? 'var(--chart-1)' : kind === 'ma' ? 'var(--chart-3)' : 'var(--chart-2)'
  return (
    <svg width="18" height="8" aria-hidden className="shrink-0">
      <line
        x1="1"
        y1="4"
        x2="17"
        y2="4"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={kind === 'forecast' ? '4 3' : kind === 'ma' ? '1 3' : undefined}
      />
    </svg>
  )
}

export function ChartLegend({ showMa, hasForecast }: { showMa: boolean; hasForecast: boolean }) {
  const items: Array<{ kind: 'actual' | 'ma' | 'forecast' | 'band'; label: string }> = [{ kind: 'actual', label: 'Actual' }]
  if (showMa) items.push({ kind: 'ma', label: '7-day average' })
  if (hasForecast) items.push({ kind: 'forecast', label: 'Forecast' }, { kind: 'band', label: '80% interval' })
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Chart legend">
      {items.map((i) => (
        <li key={i.kind} className="flex items-center gap-1.5">
          <Swatch kind={i.kind} />
          {i.label}
        </li>
      ))}
    </ul>
  )
}

export function ForecastChart({ data, showMa, height = 340 }: { data: ForecastWithHistory; showMa: boolean; height?: number }) {
  const rows = useMemo(() => buildChartRows(data, showMa), [data, showMa])
  const firstForecast = rows.find((r) => r.forecast != null)?.date
  const lastDate = rows.at(-1)?.date
  const span = rows.length

  return (
    <div style={{ height }} role="img" aria-label="Daily demand history with forecast and 80% prediction interval">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 20, right: 12, left: -8, bottom: 0 }}>
          <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
          {firstForecast && lastDate && (
            <ReferenceArea x1={firstForecast} x2={lastDate} fill="var(--muted)" fillOpacity={0.6} stroke="none" ifOverflow="extendDomain" label={{ value: 'Forecast', position: 'insideTopRight', fill: 'var(--muted-foreground)', fontSize: 11, dy: -18 }} />
          )}
          <XAxis
            dataKey="date"
            tickFormatter={fmt.shortDate}
            tick={chartTheme.axis}
            tickLine={false}
            axisLine={false}
            minTickGap={span > 200 ? 48 : 28}
          />
          <YAxis tick={chartTheme.axis} tickLine={false} axisLine={false} width={48} allowDecimals={false} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 3' }} />
          <Area
            dataKey="band"
            stroke="none"
            fill="var(--chart-2)"
            fillOpacity={0.18}
            activeDot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            dataKey="actual"
            stroke="var(--chart-1)"
            strokeWidth={1.75}
            dot={false}
            activeDot={{ r: 4 }}
            animationDuration={500}
            connectNulls={false}
          />
          {showMa && (
            <Line dataKey="ma7" stroke="var(--chart-3)" strokeWidth={2} strokeDasharray="1 3" strokeLinecap="round" dot={false} activeDot={false} animationDuration={500} />
          )}
          <Line
            dataKey="forecast"
            stroke="var(--chart-2)"
            strokeWidth={2.25}
            strokeDasharray="6 4"
            dot={false}
            activeDot={{ r: 4 }}
            animationDuration={500}
            connectNulls={false}
          />
          {firstForecast && (
            <ReferenceLine
              x={firstForecast}
              stroke="var(--foreground)"
              strokeOpacity={0.55}
              strokeDasharray="2 2"
              label={{ value: 'Today', position: 'insideTopLeft', fill: 'var(--muted-foreground)', fontSize: 11, dy: -18 }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
