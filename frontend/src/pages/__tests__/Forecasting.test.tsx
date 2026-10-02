import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiError } from '@/lib/api'
import type { ForecastRun, ForecastWithHistory, Job } from '@/lib/types'
import ForecastingPage from '../ForecastingPage'
import { buildChartRows, describeBias } from '../forecasting/lib'
import ReportsPage from '../ReportsPage'
import { createSchema, editSchema } from '../settings/schemas'
import SettingsPage from '../SettingsPage'

// ---------------------------------------------------------------- mocks
const get = vi.fn()
const post = vi.fn()
const patch = vi.fn()

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), delete: vi.fn() },
    downloadCsv: vi.fn().mockResolvedValue(undefined),
  }
})

const can = vi.fn((_p: string) => true)
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { id: 1, email: 'admin@example.com', full_name: 'System Administrator', role: 'ADMIN', is_active: true, last_login_at: null, created_at: '2026-01-01T00:00:00Z' },
    can,
    loading: false,
  }),
}))

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
})

function page<T>(items: T[]) {
  return { items, total: items.length, page: 1, page_size: 25, pages: 1 }
}

const RUN: ForecastRun = {
  id: 9,
  product_id: 1,
  sku: 'ELEC-USBC-1M',
  product_name: 'USB-C Cable 1m',
  warehouse_id: 1,
  warehouse_code: 'WH-NORTH',
  horizon_days: 3,
  model_name: 'holt_winters',
  model_version: '1.0/1.1',
  generated_at: '2026-10-02T01:00:00Z',
  total_predicted: 60,
  avg_daily_demand: 20,
  history_days: 365,
  history_start: '2025-10-02',
  history_end: '2026-10-01',
  metrics: { mae: 3.6, rmse: 4.4, wape: 0.2, mape: 0.23, bias: 0.24, holdout_days: 42 },
  details: {
    profile: { pattern: 'smooth', zero_ratio: 0.01, mean: 18, n_days: 365, adi: 1, cv2: 0.08 },
    backtest: { folds: 3, fold_days: 14, evaluated_days: 42 },
    selection: 'auto',
    selection_metric: 'mae',
    candidates: {
      holt_winters: { mae: 3.6, rmse: 4.4, wape: 0.2 },
      moving_average: { mae: 3.7, rmse: 4.9, wape: 0.21 },
      seasonal_naive: { error: 'did not converge' },
    },
    interval: { level: 0.8, method: 'empirical holdout residual std', sigma: 4.5 },
  },
  points: [
    { date: '2026-10-02', predicted: 19, lower: 13, upper: 25 },
    { date: '2026-10-03', predicted: 21, lower: 15, upper: 27 },
    { date: '2026-10-04', predicted: 20, lower: 14, upper: 26 },
  ],
}

const HISTORY = Array.from({ length: 10 }, (_, i) => ({ date: `2026-09-${String(21 + i).padStart(2, '0')}`, quantity: 15 + (i % 3) }))

let itemResponse: ForecastWithHistory
let jobState: Job

function routeGet(path: string, query?: Record<string, unknown>) {
  switch (path) {
    case '/products':
      return Promise.resolve(page([{ id: 1, sku: 'ELEC-USBC-1M', name: 'USB-C Cable 1m', unit: 'pcs' }]))
    case '/warehouses':
      return Promise.resolve(page([{ id: 1, code: 'WH-NORTH', name: 'North', status: 'ACTIVE' }, { id: 2, code: 'WH-SOUTH', name: 'South', status: 'ACTIVE' }]))
    case '/inventory':
      return Promise.resolve(page([{ id: 5, product_id: 1, warehouse_id: 1 }]))
    case '/forecasts/item':
      return Promise.resolve(itemResponse)
    case '/forecasts':
      return Promise.resolve(page([{ ...RUN, points: undefined }]))
    case '/reports/forecast-accuracy':
      return Promise.resolve({ by_model: [{ model_name: 'holt_winters', items: 3, avg_mae: 2.5, avg_wape: 0.3, total_predicted: 100, last_generated_at: RUN.generated_at }], items_forecasted: 3, last_generated_at: RUN.generated_at })
    case '/jobs':
      return Promise.resolve(page(query?.type === 'FORECAST_ALL' ? [] : [jobState].filter(Boolean)))
    case '/users':
      return Promise.resolve(page([{ id: 1, email: 'admin@example.com', full_name: 'System Administrator', role: 'ADMIN', is_active: true, last_login_at: null, created_at: '2026-01-01T00:00:00Z' }]))
    case '/auth/permissions':
      return Promise.resolve({ role: ['ADMIN'], permissions: ['manage_users', 'run_forecasts'] })
    case '/reports/forecast-aggregate':
      return Promise.resolve([])
    case '/reports/purchase-orders':
      return Promise.resolve({ by_status: [{ status: 'CONFIRMED', count: 2, value: 100, outstanding_units: 5 }], overdue: [{ id: 7, po_number: 'PO-7', supplier_name: 'Acme', expected_delivery_date: '2026-09-20', status: 'CONFIRMED', days_overdue: 12 }] })
    default:
      if (path.startsWith('/jobs/')) return Promise.resolve(jobState)
      return Promise.resolve(page([]))
  }
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.search}</div>
}

