import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PackageCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { qk, STOCK_KEYS } from '@/api/queries'
import { Field } from '@/components/common/Field'
import { InlineError } from '@/components/common/States'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, Textarea } from '@/components/ui/input'
import { api } from '@/lib/api'
import type { PurchaseOrder, ReceiveResult } from '@/lib/types'
import { fmt } from '@/lib/utils'
import { generateGrn, PO_RELATED_KEYS, PO_STATUS_LABEL } from './utils'

function makeSchema(outstanding: number[]) {
  return z
    .object({
      quantities: z.array(z.coerce.number({ invalid_type_error: 'Enter a number' }).int('Whole units only').min(0, 'Cannot be negative')),
      receipt_reference: z.string().trim().max(100, 'At most 100 characters').optional(),
      notes: z.string().max(1000, 'At most 1,000 characters').optional(),
    })
    .superRefine((v, ctx) => {
      v.quantities.forEach((q, i) => {
        if (q > (outstanding[i] ?? 0))
          ctx.addIssue({ code: 'custom', path: ['quantities', i], message: `Only ${fmt.int(outstanding[i] ?? 0)} outstanding` })
      })
      if (!v.quantities.some((q) => q > 0)) ctx.addIssue({ code: 'custom', path: ['quantities', 'root'], message: 'Enter a quantity for at least one line' })
    })
}
type Values = z.infer<ReturnType<typeof makeSchema>>

