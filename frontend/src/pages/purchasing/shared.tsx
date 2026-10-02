/**
 * Small helpers shared by the purchasing, sales, stock-risk and restocking pages.
 * (Kept local to these pages; generic app-wide primitives live in components/.)
 */
import { Download, Info } from 'lucide-react'
import { forwardRef, type InputHTMLAttributes, type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { downloadCsv, errorMessage, type Query } from '@/lib/api'
import { cn } from '@/lib/utils'

/** CSV export button with loading state and error toast. */
export function ExportCsvButton({ path, query, size, label = 'Export CSV' }: { path: string; query: Query; size?: 'sm' | 'default'; label?: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="outline"
      size={size}
      loading={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await downloadCsv(path, query, `${path.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'export'}.csv`)
        } catch (e) {
          toast.error('Export failed', { description: errorMessage(e) })
        } finally {
          setBusy(false)
        }
      }}
    >
      {!busy && <Download />} {label}
    </Button>
  )
}

/** Accessible native checkbox styled to match the design system. */
export const Checkbox = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { indeterminate?: boolean }>(
  ({ className, indeterminate, ...props }, ref) => (
    <input
      type="checkbox"
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate
        if (typeof ref === 'function') ref(el)
        else if (ref) ref.current = el
      }}
      className={cn(
        'size-4 shrink-0 cursor-pointer rounded border-input accent-[var(--primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...props}
    />
  ),
)
Checkbox.displayName = 'Checkbox'

/** Informational callout (tips, explanations of how numbers are computed). */
export function InfoCallout({ children, className, tone = 'info', icon }: { children: ReactNode; className?: string; tone?: 'info' | 'warning' | 'success'; icon?: ReactNode }) {
  const tones = {
    info: 'border-sky-500/25 bg-sky-500/5 text-sky-900 dark:text-sky-200',
    warning: 'border-amber-500/30 bg-amber-500/5 text-amber-900 dark:text-amber-200',
    success: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-900 dark:text-emerald-200',
  }
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm', tones[tone], className)}>
      <span className="mt-0.5 shrink-0 [&_svg]:size-4" aria-hidden>
        {icon ?? <Info />}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Pair of date inputs for "from / to" filters. */
export function DateRangeFilter({
  from,
  to,
  onChange,
  className,
  labelPrefix = 'Date',
}: {
  from: string
  to: string
  onChange: (patch: { date_from?: string; date_to?: string }) => void
  className?: string
  labelPrefix?: string
}) {
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <Input
        type="date"
        aria-label={`${labelPrefix} from`}
        value={from}
        max={to || undefined}
        onChange={(e) => onChange({ date_from: e.target.value })}
        className="min-w-0 lg:w-[9.5rem]"
      />
      <span className="text-xs text-muted-foreground" aria-hidden>
        –
      </span>
      <Input
        type="date"
        aria-label={`${labelPrefix} to`}
        value={to}
        min={from || undefined}
        onChange={(e) => onChange({ date_to: e.target.value })}
        className="min-w-0 lg:w-[9.5rem]"
      />
    </div>
  )
}

/** Unit-progress bar (received vs ordered etc.). */
export function MiniProgress({ value, max, className, label }: { value: number; max: number; className?: string; label?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <div className={cn('h-full rounded-full transition-all', pct >= 100 ? 'bg-emerald-500' : 'bg-primary')} style={{ width: `${pct}%` }} />
    </div>
  )
}