function renderAt(url: string, el: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="*" element={<>{el}<LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  get.mockReset().mockImplementation(routeGet)
  post.mockReset()
  patch.mockReset()
  can.mockImplementation(() => true)
  itemResponse = { forecast: RUN, history: HISTORY }
  jobState = undefined as unknown as Job
})

// ---------------------------------------------------------------- pure helpers
describe('forecast helpers', () => {
  it('merges history and forecast points, skipping overlap and computing a 7-day average', () => {
    const rows = buildChartRows({ forecast: { ...RUN, points: [{ date: HISTORY[HISTORY.length - 1].date, predicted: 1, lower: 0, upper: 2 }, ...RUN.points] }, history: HISTORY }, true)
    expect(rows).toHaveLength(HISTORY.length + RUN.points.length)
    expect(rows[5].ma7).toBeUndefined()
    expect(rows[6].ma7).toBeCloseTo(HISTORY.slice(0, 7).reduce((s, h) => s + h.quantity, 0) / 7, 2)
    const firstForecast = rows.find((r) => r.forecast != null)!
    expect(firstForecast.date).toBe('2026-10-02')
    expect(firstForecast.band).toEqual([13, 25])
    expect(firstForecast.actual).toBeUndefined()
  })

  it('describes bias direction relative to mean demand', () => {
    expect(describeBias(2, 10).text).toMatch(/Over-forecasting by 2 units\/day \(20%\)/)
    expect(describeBias(-1, 10).text).toMatch(/Under-forecasting/)
    expect(describeBias(0.01, 10).text).toBe('Unbiased')
    expect(describeBias(null).text).toBe('—')
  })
})

describe('user form schemas', () => {
  it('requires 10+ character passwords with letters and digits', () => {
    const base = { email: 'a@b.co', full_name: 'A', role: 'ANALYST' as const }
    expect(createSchema.safeParse({ ...base, password: 'short1' }).success).toBe(false)
    expect(createSchema.safeParse({ ...base, password: 'abcdefghijk' }).success).toBe(false)
    expect(createSchema.safeParse({ ...base, password: 'abcdefghij1' }).success).toBe(true)
    expect(createSchema.safeParse({ ...base, email: 'nope', password: 'abcdefghij1' }).success).toBe(false)
  })
  it('allows a blank new password when editing', () => {
    expect(editSchema.safeParse({ full_name: 'A', role: 'ADMIN', is_active: true, password: '' }).success).toBe(true)
    expect(editSchema.safeParse({ full_name: 'A', role: 'ADMIN', is_active: true, password: 'short' }).success).toBe(false)
  })
})

