import { TrendingDown, TrendingUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface KpiCardProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon: ReactNode
  tone?: 'default' | 'warning' | 'danger' | 'success'
  change?: number | null
  to?: string
}

const TONES = {
  default: 'bg-primary/10 text-primary',
  warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  danger: 'bg-red-500/12 text-red-600 dark:text-red-400',
  success: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
}

export function KpiCard({ label, value, hint, icon, tone = 'default', change, to }: KpiCardProps) {
  const body = (
    <Card className={cn('h-full p-5 transition-shadow', to && 'hover:shadow-md')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight tabular">{value}</p>
        </div>
        <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5', TONES[tone])}>{icon}</div>
      </div>
      {(hint || change != null) && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          {change != null && (
            <span className={cn('inline-flex items-center gap-0.5 font-medium', change >= 0 ? 'text-emerald-600' : 'text-red-600')}>
              {change >= 0 ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
              {change > 0 ? '+' : ''}
              {change.toFixed(1)}%
            </span>
          )}
          {hint}
        </div>
      )}
    </Card>
  )
  return to ? (
    <Link to={to} className="block rounded-xl focus-visible:outline-2 focus-visible:outline-ring">
      {body}
    </Link>
  ) : (
    body
  )
}
