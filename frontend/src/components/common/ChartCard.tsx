import type { ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export function ChartCard({
  title,
  description,
  action,
  loading,
  className,
  height = 280,
  children,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  loading?: boolean
  className?: string
  height?: number
  children: ReactNode
}) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div className="grid gap-1">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {action}
      </CardHeader>
      <CardContent className="flex-1">
        {loading ? <Skeleton style={{ height }} className="w-full" /> : <div style={{ height }}>{children}</div>}
      </CardContent>
    </Card>
  )
}

/** Shared Recharts styling so every chart looks consistent. */
export const chartTheme = {
  grid: 'var(--border)',
  axis: { fontSize: 12, fill: 'var(--muted-foreground)' },
  tooltip: {
    contentStyle: {
      background: 'var(--popover)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      fontSize: 12,
      color: 'var(--popover-foreground)',
      boxShadow: '0 4px 12px rgb(0 0 0 / 0.08)',
    },
    labelStyle: { fontWeight: 600, marginBottom: 4 },
  },
  colors: ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'],
}
