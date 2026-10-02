import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import { qk } from '@/api/queries'
import { Field } from '@/components/common/Field'
import { InlineError } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, NativeSelect } from '@/components/ui/input'
import { ApiError, api } from '@/lib/api'
import type { User } from '@/lib/types'
import { ROLE_META, ROLES } from './roles'

import { type CreateValues, createSchema, type EditValues, editSchema } from './schemas'

/** Map backend errors onto form fields; returns true when something was mapped. */
function mapServerErrors(e: unknown, setError: (name: never, err: { message: string }) => void): boolean {
  if (!(e instanceof ApiError)) return false
  if (e.code === 'DUPLICATE' || e.status === 409) {
    setError('email' as never, { message: 'A user with this email already exists' })
    return true
  }
  const fe = Object.entries(e.fieldErrors)
  for (const [field, message] of fe) setError(field.replace(/^body\./, '') as never, { message })
  return fe.length > 0
}

export function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const form = useForm<CreateValues>({ resolver: zodResolver(createSchema), defaultValues: { email: '', full_name: '', role: 'ANALYST', password: '' } })
  const { register, handleSubmit, reset, setError, formState, control } = form
  useEffect(() => {
    if (open) reset({ email: '', full_name: '', role: 'ANALYST', password: '' })
  }, [open, reset])
  const m = useMutation({
    mutationFn: (v: CreateValues) => api.post<User>('/users', v),
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: qk.users })
      toast.success('User created', { description: `${u.full_name} can now sign in as ${ROLE_META[u.role].label}.` })
      onOpenChange(false)
    },
  })
  const mapped = m.error ? m.error instanceof ApiError && (m.error.code === 'DUPLICATE' || Object.keys(m.error.fieldErrors).length > 0) : false
  const errors = formState.errors
  const role = useWatch({ control, name: 'role' })

  return (
    <Dialog open={open} onOpenChange={(o) => !m.isPending && onOpenChange(o)}>
      <DialogContent>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={handleSubmit((v) =>
            m.mutate(v, { onError: (e) => mapServerErrors(e, setError as never) }),
          )}
        >
          <DialogHeader>
            <DialogTitle>Invite user</DialogTitle>
            <DialogDescription>Create an account and share the initial password securely.</DialogDescription>
          </DialogHeader>
          {!mapped && <InlineError error={m.error} />}
          <Field id="u-name" label="Full name" error={errors.full_name?.message} required>
            <Input id="u-name" autoComplete="off" aria-invalid={!!errors.full_name} {...register('full_name')} />
          </Field>
          <Field id="u-email" label="Email" error={errors.email?.message} required>
            <Input id="u-email" type="email" autoComplete="off" aria-invalid={!!errors.email} {...register('email')} />
          </Field>
          <Field id="u-role" label="Role" error={errors.role?.message} hint={ROLE_META[role]?.description} required>
            <NativeSelect id="u-role" {...register('role')}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_META[r].label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="u-pass" label="Initial password" error={errors.password?.message} hint="At least 10 characters, with letters and digits." required>
            <Input id="u-pass" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...register('password')} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={m.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={m.isPending}>
              Create user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function EditUserDialog({ user, isSelf, onOpenChange }: { user: User | null; isSelf: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const form = useForm<EditValues>({ resolver: zodResolver(editSchema) })
  const { register, handleSubmit, reset, setError, formState } = form
  useEffect(() => {
    if (user) reset({ full_name: user.full_name, role: user.role, is_active: user.is_active, password: '' })
  }, [user, reset])
  const m = useMutation({
    mutationFn: (v: EditValues) => {
      const body: Record<string, unknown> = {}
      if (v.full_name !== user!.full_name) body.full_name = v.full_name
      if (v.role !== user!.role) body.role = v.role
      if (v.is_active !== user!.is_active) body.is_active = v.is_active
      if (v.password) body.password = v.password
      return api.patch<User>(`/users/${user!.id}`, body)
    },
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: qk.users })
      toast.success('User updated', { description: u.full_name })
      onOpenChange(false)
    },
  })
  const errors = formState.errors
  const mapped = m.error instanceof ApiError && Object.keys(m.error.fieldErrors).length > 0

  return (
    <Dialog open={!!user} onOpenChange={(o) => !m.isPending && onOpenChange(o)}>
      <DialogContent>
        {user && (
          <form noValidate className="grid gap-4" onSubmit={handleSubmit((v) => m.mutate(v, { onError: (e) => mapServerErrors(e, setError as never) }))}>
            <DialogHeader>
              <DialogTitle>Edit user</DialogTitle>
              <DialogDescription>{user.email}</DialogDescription>
            </DialogHeader>
            {!mapped && <InlineError error={m.error} />}
            <Field id="e-name" label="Full name" error={errors.full_name?.message} required>
              <Input id="e-name" aria-invalid={!!errors.full_name} {...register('full_name')} />
            </Field>
            <Field id="e-role" label="Role" error={errors.role?.message} hint={isSelf ? 'You cannot change your own role.' : undefined} required>
              {isSelf ? (
                <Input id="e-role" value={ROLE_META[user.role].label} disabled readOnly />
              ) : (
                <NativeSelect id="e-role" {...register('role')}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_META[r].label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
              {isSelf ? (
                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked disabled readOnly />
              ) : (
                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" {...register('is_active')} />
              )}
              <span>
                <span className="font-medium">Active</span>
                <span className="block text-muted-foreground">
                  {isSelf ? 'You cannot deactivate your own account.' : 'Inactive users cannot sign in; their history is kept.'}
                </span>
              </span>
            </label>
            <Field id="e-pass" label="New password" error={errors.password?.message} hint="Leave blank to keep the current password.">
              <Input id="e-pass" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...register('password')} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={m.isPending}>
                Cancel
              </Button>
              <Button type="submit" loading={m.isPending}>
                Save changes
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
