import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { Field } from '@/components/common/Field'
import { InlineError } from '@/components/common/States'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, NativeSelect, Textarea } from '@/components/ui/input'
import { api } from '@/lib/api'
import type { EntityStatus, Supplier } from '@/lib/types'
import { applyServerErrors, changedFields, isFieldLevelError, nullable } from '../products/formUtils'

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200, 'At most 200 characters'),
  contact_name: z.string().max(200, 'At most 200 characters'),
  email: z
    .string()
    .trim()
    .refine((v) => v === '' || z.string().email().safeParse(v).success, 'Enter a valid email address'),
  phone: z
    .string()
    .trim()
    .max(50, 'At most 50 characters')
    .regex(/^[0-9+()\-.\s]*$/, 'Digits, spaces and + ( ) - . only'),
  address: z.string().max(1000, 'At most 1000 characters'),
  payment_terms: z.string().max(100, 'At most 100 characters'),
  lead_time_days: z
    .string()
    .trim()
    .min(1, 'Lead time is required')
    .refine((v) => /^\d+$/.test(v), 'Enter a whole number of days')
    .refine((v) => !/^\d+$/.test(v) || Number(v) <= 365, 'Must be between 0 and 365 days'),
  status: z.enum(['ACTIVE', 'INACTIVE']),
})
type Values = z.infer<typeof schema>
const FIELDS = ['name', 'contact_name', 'email', 'phone', 'address', 'payment_terms', 'lead_time_days', 'status'] as const
const EMPTY: Values = { name: '', contact_name: '', email: '', phone: '', address: '', payment_terms: 'Net 30', lead_time_days: '7', status: 'ACTIVE' }

const toValues = (s: Supplier): Values => ({
  name: s.name,
  contact_name: s.contact_name ?? '',
  email: s.email ?? '',
  phone: s.phone ?? '',
  address: s.address ?? '',
  payment_terms: s.payment_terms ?? '',
  lead_time_days: String(s.lead_time_days),
  status: s.status,
})

const toPayload = (v: Values) => ({
  name: v.name.trim(),
  contact_name: nullable(v.contact_name),
  email: nullable(v.email),
  phone: nullable(v.phone),
  address: nullable(v.address),
  payment_terms: nullable(v.payment_terms),
  lead_time_days: Number(v.lead_time_days),
  status: v.status as EntityStatus,
})

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  supplier?: Supplier | null
  onSaved?: (s: Supplier) => void
}

export function SupplierFormDialog({ open, onOpenChange, supplier, onSaved }: Props) {
  const qc = useQueryClient()
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: EMPTY })
  const { register, handleSubmit, reset, setError, control, formState } = form
  const errors = formState.errors
  const [confirmValues, setConfirmValues] = useState<Values | null>(null)

  useEffect(() => {
    if (open) reset(supplier ? toValues(supplier) : EMPTY)
  }, [open, supplier, reset])

  const mutation = useMutation({
    mutationFn: async (v: Values): Promise<Supplier | null> => {
      if (supplier) {
        const changes = changedFields(toPayload(toValues(supplier)), toPayload(v))
        if (Object.keys(changes).length === 0) return null
        return api.patch<Supplier>(`/suppliers/${supplier.id}`, changes)
      }
      return api.post<Supplier>('/suppliers', toPayload(v))
    },
    onSuccess: (saved) => {
      if (!saved) {
        toast.info('No changes to save')
        onOpenChange(false)
        return
      }
      // Supplier names and lead times are embedded in products, POs and restocking suggestions.
      for (const key of [['suppliers'], ['products'], ['purchase-orders'], ['restocking'], ['shortages']]) qc.invalidateQueries({ queryKey: key })
      toast.success(supplier ? 'Supplier updated' : 'Supplier created', { description: saved.name })
      onSaved?.(saved)
      onOpenChange(false)
    },
    onError: (e) => applyServerErrors(e, setError, FIELDS, 'name'),
  })

  const submit = (v: Values) => {
    if (supplier?.status === 'ACTIVE' && v.status === 'INACTIVE') setConfirmValues(v)
    else mutation.mutate(v)
  }

  const status = useWatch({ control, name: 'status' })
  const showBanner = mutation.error && !isFieldLevelError(mutation.error, FIELDS, true)

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent size="lg">
        <form onSubmit={handleSubmit(submit)} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{supplier ? `Edit ${supplier.name}` : 'New supplier'}</DialogTitle>
            <DialogDescription>
              {supplier ? 'Update contact details, terms and the promised lead time.' : 'Add a vendor you purchase from. The lead time drives reorder points and restocking.'}
            </DialogDescription>
          </DialogHeader>
          {showBanner && <InlineError error={mutation.error} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="s-name" label="Company name" error={errors.name?.message} required className="sm:col-span-2">
              <Input id="s-name" placeholder="e.g. Acme Industrial Supply" aria-invalid={!!errors.name} {...register('name')} />
            </Field>
            <Field id="s-contact" label="Contact person" error={errors.contact_name?.message}>
              <Input id="s-contact" autoComplete="off" aria-invalid={!!errors.contact_name} {...register('contact_name')} />
            </Field>
            <Field id="s-email" label="Email" error={errors.email?.message}>
              <Input id="s-email" type="email" autoComplete="off" placeholder="orders@example.com" aria-invalid={!!errors.email} {...register('email')} />
            </Field>
            <Field id="s-phone" label="Phone" error={errors.phone?.message}>
              <Input id="s-phone" type="tel" placeholder="+1 312 555 0101" aria-invalid={!!errors.phone} {...register('phone')} />
            </Field>
            <Field id="s-terms" label="Payment terms" error={errors.payment_terms?.message} hint="e.g. Net 30, Prepaid">
              <Input id="s-terms" aria-invalid={!!errors.payment_terms} {...register('payment_terms')} />
            </Field>
            <Field id="s-address" label="Address" error={errors.address?.message} className="sm:col-span-2">
              <Textarea id="s-address" rows={2} aria-invalid={!!errors.address} {...register('address')} />
            </Field>
            <Field id="s-lead" label="Promised lead time (days)" error={errors.lead_time_days?.message} required hint="0–365 days from order to delivery">
              <Input id="s-lead" type="number" inputMode="numeric" min={0} max={365} step={1} aria-invalid={!!errors.lead_time_days} {...register('lead_time_days')} />
            </Field>
            <Field
              id="s-status"
              label="Status"
              error={errors.status?.message}
              hint={status === 'INACTIVE' ? 'Inactive suppliers can’t receive new purchase orders.' : 'Available for new purchase orders.'}
            >
              <NativeSelect id="s-status" {...register('status')}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </NativeSelect>
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {supplier ? 'Save changes' : 'Create supplier'}
            </Button>
          </DialogFooter>
        </form>
        <ConfirmDialog
          open={open && !!confirmValues}
          onOpenChange={(o) => !o && !mutation.isPending && setConfirmValues(null)}
          title={`Deactivate ${supplier?.name}?`}
          description="Existing purchase orders and history are kept, but no new purchase orders can be raised with this supplier until it is reactivated."
          confirmLabel="Deactivate supplier"
          destructive
          loading={mutation.isPending}
          onConfirm={() => confirmValues && mutation.mutate(confirmValues, { onSettled: () => setConfirmValues(null) })}
        />
      </DialogContent>
    </Dialog>
  )
}
