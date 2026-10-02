import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** The subset of a TanStack query result needed to report and retry a failed lookup. */
export interface LookupQuery {
  error: unknown
  refetch: () => unknown
  isFetching?: boolean
}

/**
 * Compact notice for failed filter/picker lookups (warehouses, suppliers, categories…).
 * Renders nothing while every lookup is fine; otherwise names what failed and offers a retry.
 */
export function LookupError({
  lookups,
  context = 'for the filters',
  className,
}: {
  lookups: Record<string, LookupQuery | undefined>
  /** Trailing phrase, e.g. "for the filters" or "" for none. */
  context?: string
  className?: string
}) {
  const failed = Object.entries(lookups).filter((e): e is [string, LookupQuery] => !!e[1]?.error)
  if (failed.length === 0) return null
  const names = failed.map(([name]) => name)
  const label = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  const busy = failed.some(([, q]) => q.isFetching)
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-sm text-destructive',
        className,
      )}
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      <span>
        Couldn&apos;t load {label}
        {context ? ` ${context}` : ''}.
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-destructive hover:text-destructive"
        loading={busy}
        onClick={() => failed.forEach(([, q]) => void q.refetch())}
      >
        {!busy && <RefreshCw />} Retry
      </Button>
    </div>
  )
}

/** Disabled placeholder option shown inside a select whose options failed to load. */
export function LookupFailedOption({ query, label = 'Couldn’t load — retry' }: { query: LookupQuery | undefined; label?: string }) {
  if (!query?.error) return null
  return (
    <option value="__lookup_error__" disabled>
      {label}
    </option>
  )
}
