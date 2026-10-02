import { Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** Debounced search box (keeps typing snappy, avoids a request per keystroke). */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  className,
  delay = 300,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  delay?: number
}) {
  const [local, setLocal] = useState(value)
  const [synced, setSynced] = useState(value)
  // Adopt external changes (e.g. "clear filters") during render instead of in an effect.
  if (value !== synced) {
    setSynced(value)
    setLocal(value)
  }
  useEffect(() => {
    if (local === value) return
    const t = setTimeout(() => onChange(local), delay)
    return () => clearTimeout(t)
  }, [local, value, delay, onChange])
  return (
    <div className={cn('relative w-full sm:w-64', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        className="pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden"
      />
      {local && (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => {
            setLocal('')
            onChange('')
          }}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