export function ReceiveDialog({ po, open, onOpenChange }: { po: PurchaseOrder; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const openLines = useMemo(() => po.lines.filter((l) => l.quantity_outstanding > 0), [po.lines])
  const outstanding = useMemo(() => openLines.map((l) => l.quantity_outstanding), [openLines])
  const schema = useMemo(() => makeSchema(outstanding), [outstanding])
  const [grn, setGrn] = useState(generateGrn)
  const [confirming, setConfirming] = useState<Values | null>(null)
  const form = useForm<Values>({ resolver: zodResolver(schema) })
  const { register, handleSubmit, reset, setValue, control, formState } = form
  const errors = formState.errors
  const quantities = useWatch({ control, name: 'quantities' }) ?? []

  useEffect(() => {
    if (open) {
      setGrn(generateGrn())
      setConfirming(null)
      reset({ quantities: outstanding, receipt_reference: '', notes: '' })
    }
    // Only reset when the dialog opens — not when the PO refetches underneath it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const receive = useMutation({
    mutationFn: (v: Values) =>
      api.post<ReceiveResult>(`/purchase-orders/${po.id}/receive`, {
        lines: openLines.map((l, i) => ({ line_id: l.id, quantity: Number(v.quantities[i]) })).filter((l) => l.quantity > 0),
        receipt_reference: v.receipt_reference?.trim() || grn,
        notes: v.notes?.trim() || null,
      }),
    onSuccess: (res) => {
      ;[...STOCK_KEYS, ...PO_RELATED_KEYS].forEach((key) => qc.invalidateQueries({ queryKey: key }))
      qc.setQueryData(qk.purchaseOrder(po.id), res.purchase_order)
      const units = res.receipt.lines.reduce((n, l) => n + l.quantity, 0)
      if (res.replayed) {
        toast.info(`Receipt ${res.receipt.receipt_key} was already recorded`, { description: 'Already received — no stock changed.' })
      } else {
        toast.success(`Received ${fmt.int(units)} units into ${po.warehouse_code}`, {
          description: `${res.receipt.receipt_key} · order is now ${PO_STATUS_LABEL[res.purchase_order.status].toLowerCase()}`,
        })
      }
      setConfirming(null)
      onOpenChange(false)
    },
    onError: () => setConfirming(null),
  })

  const totalNow = quantities.reduce((n: number, q) => n + (Number(q) > 0 ? Number(q) : 0), 0)
  const rootError = (errors.quantities as { root?: { message?: string } } | undefined)?.root?.message

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !receive.isPending && onOpenChange(o)}>
        <DialogContent size="lg">
          <form onSubmit={handleSubmit((v) => setConfirming(v))} noValidate className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Receive goods</DialogTitle>
              <DialogDescription>
                Record what arrived for {po.po_number} at {po.warehouse_code}. Stock increases immediately; partial deliveries are fine.
              </DialogDescription>
            </DialogHeader>
            <InlineError error={receive.error} />
            <div className="overflow-hidden rounded-lg border">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Receive now</span>
                <div className="flex gap-1">
                  <Button type="button" variant="ghost" size="sm" onClick={() => outstanding.forEach((q, i) => setValue(`quantities.${i}`, q, { shouldValidate: formState.isSubmitted }))}>
                    Receive all
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => outstanding.forEach((_, i) => setValue(`quantities.${i}`, 0, { shouldValidate: formState.isSubmitted }))}>
                    Clear
                  </Button>
                </div>
              </div>
              <ul className="max-h-[45vh] divide-y overflow-y-auto">
                {openLines.map((l, i) => {
                  const err = Array.isArray(errors.quantities) ? errors.quantities[i]?.message : undefined
                  return (
                    <li key={l.id} className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{l.product_name}</p>
                        <p className="text-xs text-muted-foreground">
                          <span className="font-mono">{l.sku}</span> · ordered {fmt.int(l.quantity_ordered)} · received {fmt.int(l.quantity_received)} ·{' '}
                          <span className="font-medium text-foreground">{fmt.int(l.quantity_outstanding)} outstanding</span>
                        </p>
                        {err && (
                          <p role="alert" className="text-xs font-medium text-destructive">
                            {err}
                          </p>
                        )}
                      </div>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={l.quantity_outstanding}
                        step={1}
                        aria-label={`Receive quantity for ${l.sku}`}
                        aria-invalid={!!err}
                        className="text-right tabular"
                        {...register(`quantities.${i}`)}
                      />
                    </li>
                  )
                })}
              </ul>
              <div className="flex justify-between border-t bg-muted/20 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Total to receive</span>
                <span className="font-semibold tabular">{fmt.int(totalNow)} units</span>
              </div>
            </div>
            {rootError && (
              <p role="alert" className="-mt-2 text-xs font-medium text-destructive">
                {rootError}
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="rcv-ref"
                label="Delivery note / GRN"
                error={errors.receipt_reference?.message}
                hint="Re-sending the same reference never receives twice"
              >
                <Input id="rcv-ref" placeholder={grn} aria-invalid={!!errors.receipt_reference} {...register('receipt_reference')} />
              </Field>
              <Field id="rcv-notes" label="Notes" error={errors.notes?.message}>
                <Textarea id="rcv-notes" rows={1} className="min-h-9" placeholder="e.g. 2 cartons damaged" {...register('notes')} />
              </Field>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={receive.isPending}>
                Cancel
              </Button>
              <Button type="submit" loading={receive.isPending}>
                {!receive.isPending && <PackageCheck />} Receive {totalNow > 0 ? `${fmt.int(totalNow)} units` : ''}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(o) => !o && !receive.isPending && setConfirming(null)}
        title="Confirm goods receipt"
        confirmLabel="Receive into stock"
        loading={receive.isPending}
        onConfirm={() => confirming && receive.mutate(confirming)}
        description={
          <p>
            Add <strong className="text-foreground">{fmt.int(totalNow)} units</strong> across{' '}
            {quantities.filter((q) => Number(q) > 0).length} line(s) to <strong className="text-foreground">{po.warehouse_code}</strong> stock under reference{' '}
            <span className="font-mono text-foreground">{confirming?.receipt_reference?.trim() || grn}</span>.
            {totalNow < outstanding.reduce((a, b) => a + b, 0) && ' The remaining quantity stays open on the order.'}
          </p>
        }
      />
    </>
  )
}
