import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, ArrowLeft, Ban, Check, CheckCircle2, Pencil, Send, Trash2, Truck, X } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { qk } from '@/api/queries'
import { CardsSkeleton, EmptyState, ErrorState, TableSkeleton } from '@/components/common/States'
import { POStatusBadge } from '@/components/common/StatusBadge'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { POStatus, PurchaseOrder } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { EditDraftDialog } from './EditDraftDialog'
import { ReceiveDialog } from './ReceiveDialog'
import { MiniProgress } from './shared'
import { daysPast, isOverdue, PO_RELATED_KEYS, PO_STATUS_LABEL } from './utils'

const FLOW: POStatus[] = ['DRAFT', 'SUBMITTED', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED']

type Transition = 'SUBMITTED' | 'CONFIRMED' | 'CANCELLED' | 'RECEIVED'
const TRANSITION_META: Record<Transition, { label: string; title: string; description: string; confirm: string; destructive?: boolean }> = {
  SUBMITTED: {
    label: 'Submit to supplier',
    title: 'Submit purchase order?',
    description: 'The order is locked for editing and its quantities count as inbound stock in shortage and restocking calculations.',
    confirm: 'Submit order',
  },
  CONFIRMED: {
    label: 'Mark confirmed',
    title: 'Mark as confirmed by supplier?',
    description: 'Record that the supplier accepted the order. Goods can then be received against it.',
    confirm: 'Mark confirmed',
  },
  RECEIVED: {
    label: 'Close short',
    title: 'Close this order short?',
    description:
      'Use this when the supplier will not deliver the rest. Received goods stay in stock; the outstanding quantity stops counting as inbound and is recorded as a shortfall in supplier fill rate. This cannot be undone.',
    confirm: 'Close order',
    destructive: true,
  },
  CANCELLED: {
    label: 'Cancel order',
    title: 'Cancel this purchase order?',
    description: 'The order will no longer count as inbound stock. This cannot be undone.',
    confirm: 'Cancel order',
    destructive: true,
  },
}

/** Visual status timeline: DRAFT → SUBMITTED → CONFIRMED → PARTIALLY_RECEIVED → RECEIVED (or CANCELLED). */
function StatusTimeline({ po }: { po: PurchaseOrder }) {
  const cancelled = po.status === 'CANCELLED'
  const firstReceipt = po.receipts.length ? [...po.receipts].sort((a, b) => a.received_at.localeCompare(b.received_at))[0].received_at : null
  // When cancelled we only know for sure whether it had been submitted.
  const reachedIdx = cancelled ? (po.submitted_at ? 1 : 0) : FLOW.indexOf(po.status)
  const steps = FLOW.filter((s) => !(s === 'PARTIALLY_RECEIVED' && po.status === 'RECEIVED' && po.receipts.length <= 1))
  const dates: Partial<Record<POStatus, string | null>> = {
    DRAFT: po.order_date,
    SUBMITTED: po.submitted_at,
    PARTIALLY_RECEIVED: firstReceipt,
    RECEIVED: po.received_date,
  }
  const items: Array<{ key: string; label: string; state: 'done' | 'current' | 'todo' | 'cancelled'; date?: string | null }> = steps.map((s) => {
    const idx = FLOW.indexOf(s)
    const state = idx < reachedIdx || (idx === reachedIdx && (s === 'RECEIVED' || cancelled)) ? 'done' : idx === reachedIdx ? 'current' : 'todo'
    return { key: s, label: PO_STATUS_LABEL[s], state, date: idx <= reachedIdx ? dates[s] : null }
  })
  if (cancelled) {
    const kept = items.slice(0, reachedIdx + 1)
    items.length = 0
    items.push(...kept, { key: 'CANCELLED', label: 'Cancelled', state: 'cancelled' })
  }

  return (
    <ol aria-label="Order progress" className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-0">
      {items.map((it, i) => (
        <li key={it.key} className="relative flex items-center gap-3 sm:flex-1 sm:flex-col sm:items-center sm:gap-2 sm:text-center" aria-current={it.state === 'current' ? 'step' : undefined}>
          {i > 0 && (
            <span
              aria-hidden
              className={cn(
                'absolute hidden h-0.5 sm:top-3.5 sm:right-1/2 sm:block sm:w-full',
                it.state === 'todo' ? 'bg-border' : it.state === 'cancelled' ? 'bg-red-300 dark:bg-red-900' : 'bg-primary',
              )}
            />
          )}
          <span
            className={cn(
              'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold [&_svg]:size-3.5',
              it.state === 'done' && 'border-primary bg-primary text-primary-foreground',
              it.state === 'current' && 'border-primary bg-card text-primary ring-4 ring-primary/15',
              it.state === 'todo' && 'border-border bg-card text-muted-foreground',
              it.state === 'cancelled' && 'border-red-500 bg-red-500 text-white',
            )}
          >
            {it.state === 'done' ? <Check /> : it.state === 'cancelled' ? <X /> : i + 1}
          </span>
          <span className="min-w-0">
            <span className={cn('block text-sm font-medium', it.state === 'todo' && 'text-muted-foreground', it.state === 'cancelled' && 'text-red-600 dark:text-red-400')}>
              {it.label}
              {it.state === 'current' && <span className="sr-only"> (current)</span>}
            </span>
            {it.date && <span className="block text-xs text-muted-foreground">{fmt.date(it.date)}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

export default function PurchaseOrderDetailPage() {
  const { id } = useParams()
  const poId = Number(id)
  const { can } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [transition, setTransition] = useState<Transition | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [receiving, setReceiving] = useState(false)
  const [editing, setEditing] = useState(false)

  const q = useQuery({
    queryKey: qk.purchaseOrder(poId),
    queryFn: ({ signal }) => api.get<PurchaseOrder>(`/purchase-orders/${poId}`, undefined, signal),
    enabled: Number.isInteger(poId) && poId > 0,
  })
  const po = q.data

  const changeStatus = useMutation({
    mutationFn: (status: Transition) => api.post<PurchaseOrder>(`/purchase-orders/${poId}/status`, { status }),
    onSuccess: (updated, status) => {
      qc.setQueryData(qk.purchaseOrder(poId), updated)
      PO_RELATED_KEYS.forEach((key) => qc.invalidateQueries({ queryKey: key }))
      toast.success(`${updated.po_number} ${status === 'SUBMITTED' ? 'submitted' : status === 'CONFIRMED' ? 'confirmed' : 'cancelled'}`)
      setTransition(null)
    },
    onError: (e) => {
      toast.error('Could not update the order', { description: errorMessage(e) })
      setTransition(null)
      q.refetch()
    },
  })

  const remove = useMutation({
    mutationFn: () => api.delete(`/purchase-orders/${poId}`),
    onSuccess: () => {
      PO_RELATED_KEYS.forEach((key) => qc.invalidateQueries({ queryKey: key }))
      qc.removeQueries({ queryKey: qk.purchaseOrder(poId) })
      toast.success(`Draft ${po?.po_number ?? ''} deleted`)
      navigate('/purchase-orders')
    },
    onError: (e) => {
      toast.error('Could not delete the draft', { description: errorMessage(e) })
      setDeleting(false)
    },
  })

  const back = (
    <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2 text-muted-foreground">
      <Link to="/purchase-orders">
        <ArrowLeft /> Purchase orders
      </Link>
    </Button>
  )

  if (!Number.isInteger(poId) || poId <= 0) return <>{back}<EmptyState title="Purchase order not found" description="The link looks malformed." /></>
  if (q.isLoading)
    return (
      <>
        {back}
        <div className="grid gap-4" aria-busy="true">
          <CardsSkeleton count={4} />
          <Card>
            <TableSkeleton rows={4} />
          </Card>
        </div>
      </>
    )
  if (q.error || !po)
    return (
      <>
        {back}
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      </>
    )

  const allowed = po.allowed_transitions
  const canManage = can('manage_purchase_orders')
  const canReceive = can('receive_purchase_orders') && (allowed.includes('RECEIVED') || allowed.includes('PARTIALLY_RECEIVED'))
  const overdue = isOverdue(po)
  const outstanding = po.total_units - po.received_units
  const transitions = (['SUBMITTED', 'CONFIRMED'] as Transition[]).filter((t) => allowed.includes(t))
  const meta = transition ? TRANSITION_META[transition] : null

  return (
    <>
      {back}
      <div className="mb-6 flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">{po.po_number}</h1>
            <POStatusBadge status={po.status} />
            {overdue && (
              <Badge variant="danger">
                <AlarmClock aria-hidden /> {daysPast(po.expected_delivery_date)} days overdue
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            <Link to={`/suppliers/${po.supplier_id}`} className="font-medium text-foreground hover:underline">
              {po.supplier_name}
            </Link>{' '}
            →{' '}
            <Link to={`/warehouses/${po.warehouse_id}`} className="font-medium text-foreground hover:underline">
              {po.warehouse_code}
            </Link>{' '}
            · ordered {fmt.date(po.order_date)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && po.status === 'DRAFT' && (
            <>
              <Button variant="outline" onClick={() => setDeleting(true)} className="text-destructive hover:text-destructive">
                <Trash2 /> Delete draft
              </Button>
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            </>
          )}
          {canManage && po.status === 'PARTIALLY_RECEIVED' && (
            <Button variant="outline" onClick={() => setTransition('RECEIVED')}>
              <Ban /> {TRANSITION_META.RECEIVED.label}
            </Button>
          )}
          {canManage && allowed.includes('CANCELLED') && (
            <Button variant="outline" onClick={() => setTransition('CANCELLED')}>
              <Ban /> Cancel order
            </Button>
          )}
          {canManage &&
            transitions.map((t) => (
              <Button key={t} variant={canReceive ? 'outline' : 'default'} onClick={() => setTransition(t)}>
                {t === 'SUBMITTED' ? <Send /> : <CheckCircle2 />} {TRANSITION_META[t].label}
              </Button>
            ))}
          {canReceive && (
            <Button onClick={() => setReceiving(true)}>
              <Truck /> Receive goods
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <Card>
          <CardContent className="pt-5">
            <StatusTimeline po={po} />
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: 'Order total', value: fmt.money(po.total_amount), hint: `${po.line_count} line${po.line_count === 1 ? '' : 's'}` },
            {
              label: 'Expected delivery',
              value: <span className={cn(overdue && 'text-red-600 dark:text-red-400')}>{fmt.date(po.expected_delivery_date)}</span>,
              hint: po.received_date ? `Received ${fmt.date(po.received_date)}` : overdue ? `${daysPast(po.expected_delivery_date)} days late` : po.status === 'CANCELLED' ? 'Cancelled' : 'On schedule',
            },
            {
              label: 'Units received',
              value: `${fmt.int(po.received_units)} / ${fmt.int(po.total_units)}`,
              hint: <MiniProgress value={po.received_units} max={po.total_units} className="mt-1.5" label="Units received" />,
            },
            { label: 'Outstanding', value: fmt.int(po.status === 'CANCELLED' ? 0 : outstanding), hint: po.status === 'CANCELLED' ? 'Order cancelled' : outstanding ? 'units still to arrive' : 'Fully received' },
          ].map((s) => (
            <Card key={s.label} className="p-4">
              <p className="text-xs font-medium text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-lg font-semibold tabular">{s.value}</p>
              <div className="text-xs text-muted-foreground">{s.hint}</div>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Line items</CardTitle>
          </CardHeader>
          <Table>
            <caption className="sr-only">Purchase order lines</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Product</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Ordered</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Received</TableHead>
                <TableHead className="text-right">
                  <span className="sm:hidden">Open</span>
                  <span className="hidden sm:inline">Outstanding</span>
                </TableHead>
                <TableHead className="hidden w-36 xl:table-cell">Progress</TableHead>
                <TableHead className="hidden text-right xl:table-cell">Unit cost</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {po.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <div className="min-w-0 max-w-[9rem] sm:max-w-[16rem]">
                      <Link to={`/products/${l.product_id}`} className="block truncate font-medium hover:underline">
                        {l.product_name}
                      </Link>
                      <span className="font-mono text-xs text-muted-foreground">{l.sku}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-right tabular sm:table-cell">{fmt.int(l.quantity_ordered)}</TableCell>
                  <TableCell className="hidden text-right tabular sm:table-cell">{fmt.int(l.quantity_received)}</TableCell>
                  <TableCell className={cn('text-right tabular', l.quantity_outstanding > 0 && po.status !== 'CANCELLED' ? 'font-medium' : 'text-muted-foreground')}>
                    {fmt.int(l.quantity_outstanding)}
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
                    <MiniProgress value={l.quantity_received} max={l.quantity_ordered} label={`${l.sku}: ${l.quantity_received} of ${l.quantity_ordered} received`} />
                  </TableCell>
                  <TableCell className="hidden text-right tabular xl:table-cell">{fmt.money(l.unit_cost)}</TableCell>
                  <TableCell className="text-right font-medium tabular">{fmt.money(l.line_total)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableCell className="font-semibold">Total</TableCell>
                <TableCell className="hidden text-right font-semibold tabular sm:table-cell">{fmt.int(po.total_units)}</TableCell>
                <TableCell className="hidden text-right font-semibold tabular sm:table-cell">{fmt.int(po.received_units)}</TableCell>
                <TableCell className="text-right font-semibold tabular">{fmt.int(outstanding)}</TableCell>
                <TableCell className="hidden xl:table-cell" />
                <TableCell className="hidden xl:table-cell" />
                <TableCell className="text-right font-semibold tabular">{fmt.money(po.total_amount)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>Receiving history</CardTitle>
              <CardDescription>Each delivery is recorded once per reference, so re-sent receipts never double-count stock.</CardDescription>
            </CardHeader>
            <CardContent>
              {po.receipts.length === 0 ? (
                <EmptyState
                  className="py-8"
                  icon={<Truck className="size-6" aria-hidden />}
                  title="Nothing received yet"
                  description={canReceive ? 'Record a delivery when goods arrive.' : 'Goods can be received once the supplier confirms the order.'}
                  action={
                    canReceive ? (
                      <Button size="sm" onClick={() => setReceiving(true)}>
                        <Truck /> Receive goods
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <ol className="grid gap-3">
                  {[...po.receipts]
                    .sort((a, b) => b.received_at.localeCompare(a.received_at))
                    .map((r) => (
                      <li key={r.id} className="rounded-lg border p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-mono text-sm font-medium">{r.receipt_key}</span>
                          <span className="text-xs text-muted-foreground">{fmt.dateTime(r.received_at)}</span>
                        </div>
                        <ul className="mt-2 flex flex-wrap gap-1.5">
                          {r.lines.map((rl) => (
                            <li key={rl.purchase_order_line_id}>
                              <Badge variant="secondary">
                                <span className="font-mono">{rl.sku}</span> +{fmt.int(rl.quantity)}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                        {r.notes && <p className="mt-2 text-sm text-muted-foreground">{r.notes}</p>}
                      </li>
                    ))}
                </ol>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 text-sm">
                {[
                  ['Supplier', <Link key="s" to={`/suppliers/${po.supplier_id}`} className="font-medium text-primary hover:underline">{po.supplier_name}</Link>],
                  ['Warehouse', <Link key="w" to={`/warehouses/${po.warehouse_id}`} className="font-medium text-primary hover:underline">{po.warehouse_code}</Link>],
                  ['Order date', fmt.date(po.order_date)],
                  ['Submitted', po.submitted_at ? fmt.dateTime(po.submitted_at) : '—'],
                  ['Received', po.received_date ? fmt.date(po.received_date) : '—'],
                  ['Created', fmt.dateTime(po.created_at)],
                ].map(([k, v]) => (
                  <div key={k as string} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-right">{v}</dd>
                  </div>
                ))}
                <div className="border-t pt-3">
                  <dt className="text-muted-foreground">Notes</dt>
                  <dd className="mt-1 whitespace-pre-wrap">{po.notes || <span className="text-muted-foreground">No notes</span>}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>

      {meta && transition && (
        <ConfirmDialog
          open={!!transition}
          onOpenChange={(o) => !o && !changeStatus.isPending && setTransition(null)}
          title={meta.title}
          description={
            <p>
              <span className="font-mono text-foreground">{po.po_number}</span> · {po.supplier_name} · {fmt.money(po.total_amount)}. {meta.description}
            </p>
          }
          confirmLabel={meta.confirm}
          destructive={meta.destructive}
          loading={changeStatus.isPending}
          onConfirm={() => changeStatus.mutate(transition)}
        />
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={(o) => !remove.isPending && setDeleting(o)}
        title="Delete this draft?"
        description={`${po.po_number} and its ${po.line_count} line(s) will be permanently removed.`}
        confirmLabel="Delete draft"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
      <ReceiveDialog po={po} open={receiving} onOpenChange={setReceiving} />
      {po.status === 'DRAFT' && <EditDraftDialog po={po} open={editing} onOpenChange={setEditing} />}
    </>
  )
}
