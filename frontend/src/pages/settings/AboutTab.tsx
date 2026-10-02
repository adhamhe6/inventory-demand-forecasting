import { BookOpen, Cpu, Database, ExternalLink, Layers, LineChart, Server } from 'lucide-react'
import { useMeta } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { API_BASE } from '@/lib/api'
import { toLevelPct } from '../forecasting/lib'

function stack(intervalPct: number | null) {
  return [
    { icon: Layers, title: 'Web app', body: 'React and TypeScript, built with Vite; Tailwind CSS, Radix UI primitives, TanStack Query and Recharts.' },
    { icon: Server, title: 'API', body: 'FastAPI (Python) with async SQLAlchemy, JWT auth, role-based permissions and CSV exports.' },
    { icon: Database, title: 'Data', body: 'PostgreSQL for the stock ledger, catalog and forecasts; Redis for caching and the job queue.' },
    { icon: Cpu, title: 'Background worker', body: 'Runs forecasts and sales imports off the request path, with progress tracking and de-duplication.' },
    {
      icon: LineChart,
      title: 'Forecasting',
      body: `Moving average, weekly seasonal naive, Holt-Winters and Croston (SBA), auto-selected per item by rolling-origin backtests, with ${intervalPct == null ? '' : `${intervalPct}% `}prediction intervals.`,
    },
  ]
}

export function AboutTab() {
  const meta = useMeta()
  const version = meta.data?.version
  const STACK = stack(toLevelPct(meta.data?.forecast_interval_level))
  return (
    <div className="grid gap-6 [&>*]:min-w-0 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle>StockSense</CardTitle>
          <CardDescription>
            Inventory management and demand forecasting
            {version ? ` · version ${version}` : meta.isLoading ? ' · loading version…' : ''}
            {meta.data?.environment && meta.data.environment !== 'production' ? ` · ${meta.data.environment}` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-4 sm:grid-cols-2">
            {STACK.map((s) => (
              <li key={s.title} className="flex gap-3 rounded-lg border p-4">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <s.icon className="size-4" aria-hidden />
                </div>
                <div>
                  <p className="text-sm font-semibold">{s.title}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{s.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card className="self-start">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="size-4 text-muted-foreground" aria-hidden /> API
          </CardTitle>
          <CardDescription>Every screen is built on the public REST API.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">Base URL</dt>
            <dd className="break-all font-mono text-xs">{API_BASE}</dd>
            <dt className="text-muted-foreground">Auth</dt>
            <dd>Bearer token (JWT)</dd>
            <dt className="text-muted-foreground">Errors</dt>
            <dd className="font-mono text-xs">{'{ error: { code, message } }'}</dd>
          </dl>
          <Button variant="outline" asChild className="w-full">
            <a href="/docs" target="_blank" rel="noreferrer">
              Interactive API docs <ExternalLink />
            </a>
          </Button>
          <p className="text-xs text-muted-foreground">The docs are served by the API at /docs (proxied in the Docker deployment).</p>
        </CardContent>
      </Card>
    </div>
  )
}