// ---------------------------------------------------------------- forecasting page
describe('ForecastingPage', () => {
  it('shows the forecast, accuracy metrics and candidate comparison', async () => {
    renderAt('/forecasting?product_id=1&warehouse_id=1', <ForecastingPage />)
    expect(await screen.findByText('Model & accuracy')).toBeInTheDocument()
    expect(screen.getAllByText('60 units').length).toBeGreaterThan(0)
    expect(screen.getByText('3.6', { selector: 'dd' })).toBeInTheDocument()
    expect(screen.getByText('Unbiased')).toBeInTheDocument()
    expect(screen.getByText('3 × 14 days')).toBeInTheDocument()
    expect(screen.getByText(/Failed: did not converge/)).toBeInTheDocument()
    expect(screen.getByText(/MAE was used to pick the model/)).toBeInTheDocument()
    // legend distinguishes actual vs forecast vs interval
    const legend = screen.getByRole('list', { name: 'Chart legend' })
    expect(within(legend).getByText('Actual')).toBeInTheDocument()
    expect(within(legend).getByText('Forecast')).toBeInTheDocument()
    expect(within(legend).getByText('80% interval')).toBeInTheDocument()
    expect(get).toHaveBeenCalledWith('/forecasts/item', { product_id: 1, warehouse_id: 1, history_days: 90 }, expect.anything())
  })

  it('runs a forecast in the background and refetches when the job succeeds', async () => {
    itemResponse = { forecast: null, history: HISTORY }
    const queued: Job = { id: 'job-1', type: 'FORECAST_ITEM', status: 'QUEUED', params: { product_id: 1, warehouse_id: 1, horizon_days: 14, model: 'croston' }, result: null, error: null, progress: 0, created_at: new Date().toISOString(), started_at: null, finished_at: null }
    post.mockResolvedValue(queued)
    jobState = queued
    const user = userEvent.setup()
    renderAt('/forecasting?product_id=1&warehouse_id=1&horizon=14&model=croston', <ForecastingPage />)
    expect(await screen.findByText('No forecast yet for this item')).toBeInTheDocument()
    const runButtons = screen.getAllByRole('button', { name: /run forecast/i })
    await user.click(runButtons[0])
    expect(post).toHaveBeenCalledWith('/forecasts/run', { product_id: 1, warehouse_id: 1, horizon_days: 14, model: 'croston' })
    expect(await screen.findByText(/waiting for the background worker/)).toBeInTheDocument()

    // worker finishes → item forecast is refetched and rendered
    itemResponse = { forecast: { ...RUN, model_name: 'croston' }, history: HISTORY }
    jobState = { ...queued, status: 'SUCCEEDED', progress: 100, result: { forecast_run_id: 9, model_name: 'croston', total_predicted: 60 }, finished_at: new Date().toISOString() }
    expect(await screen.findByText('Model & accuracy', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.queryByText(/waiting for the background worker/)).not.toBeInTheDocument()
  })

  it('shows the job error when the background job fails', async () => {
    const failed: Job = { id: 'job-2', type: 'FORECAST_ITEM', status: 'FAILED', params: { horizon_days: 30, model: 'auto' }, result: null, error: 'Not enough history', progress: 0, created_at: new Date().toISOString(), started_at: null, finished_at: new Date().toISOString() }
    post.mockResolvedValue(failed)
    jobState = failed
    const user = userEvent.setup()
    renderAt('/forecasting?product_id=1&warehouse_id=1', <ForecastingPage />)
    await screen.findByText('Model & accuracy')
    await user.click(screen.getByRole('button', { name: /run forecast/i }))
    expect(await screen.findByText('Not enough history')).toBeInTheDocument()
  })

  it('shows an empty state when the item has no sales history', async () => {
    itemResponse = { forecast: null, history: HISTORY.map((h) => ({ ...h, quantity: 0 })) }
    renderAt('/forecasting?product_id=1&warehouse_id=1', <ForecastingPage />)
    expect(await screen.findByText('No sales history')).toBeInTheDocument()
  })

  it('hides run actions without the run_forecasts permission', async () => {
    can.mockImplementation((p: string) => p !== 'run_forecasts')
    renderAt('/forecasting?product_id=1&warehouse_id=1', <ForecastingPage />)
    await screen.findByText('Model & accuracy')
    expect(screen.queryByRole('button', { name: /run forecast/i })).not.toBeInTheDocument()
    expect(screen.getByText(/can view forecasts but not run them/)).toBeInTheDocument()
  })

  it('loads a row from the latest forecasts table into the URL', async () => {
    const user = userEvent.setup()
    renderAt('/forecasting?product_id=1&warehouse_id=2', <ForecastingPage />)
    const table = await screen.findByRole('table', { name: 'Latest forecasts' })
    await user.click(within(table).getByText('USB-C Cable 1m'))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('warehouse_id=1'))
  })
})

// ---------------------------------------------------------------- reports & settings
describe('ReportsPage', () => {
  it('keeps the selected tab in the URL and renders the PO report', async () => {
    const user = userEvent.setup()
    renderAt('/reports?tab=purchase-orders', <ReportsPage />)
    expect(await screen.findByText('PO-7')).toBeInTheDocument()
    expect(screen.getByText('12 days')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /forecasts/i }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('?tab=forecasts'))
  })
})

describe('Settings › users', () => {
  it('validates the create form and maps a duplicate email error onto the field', async () => {
    post.mockRejectedValue(new ApiError(409, 'DUPLICATE', 'A user with this email already exists'))
    const user = userEvent.setup()
    renderAt('/settings?tab=users', <SettingsPage />)
    await user.click(await screen.findByRole('button', { name: /add user/i }))
    await user.type(screen.getByLabelText(/full name/i), 'New Person')
    await user.type(screen.getByLabelText(/^email/i), 'admin@example.com')
    await user.type(screen.getByLabelText(/initial password/i), 'abcdefghijk')
    await user.click(screen.getByRole('button', { name: /create user/i }))
    expect(await screen.findByText('Must contain both letters and digits')).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()

    await user.clear(screen.getByLabelText(/initial password/i))
    await user.type(screen.getByLabelText(/initial password/i), 'abcdefghij1')
    await user.click(screen.getByRole('button', { name: /create user/i }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/users', { email: 'admin@example.com', full_name: 'New Person', role: 'ANALYST', password: 'abcdefghij1' }))
    expect(await screen.findByText('A user with this email already exists')).toBeInTheDocument()
  })

  it('hides the users tab without manage_users', async () => {
    can.mockImplementation((p: string) => p !== 'manage_users')
    renderAt('/settings?tab=users', <SettingsPage />)
    expect(await screen.findByText('Your profile')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /users/i })).not.toBeInTheDocument()
  })
})
