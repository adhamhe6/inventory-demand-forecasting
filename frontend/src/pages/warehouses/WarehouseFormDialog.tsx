import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { Field } from '@/components/common/Field'
import { InlineError } from '@/components/common/States'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, NativeSelect } from '@/components/ui/input'
import { api } from '@/lib/api'
import type { EntityStatus, Warehouse } from '@/lib/types'
import { applyServerErrors, changedFields, isFieldLevelError, nullable } from '../products/formUtils'

export const WAREHOUSE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,19}$/

function makeSchema(mode: 'create' | 'edit') {
  return z.object({
    code:
      mode === 'create'
        ? z
            .string()
            .trim()
            .min(1, 'Code is required')
            .transform((v) => v.toUpperCase())
            .pipe(z.string().regex(WAREHOUSE_CODE_PATTERN, "2–20 characters: A–Z, 0–9, '-' or '_' (must start with a letter or digit)"))
        : z.string(),
    name: z.string().trim().min(1, 'Name is required').max(200, 'At most 200 characters'),
    location: z.string().max(255, 'At most 255 characters'),
    status: z.enum(['ACTIVE', 'INACTIVE']),
  })
}
type Values = z.input<ReturnType<typeof makeSchema>>
const FIELDS = ['code', 'name', 'location', 'status'] as const
const EMPTY: Values = { code: '', name: '', location: '', status: 'ACTIVE' }

const toPayload = (v: Values) => ({ name: v.name.trim(), location: nullable(v.location), status: v.status as EntityStatus })

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  warehouse?: Warehouse | null
  onSaved?: (w: Warehouse) => void
}

export function WarehouseFormDialog({ open, onOpenChange, warehouse, onSaved }: Props) {
  const mode = warehouse ? 'edit' : 'create'
  const qc = useQueryClient()
  const schema = useMemo(() => makeSchema(mode), [mode])
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: EMPTY })
  const { register, handleSubmit, reset, setError, control, formState } = form
  const errors = formState.errors

  useEffect(() => {
    if (open) reset(warehouse ? { code: warehouse.code, name: warehouse.name, location: warehouse.location ?? '', status: warehouse.status } : EMPTY)
  }, [open, warehouse, reset])

  const mutation = useMutation({
    mutationFn: async (v: Values): Promise<Warehouse | null> => {
      if (warehouse) {
        const initial = toPayload({ code: warehouse.code, name: warehouse.name, location: warehouse.location ?? '', status: warehouse.status })
        const changes = changedFields(initial, toPayload(v))
        if (Object.keys(changes).length === 0) return null
        return api.patch<Warehouse>(`/warehouses/${warehouse.id}`, changes)
      }
      return api.post<Warehouse>('/warehouses', { code: v.code.trim().toUpperCase(), ...toPayload(v) })
    },
    onSuccess: (saved) => {
      if (!saved) {
        toast.info('No changes to save')
        onOpenChange(false)
        return
      }
      // Warehouse names/codes appear across inventory, transactions and reports.
      for (const key of [['warehouses'], ['inventory'], ['transactions'], ['dashboard'], ['reports'], ['shortages'], ['restocking']]) {
        qc.invalidateQueries({ queryKey: key })
      }
      toast.success(warehouse ? 'Warehouse updated' : 'Warehouse created', { description: `${saved.code} — ${saved.name}` })
      onSaved?.(saved)
      onOpenChange(false)
    },
    onError: (e) => applyServerErrors(e, setError, FIELDS, 'code'),
  })

  // Deactivating blocks all stock operations in this warehouse: confirm first.
  const [confirmValues, setConfirmValues] = useState<Values | null>(null)
  const submit = (v: Values) => {
    if (warehouse?.status === 'ACTIVE' && v.status === 'INACTIVE') setConfirmValues(v)
    else mutation.mutate(v)
  }

  const status = useWatch({ control, name: 'status' })
  const showBanner = mutation.error && !isFieldLevelError(mutation.error, FIELDS, true)

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={handleSubmit((v) => submit(v as Values))} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{warehouse ? `Edit ${warehouse.code}` : 'New warehouse'}</DialogTitle>
            <DialogDescription>{warehouse ? 'Update the warehouse name, location or status.' : 'Add a stocking location. Products are stocked here as soon as goods are received.'}</DialogDescription>
          </DialogHeader>
          {showBanner && <InlineError error={mutation.error} />}
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <Field id="w-code" label="Code" error={errors.code?.message} required={mode === 'create'} hint={mode === 'create' ? 'e.g. WH-EAST' : 'Cannot be changed'}>
              <Input
                id="w-code"
                className="font-mono uppercase placeholder:normal-case"
                autoComplete="off"
                maxLength={20}
                disabled={mode === 'edit'}
                aria-invalid={!!errors.code}
                {...register('code')}
              />
            </Field>
            <Field id="w-name" label="Name" error={errors.name?.message} required>
              <Input id="w-name" placeholder="e.g. East Distribution Center" aria-invalid={!!errors.name} {...register('name')} />
            </Field>
          </div>
          <Field id="w-location" label="Location" error={errors.location?.message} hint="City, region or full address">
            <Input id="w-location" placeholder="e.g. Atlanta, GA" aria-invalid={!!errors.location} {...register('location')} />
          </Field>
          <Field
            id="w-status"
            label="Status"
            error={errors.status?.message}
            hint={
              status === 'INACTIVE'
                ? 'Inactive warehouses keep their stock and history but can’t receive, issue or transfer stock.'
                : 'Active warehouses can receive, issue and transfer stock.'
            }
          >
            <NativeSelect id="w-status" {...register('status')}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </NativeSelect>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {warehouse ? 'Save changes' : 'Create warehouse'}
            </Button>
          </DialogFooter>
        </form>
        <ConfirmDialog
          open={open && !!confirmValues}
          onOpenChange={(o) => !o && !mutation.isPending && setConfirmValues(null)}
          title={`Deactivate ${warehouse?.code}?`}
          description="Stock stays in place and history is kept, but no receipts, issues, sales or transfers can be recorded here until it is reactivated."
          confirmLabel="Deactivate warehouse"
          destructive
          loading={mutation.isPending}
          onConfirm={() => confirmValues && mutation.mutate(confirmValues, { onSettled: () => setConfirmValues(null) })}
        />
      </DialogContent>
    </Dialog>
  )
}
