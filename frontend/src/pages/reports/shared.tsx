import { Download } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { downloadCsv, errorMessage, type Query } from '@/lib/api'
import { cn } from '@/lib/utils'


export function ExportButton({ path, query, label = 'Export CSV', fallbackName }: { path: string; query?: Query; label?: string; fallbackName?: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      loading={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await downloadCsv(path, query ?? {}, fallbackName)
          toast.success('Export downloaded')
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

/** Compact segmented control (radio-group semantics) for small option sets. */
export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string }>
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-sm">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-7 cursor-pointer whitespace-nowrap rounded-md px-2.5 font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
              active && 'bg-card text-foreground shadow-sm',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** A toolbar row above report content: filters on the left, actions on the right. */
export function Toolbar({ children, actions }: { children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      {actions && <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{actions}</div>}
    </div>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'danger' | 'warning' | 'success' }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1 text-2xl font-semibold tracking-tight tabular',
          tone === 'danger' && 'text-red-600 dark:text-red-400',
          tone === 'warning' && 'text-amber-600 dark:text-amber-400',
          tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  )
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
}

/** Plain table helper used by small report tables (non-paged). */
export function SimpleTable({ caption, head, children }: { caption: string; head: Array<{ label: string; align?: 'right'; hideBelow?: 'sm' | 'md' | 'lg' }>; children: ReactNode }) {
  const hide = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
            {head.map((h) => (
              <th key={h.label} scope="col" className={cn('h-10 px-4 font-medium', h.align === 'right' ? 'text-right' : 'text-left', h.hideBelow && hide[h.hideBelow])}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr:last-child]:border-0 [&>tr:hover]:bg-muted/40 [&_td]:px-4 [&_td]:py-2.5">{children}</tbody>
      </table>
    </div>
  )
}

