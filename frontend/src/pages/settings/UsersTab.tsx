import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { qk, usePaged } from '@/api/queries'
import { type Column, DataTable } from '@/components/common/DataTable'
import { EmptyState } from '@/components/common/States'
import { ActiveBadge } from '@/components/common/StatusBadge'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ApiError, api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useUrlState } from '@/lib/hooks'
import type { User } from '@/lib/types'
import { fmt } from '@/lib/utils'
import { ROLE_META } from './roles'
import { CreateUserDialog, EditUserDialog } from './UserDialog'

const DEFAULTS = { u_page: 1, u_size: 25 }

export function UsersTab() {
  const { user: me } = useAuth()
  const qc = useQueryClient()
  const [f, setF] = useUrlState(DEFAULTS)
  const query = { page: f.u_page, page_size: f.u_size }
  const q = usePaged<User>([...qk.users, query], '/users', query)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [deactivating, setDeactivating] = useState<User | null>(null)

  const setActive = useMutation({
    mutationFn: ({ u, active }: { u: User; active: boolean }) => api.patch<User>(`/users/${u.id}`, { is_active: active }),
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: qk.users })
      toast.success(u.is_active ? 'User reactivated' : 'User deactivated', { description: u.full_name })
      setDeactivating(null)
    },
    onError: (e) => {
      const msg = e instanceof ApiError && e.code === 'SELF_LOCKOUT' ? 'You cannot deactivate or demote your own account.' : errorMessage(e)
      toast.error('Could not update user', { description: msg })
    },
  })

  const columns: Column<User>[] = [
    {
      key: 'name',
      header: 'User',
      cell: (u) => (
        <div className="flex min-w-0 items-center gap-3">
          <div className="hidden size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground sm:flex" aria-hidden>
            {u.full_name
              .split(/\s+/)
              .map((p) => p[0])
              .slice(0, 2)
              .join('')
              .toUpperCase()}
          </div>
          <div className="min-w-0 max-w-[16rem]">
            <p className="truncate font-medium">
              {u.full_name}
              {u.id === me?.id && (
                <Badge variant="muted" className="ml-2 align-middle">
                  You
                </Badge>
              )}
            </p>
            <p className="truncate text-xs text-muted-foreground">{u.email}</p>
          </div>
        </div>
      ),
    },
    { key: 'role', header: 'Role', hideBelow: 'sm', cell: (u) => <Badge variant={u.role === 'ADMIN' ? 'default' : 'secondary'}>{ROLE_META[u.role].label}</Badge> },
    { key: 'status', header: 'Status', cell: (u) => <ActiveBadge active={u.is_active} /> },
    { key: 'login', header: 'Last sign-in', hideBelow: 'md', cell: (u) => <span className="whitespace-nowrap text-muted-foreground">{u.last_login_at ? fmt.relative(u.last_login_at) : 'Never'}</span> },
    { key: 'created', header: 'Created', hideBelow: 'lg', cell: (u) => <span className="whitespace-nowrap text-muted-foreground">{fmt.date(u.created_at)}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (u) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.full_name}`} onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={() => setEditing(u)}>Edit…</DropdownMenuItem>
            {u.id !== me?.id && (
              <>
                <DropdownMenuSeparator />
                {u.is_active ? (
                  <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeactivating(u)}>
                    Deactivate…
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => setActive.mutate({ u, active: true })}>Reactivate</DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ]

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>Users</CardTitle>
          <CardDescription>People who can sign in, and what their role allows.</CardDescription>
        </div>
        <Button onClick={() => setCreating(true)}>
          <UserPlus /> Add user
        </Button>
      </CardHeader>
      <DataTable
        caption="Users"
        columns={columns}
        rows={q.data?.items}
        rowKey={(u) => u.id}
        loading={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        onRowClick={setEditing}
        empty={<EmptyState title="No users" action={<Button onClick={() => setCreating(true)}>Add user</Button>} />}
        page={f.u_page}
        pageSize={f.u_size}
        total={q.data?.total}
        onPageChange={(u_page) => setF({ u_page })}
        onPageSizeChange={(u_size) => setF({ u_size, u_page: 1 })}
      />
      <CreateUserDialog open={creating} onOpenChange={setCreating} />
      <EditUserDialog user={editing} isSelf={editing?.id === me?.id} onOpenChange={(o) => !o && setEditing(null)} />
      <ConfirmDialog
        open={!!deactivating}
        onOpenChange={(o) => !o && !setActive.isPending && setDeactivating(null)}
        title="Deactivate user?"
        description={
          <>
            <strong>{deactivating?.full_name}</strong> ({deactivating?.email}) loses access immediately, including any open sessions. Their history is kept and you can
            reactivate them later.
          </>
        }
        confirmLabel="Deactivate"
        destructive
        loading={setActive.isPending}
        onConfirm={() => deactivating && setActive.mutate({ u: deactivating, active: false })}
      />
    </Card>
  )
}
