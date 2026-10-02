import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { qk } from '@/api/queries'
import { Pagination } from '@/components/common/DataTable'
import { EmptyState, ErrorState, TableSkeleton } from '@/components/common/States'
import { JobStatusBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { useUrlState } from '@/lib/hooks'
import type { Job, Page } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { modelLabel } from '../forecasting/meta'
import { jobDuration } from '../forecasting/useTrackedJob'

const DEFAULTS = { j_page: 1, j_size: 25, j_type: '', j_status: '' }
const TYPE_LABEL: Record<string, string> = { FORECAST_ITEM: 'Item forecast', FORECAST_ALL: 'Re-forecast all', IMPORT_SALES: 'Sales import' }

function paramsSummary(j: Job): string {
  const p = j.params as Record<string, unknown>
  if (j.type === 'FORECAST_ITEM') return `Product #${p.product_id} · warehouse #${p.warehouse_id} · ${p.horizon_days}d · ${modelLabel(String(p.model ?? 'auto'))}`
  if (j.type === 'FORECAST_ALL') return `${p.horizon_days}-day horizon · ${p.warehouse_id ? `warehouse #${p.warehouse_id}` : 'all warehouses'}`
  if (j.type === 'IMPORT_SALES') return String(p.filename ?? p.file_name ?? 'CSV upload')
  return ''
}

function ResultDetail({ job }: { job: Job }) {
  const r = (job.result ?? {}) as Record<string, unknown>
  const p = job.params as Record<string, unknown>
  return (
    <div className="grid gap-4 py-2 md:grid-cols-2">
      <div className="space-y-2 text-sm">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Timeline</h4>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Created</dt>
          <dd>{fmt.dateTime(job.created_at)}</dd>
          <dt className="text-muted-foreground">Started</dt>
          <dd>{fmt.dateTime(job.started_at)}</dd>
          <dt className="text-muted-foreground">Finished</dt>
          <dd>{fmt.dateTime(job.finished_at)}</dd>
          <dt className="text-muted-foreground">Job ID</dt>
          <dd className="break-all font-mono text-xs">{job.id}</dd>
        </dl>
        {job.type === 'FORECAST_ITEM' && job.status === 'SUCCEEDED' && (
          <Button variant="outline" size="sm" asChild>
            <Link to={`/forecasting?product_id=${p.product_id}&warehouse_id=${p.warehouse_id}`}>View forecast</Link>
          </Button>
        )}
      </div>
      <div className="min-w-0 space-y-2 text-sm">
        {job.error ? (
          <>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-destructive">Error</h4>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{job.error}</pre>
          </>
        ) : job.result ? (
          <>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Result</h4>
            {job.type === 'FORECAST_ALL' ? (
              <p>
                {fmt.int(r.items as number)} items · <span className="text-emerald-700 dark:text-emerald-400">{fmt.int(r.succeeded as number)} succeeded</span> ·{' '}
                <span className={r.failed ? 'text-destructive' : 'text-muted-foreground'}>{fmt.int(r.failed as number)} failed</span>
              </p>
            ) : job.type === 'FORECAST_ITEM' ? (
              <p>
                {modelLabel(String(r.model_name))} · {fmt.num(r.total_predicted as number)} units predicted
              </p>
            ) : null}
            <pre className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">{JSON.stringify(job.result, null, 2)}</pre>
          </>
        ) : (
          <p className="text-muted-foreground">No result yet.</p>
        )}
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Parameters</summary>
          <pre className="mt-1 overflow-auto rounded-md border bg-muted/40 p-3">{JSON.stringify(job.params, null, 2)}</pre>
        </details>
      </div>
    </div>
  )
}

export function JobsTab() {
  const [f, setF] = useUrlState(DEFAULTS)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const query = { page: f.j_page, page_size: f.j_size, type: f.j_type, status: f.j_status }
  const q = useQuery({
    queryKey: qk.jobs(query),
    queryFn: ({ signal }) => api.get<Page<Job>>('/jobs', query, signal),
    placeholderData: keepPreviousData,
    // Keep the list live while anything is still queued or running.
    refetchInterval: (qq) => (qq.state.data?.items.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING') ? 2000 : false),
  })
  const live = q.data?.items.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING')
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            Background jobs
            {live && (
              <span className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                <span className="size-2 animate-pulse rounded-full bg-sky-500" aria-hidden /> Live
              </span>
            )}
          </CardTitle>
          <CardDescription>Forecast runs and sales imports processed by the worker.</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <NativeSelect aria-label="Job type" className="w-40" value={f.j_type} onChange={(e) => setF({ j_type: e.target.value, j_page: 1 })}>
            <option value="">All types</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect aria-label="Job status" className="w-36" value={f.j_status} onChange={(e) => setF({ j_status: e.target.value, j_page: 1 })}>
            <option value="">All statuses</option>
            {['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'].map((s) => (
              <option key={s} value={s}>
                {fmt.label(s)}
              </option>
            ))}
          </NativeSelect>
          <Button variant="outline" size="icon" aria-label="Refresh jobs" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={cn(q.isFetching && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <TableSkeleton cols={5} />
      ) : q.data.items.length === 0 ? (
        <EmptyState
          title={f.j_type || f.j_status ? 'No matching jobs' : 'No background jobs yet'}
          description="Jobs appear here when you run a forecast or import sales."
          action={
            <Button variant="outline" asChild>
              <Link to="/forecasting">Go to forecasting</Link>
            </Button>
          }
        />
      ) : (
        <>
          <Table>
            <caption className="sr-only">Background jobs</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8">
                  <span className="sr-only">Expand</span>
                </TableHead>
                <TableHead>Job</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Progress</TableHead>
                <TableHead className="hidden sm:table-cell">Created</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.items.map((j) => {
                const isOpen = open.has(j.id)
                return (
                  <Fragment key={j.id}>
                    <TableRow className="cursor-pointer" onClick={() => toggle(j.id)}>
                      <TableCell className="pr-0">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${TYPE_LABEL[j.type]} job`}
                          onClick={(e) => {
                            e.stopPropagation()
                            toggle(j.id)
                          }}
                          className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <ChevronRight className={cn('size-4 transition-transform', isOpen && 'rotate-90')} />
                        </button>
                      </TableCell>
                      <TableCell>
                        <p className="font-medium">{TYPE_LABEL[j.type] ?? j.type}</p>
                        <p className="max-w-[22rem] truncate text-xs text-muted-foreground">{paramsSummary(j)}</p>
                      </TableCell>
                      <TableCell>
                        <JobStatusBadge status={j.status} />
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="flex items-center gap-2">
                          <Progress value={j.status === 'SUCCEEDED' ? 100 : j.progress} className="w-24" label={`Progress ${j.progress}%`} />
                          <span className="w-9 text-right text-xs tabular text-muted-foreground">{j.status === 'SUCCEEDED' ? 100 : j.progress}%</span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell" title={fmt.dateTime(j.created_at)}>
                        {fmt.relative(j.created_at)}
                      </TableCell>
                      <TableCell className="hidden text-right tabular text-muted-foreground lg:table-cell">{j.started_at ? jobDuration(j) : '—'}</TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        <TableCell />
                        <TableCell colSpan={5} className="whitespace-normal">
                          <ResultDetail job={j} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
          <Pagination
            page={f.j_page}
            pageSize={f.j_size}
            total={q.data.total}
            onPageChange={(j_page) => setF({ j_page })}
            onPageSizeChange={(j_size) => setF({ j_size, j_page: 1 })}
          />
        </>
      )}
    </Card>
  )
}
