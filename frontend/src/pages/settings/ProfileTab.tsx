import { useQuery } from '@tanstack/react-query'
import { Check, Moon, Sun } from 'lucide-react'
import { ErrorState } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useTheme } from '@/lib/theme'
import { cn, fmt } from '@/lib/utils'
import { ROLE_META } from './roles'

export function ProfileTab() {
  const { user } = useAuth()
  const { theme, setTheme } = useTheme()
  const perms = useQuery({
    queryKey: ['auth', 'permissions'],
    queryFn: () => api.get<{ role: string; permissions: string[] }>('/auth/permissions'),
    staleTime: 5 * 60_000,
  })
  if (!user) return null
  const initials = user.full_name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className="grid gap-6 [&>*]:min-w-0 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle>Your profile</CardTitle>
          <CardDescription>Account details are managed by an administrator.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center gap-4">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary" aria-hidden>
              {initials}
            </div>
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold">{user.full_name}</p>
              <p className="truncate text-sm text-muted-foreground">{user.email}</p>
            </div>
            <Badge className="ml-auto">{ROLE_META[user.role].label}</Badge>
          </div>
          <dl className="grid gap-3 sm:grid-cols-3">
            {[
              ['Role', ROLE_META[user.role].label],
              ['Member since', fmt.date(user.created_at)],
              ['Last sign-in', fmt.dateTime(user.last_login_at)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border p-3">
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="mt-1 text-sm font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          <div>
            <h3 className="text-sm font-semibold">Permissions</h3>
            <p className="mb-3 text-sm text-muted-foreground">{ROLE_META[user.role].description}</p>
            {perms.error ? (
              <ErrorState error={perms.error} onRetry={() => perms.refetch()} className="py-4" />
            ) : !perms.data ? (
              <div className="flex flex-wrap gap-2">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-6 w-28 rounded-full" />
                ))}
              </div>
            ) : (
              <ul className="flex flex-wrap gap-2" aria-label="Your permissions">
                {perms.data.permissions.map((p) => (
                  <li key={p}>
                    <Badge variant="secondary">
                      <Check aria-hidden /> {fmt.label(p)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="self-start">
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Saved on this device.</CardDescription>
        </CardHeader>
        <CardContent>
          <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-3">
            {(
              [
                { id: 'light', label: 'Light', icon: Sun },
                { id: 'dark', label: 'Dark', icon: Moon },
              ] as const
            ).map((t) => {
              const active = theme === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setTheme(t.id)}
                  className={cn(
                    'cursor-pointer rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring',
                    active && 'border-primary ring-1 ring-primary',
                  )}
                >
                  <div className={cn('mb-3 h-14 rounded-md border', t.id === 'dark' ? 'bg-slate-900' : 'bg-slate-50')} aria-hidden>
                    <div className={cn('m-2 h-2 w-10 rounded', t.id === 'dark' ? 'bg-slate-600' : 'bg-slate-300')} />
                    <div className={cn('mx-2 h-2 w-16 rounded', t.id === 'dark' ? 'bg-slate-700' : 'bg-slate-200')} />
                  </div>
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <t.icon className="size-4" aria-hidden /> {t.label}
                    {active && <Check className="ml-auto size-4 text-primary" aria-hidden />}
                  </span>
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
