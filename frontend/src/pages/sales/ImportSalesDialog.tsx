import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Download, FileSpreadsheet, Upload, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAllProducts, useAllWarehouses, useJob, useMeta } from '@/api/queries'
import { InlineError } from '@/components/common/States'
import { JobStatusBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import type { ImportResult, Job } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'

const SALES_CSV_COLUMNS = ['sku', 'warehouse_code', 'sold_at', 'quantity', 'order_reference', 'unit_price']
/** Used until GET /meta answers; the server enforces its own limit (413 FILE_TOO_LARGE) either way. */
const FALLBACK_MAX_MB = 50

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function ImportSalesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const products = useAllProducts()
  const warehouses = useAllWarehouses()
  const meta = useMeta()
  const maxMb = meta.data?.max_import_file_mb ?? FALLBACK_MAX_MB
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const job = useJob(jobId)
  const status = job.data?.status
  const done = status === 'SUCCEEDED' || status === 'FAILED'
  const result = status === 'SUCCEEDED' ? (job.data?.result as unknown as ImportResult | null) : null

  useEffect(() => {
    if (open) {
      setFile(null)
      setFileError(null)
      setJobId(null)
      upload.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // New sales change history-based figures everywhere.
  useEffect(() => {
    if (status === 'SUCCEEDED') [['sales'], ['reports'], ['dashboard'], ['forecasts'], ['shortages'], ['restocking'], ['jobs']].forEach((key) => qc.invalidateQueries({ queryKey: key }))
  }, [status, qc])

  const upload = useMutation({
    mutationFn: (f: File) => {
      const fd = new FormData()
      fd.append('file', f, f.name)
      return api.post<Job>('/sales/import', fd)
    },
    onSuccess: (j) => setJobId(j.id),
  })

  const pick = (f: File | null) => {
    setFileError(null)
    upload.reset()
    if (!f) return setFile(null)
    if (!f.name.toLowerCase().endsWith('.csv')) {
      setFile(null)
      return setFileError('Choose a .csv file')
    }
    if (f.size === 0) {
      setFile(null)
      return setFileError('This file is empty')
    }
    if (f.size > maxMb * 1024 * 1024) {
      setFile(null)
      return setFileError(`Files can be at most ${maxMb} MB`)
    }
    setFile(f)
  }

  const downloadTemplate = () => {
    const sku = products.data?.[0]?.sku ?? 'SKU-123'
    const wh = warehouses.data?.[0]?.code ?? 'WH-CODE'
    // Yesterday: a date-only sold_at is read as 12:00 UTC, so "today" can still be in the future server-side.
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const csv = `${SALES_CSV_COLUMNS.join(',')}\n${sku},${wh},${day},1,SO-EXAMPLE-1,\n${sku},${wh},${day}T14:30:00Z,2,SO-EXAMPLE-2,19.99\n`
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'sales-import-template.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const failedDetails = status === 'FAILED' ? (job.data?.result as { code?: string; details?: unknown } | null) : null
  const details = failedDetails?.details
  const running = !!jobId && !done

  return (
    <Dialog open={open} onOpenChange={(o) => !upload.isPending && onOpenChange(o)}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Import sales from CSV</DialogTitle>
          <DialogDescription>Bulk-load order history. Rows already imported are skipped, so re-uploading a file is safe.</DialogDescription>
        </DialogHeader>

        {!jobId && (
          <>
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">Expected columns</p>
                <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={downloadTemplate}>
                  <Download /> Download template
                </Button>
              </div>
              <p className="mt-1.5 break-all font-mono text-xs">
                sku,warehouse_code,sold_at,quantity,order_reference<span className="text-muted-foreground">[,unit_price]</span>
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                <span className="font-mono">sold_at</span> is an ISO date or date-time (e.g. 2026-09-30 or 2026-09-30T14:30:00Z). Unit price defaults to the
                product list price. Date-only values are read as 12:00 UTC and future times are rejected. Imported sales are history only and don't change current stock.
              </p>
            </div>

            <label
              htmlFor="sales-file"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                pick(e.dataTransfer.files?.[0] ?? null)
              }}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition hover:border-primary/50 hover:bg-primary/5',
                file && 'border-primary/40 bg-primary/5',
                fileError && 'border-destructive/50',
              )}
            >
              <FileSpreadsheet className="size-8 text-muted-foreground" aria-hidden />
              {file ? (
                <span className="text-sm">
                  <span className="font-medium">{file.name}</span> <span className="text-muted-foreground">· {formatBytes(file.size)}</span>
                </span>
              ) : (
                <span className="text-sm">
                  <span className="font-medium text-primary">Choose a CSV file</span> <span className="text-muted-foreground">or drag it here (max {maxMb} MB)</span>
                </span>
              )}
              <input
                ref={inputRef}
                id="sales-file"
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-describedby={fileError ? 'sales-file-error' : undefined}
                onChange={(e) => pick(e.target.files?.[0] ?? null)}
              />
            </label>
            {fileError && (
              <p id="sales-file-error" role="alert" className="-mt-2 text-xs font-medium text-destructive">
                {fileError}
              </p>
            )}
            <InlineError error={upload.error} />
          </>
        )}

        {jobId && (
          <div className="grid gap-4" aria-live="polite">
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-sm">
                <span className="font-medium">{file?.name}</span>
              </p>
              {job.data && <JobStatusBadge status={job.data.status} />}
            </div>
            {!done && (
              <div className="grid gap-1.5">
                <Progress value={job.data?.progress ?? 0} label="Import progress" />
                <p className="text-xs text-muted-foreground">
                  {status === 'RUNNING' ? `Importing… ${job.data?.progress ?? 0}%` : 'Queued — waiting for a worker…'} You can close this dialog; the import keeps running.
                </p>
              </div>
            )}
            <InlineError error={job.error} />

            {result && (
              <>
                <div
                  className={cn(
                    'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm',
                    result.inserted ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5',
                  )}
                >
                  <CheckCircle2 className={cn('mt-0.5 size-4 shrink-0', result.inserted ? 'text-emerald-600' : 'text-amber-600')} aria-hidden />
                  <span>
                    {result.inserted ? (
                      <>
                        Imported <strong>{fmt.int(result.inserted)}</strong> new sale{result.inserted === 1 ? '' : 's'} from {fmt.int(result.total_rows)} row
                        {result.total_rows === 1 ? '' : 's'}.
                      </>
                    ) : result.duplicates && !result.invalid ? (
                      'No new sales — every row had already been imported.'
                    ) : (
                      'No new sales were imported. Fix the rows below and upload the file again.'
                    )}
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    ['Rows read', result.total_rows, ''],
                    ['Inserted', result.inserted, 'text-emerald-600 dark:text-emerald-400'],
                    ['Duplicates skipped', result.duplicates, ''],
                    ['Invalid', result.invalid, result.invalid ? 'text-red-600 dark:text-red-400' : ''],
                  ].map(([label, value, cls]) => (
                    <div key={label as string} className="rounded-lg border p-3">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className={cn('mt-0.5 text-xl font-semibold tabular', cls as string)}>{fmt.int(value as number)}</dd>
                    </div>
                  ))}
                </dl>
                {result.errors.length > 0 && (
                  <div className="overflow-hidden rounded-lg border">
                    <p className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">
                      Rows that were skipped{result.errors_truncated ? ` (first ${result.errors.length} of ${fmt.int(result.invalid)})` : ''}
                    </p>
                    <div className="max-h-56 overflow-y-auto">
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="w-16">Line</TableHead>
                            <TableHead>Error</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {result.errors.map((err, i) => (
                            <TableRow key={`${err.line}-${i}`}>
                              <TableCell className="font-mono text-xs tabular">{err.line}</TableCell>
                              <TableCell className="text-sm">{err.error}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </>
            )}

            {status === 'FAILED' && (
              <div role="alert" className="grid gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm">
                <p className="flex items-start gap-2 font-medium text-destructive">
                  <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {job.data?.error ?? 'The import failed.'}
                </p>
                {details != null && typeof details === 'object' && (
                  <dl className="grid gap-1 pl-6 text-xs text-muted-foreground">
                    {Object.entries(details as Record<string, unknown>).map(([k, v]) => (
                      <div key={k} className="flex flex-wrap gap-1.5">
                        <dt className="font-medium text-foreground">{k.replace(/_/g, ' ')}:</dt>
                        <dd className="font-mono">{Array.isArray(v) ? v.join(', ') : String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {!jobId ? (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={upload.isPending}>
                Cancel
              </Button>
              <Button type="button" disabled={!file} loading={upload.isPending} onClick={() => file && upload.mutate(file)}>
                {!upload.isPending && <Upload />} Upload & import
              </Button>
            </>
          ) : (
            <>
              {done && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setJobId(null)
                    setFile(null)
                    upload.reset()
                    if (inputRef.current) inputRef.current.value = ''
                  }}
                >
                  Import another file
                </Button>
              )}
              <Button type="button" variant={running ? 'outline' : 'default'} onClick={() => onOpenChange(false)}>
                {running ? 'Close (keeps running)' : 'Done'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
