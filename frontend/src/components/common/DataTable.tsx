import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn, fmt } from '@/lib/utils'
import { EmptyState, ErrorState, TableSkeleton } from './States'

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** Backend sort field; enables a clickable sortable header. */
  sortKey?: string
  className?: string
  headerClassName?: string
  align?: 'left' | 'right' | 'center'
  /** Hide on small screens to keep tables usable on mobile. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl' | '2xl'
}

interface DataTableProps<T> {
  columns: Column<T>[]
  rows: T[] | undefined
  rowKey: (row: T) => string | number
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  sort?: string
  onSortChange?: (sort: string) => void
  onRowClick?: (row: T) => void
  empty?: ReactNode
  page?: number
  pageSize?: number
  total?: number
  onPageChange?: (page: number) => void
  onPageSizeChange?: (size: number) => void
  caption?: string
}

const HIDE = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell', xl: 'hidden xl:table-cell', '2xl': 'hidden 2xl:table-cell' }
const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' }

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  sort,
  onSortChange,
  onRowClick,
  empty,
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  caption,
}: DataTableProps<T>) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />
  if (loading && !rows) return <TableSkeleton cols={Math.min(columns.length, 6)} />
  if (rows && rows.length === 0) return <>{empty ?? <EmptyState title="No results" description="Try adjusting your filters." />}</>

  const toggleSort = (key: string) => {
    if (!onSortChange) return
    onSortChange(sort === key ? `-${key}` : key)
  }

  return (
    <div className={cn(loading && 'opacity-60 transition-opacity')}>
      <Table>
        {caption && <caption className="sr-only">{caption}</caption>}
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((c) => {
              const active = sort === c.sortKey || sort === `-${c.sortKey}`
              const desc = sort === `-${c.sortKey}`
              return (
                <TableHead
                  key={c.key}
                  className={cn(c.hideBelow && HIDE[c.hideBelow], c.align && ALIGN[c.align], c.headerClassName)}
                  aria-sort={active ? (desc ? 'descending' : 'ascending') : undefined}
                >
                  {c.sortKey && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.sortKey!)}
                      className={cn(
                        'inline-flex cursor-pointer items-center gap-1 uppercase hover:text-foreground',
                        active && 'text-foreground',
                        c.align === 'right' && 'flex-row-reverse',
                      )}
                    >
                      {c.header}
                      {active ? desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" /> : <ArrowUpDown className="size-3 opacity-40" />}
                    </button>
                  ) : (
                    c.header
                  )}
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows?.map((row) => (
            <TableRow
              key={rowKey(row)}
              className={cn(onRowClick && 'cursor-pointer')}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      // Only when the row itself has focus, so nested buttons/checkboxes keep their own keys.
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onRowClick(row)
                      }
                    }
                  : undefined
              }
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((c) => (
                <TableCell key={c.key} className={cn(c.hideBelow && HIDE[c.hideBelow], c.align && ALIGN[c.align], c.className)}>
                  {c.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {page != null && pageSize != null && total != null && onPageChange && (
        <Pagination page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} />
      )}
    </div>
  )
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (p: number) => void
  onPageSizeChange?: (s: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t px-4 py-3 text-sm sm:flex-row">
      <p className="text-muted-foreground">
        Showing <span className="font-medium text-foreground">{fmt.int(from)}</span>–
        <span className="font-medium text-foreground">{fmt.int(to)}</span> of{' '}
        <span className="font-medium text-foreground">{fmt.int(total)}</span>
      </p>
      <div className="flex items-center gap-2">
        {onPageSizeChange && (
          <NativeSelect
            aria-label="Rows per page"
            className="h-8 w-28"
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </NativeSelect>
        )}
        <Button variant="outline" size="icon-sm" onClick={() => onPageChange(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="tabular min-w-16 text-center text-muted-foreground">
          {page} / {pages}
        </span>
        <Button variant="outline" size="icon-sm" onClick={() => onPageChange(page + 1)} disabled={page >= pages} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}
