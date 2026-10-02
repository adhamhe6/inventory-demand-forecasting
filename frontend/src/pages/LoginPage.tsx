import { zodResolver } from '@hookform/resolvers/zod'
import { BarChart3, PackageSearch, ShieldCheck, TrendingUp } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import { Field } from '@/components/common/Field'
import { InlineError } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useMeta } from '@/api/queries'

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})
type FormValues = z.infer<typeof schema>

const YEAR = new Date().getFullYear()

// Accounts created by the demo seed (backend/app/scripts/seed.py). Only offered when the server
// reports demo_mode, so a production deployment never advertises credentials.
const DEMO_PASSWORD = 'DemoPass123!'
const DEMO_ACCOUNTS = [
  { label: 'Admin', email: 'admin@demo.example' },
  { label: 'Inventory', email: 'inventory@demo.example' },
  { label: 'Warehouse', email: 'warehouse@demo.example' },
  { label: 'Purchasing', email: 'purchasing@demo.example' },
  { label: 'Analyst', email: 'analyst@demo.example' },
]

export default function LoginPage() {
  const { user, login, sessionMessage } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState<unknown>(null)
  const meta = useMeta()
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } })

  const from = (location.state as { from?: string } | null)?.from ?? '/'
  if (user) return <Navigate to={from} replace />

  const onSubmit = async (values: FormValues) => {
    setError(null)
    try {
      await login(values.email, values.password)
      navigate(from, { replace: true })
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'RATE_LIMITED' ? new Error(e.message) : e)
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-12 text-white lg:flex">
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-primary/30 blur-3xl" aria-hidden />
        <div className="absolute -bottom-32 left-10 size-96 rounded-full bg-cyan-400/10 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary">
            <PackageSearch className="size-5" />
          </span>
          <span className="text-lg font-semibold">StockSense</span>
        </div>
        <div className="relative max-w-md space-y-8">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            Know what to reorder, <span className="text-indigo-300">before</span> you run out.
          </h2>
          <ul className="space-y-4 text-sm text-white/75">
            <li className="flex gap-3">
              <TrendingUp className="size-5 shrink-0 text-indigo-300" /> Demand forecasts with backtested accuracy for every product and warehouse.
            </li>
            <li className="flex gap-3">
              <ShieldCheck className="size-5 shrink-0 text-indigo-300" /> Shortage detection from live stock, open purchase orders and lead times.
            </li>
            <li className="flex gap-3">
              <BarChart3 className="size-5 shrink-0 text-indigo-300" /> One-click restocking recommendations and auditable stock movements.
            </li>
          </ul>
        </div>
        <p className="relative text-xs text-white/40">© {YEAR} StockSense demo</p>
      </div>
      <div className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-1.5">
            <div className="mb-6 flex items-center gap-2 lg:hidden">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <PackageSearch className="size-5" />
              </span>
              <span className="text-lg font-semibold">StockSense</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
            <p className="text-sm text-muted-foreground">Use your work account to access the inventory workspace.</p>
          </div>
          {sessionMessage && !error && (
            <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
              {sessionMessage}
            </p>
          )}
          <InlineError error={error} />
          <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
            <Field id="email" label="Email" error={errors.email?.message}>
              <Input id="email" type="email" autoComplete="username" aria-invalid={!!errors.email} {...register('email')} />
            </Field>
            <Field id="password" label="Password" error={errors.password?.message}>
              <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...register('password')} />
            </Field>
            <Button type="submit" className="w-full" loading={isSubmitting}>
              Sign in
            </Button>
          </form>
          {meta.data?.demo_mode && (
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Demo accounts (seeded data, password <code>{DEMO_PASSWORD}</code>)
              </p>
              <div className="flex flex-wrap gap-1.5">
                {DEMO_ACCOUNTS.map((a) => (
                  <Button
                    key={a.email}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setValue('email', a.email, { shouldValidate: true })
                      setValue('password', DEMO_PASSWORD, { shouldValidate: true })
                    }}
                  >
                    {a.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
