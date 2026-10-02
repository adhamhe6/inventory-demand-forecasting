import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiError } from '@/lib/api'
import type { Product, PurchaseOrder, StockRisk, Supplier, User, Warehouse } from '@/lib/types'
import { EditDraftDialog } from '../purchasing/EditDraftDialog'
import PurchaseOrderCreatePage from '../purchasing/PurchaseOrderCreatePage'
import { ForecastsReport, ShortagesReport } from '../reports/PlanningReports'
import { PurchaseOrdersReport } from '../reports/PurchasingReports'
import { SalesReport } from '../reports/SalesReport'
import { CreateUserDialog, EditUserDialog } from '../settings/UserDialog'
import { LookupError } from '../shared/LookupError'

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: apiMock }))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ can: () => true, user: { role: 'ADMIN' } }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const ts = '2026-01-01T00:00:00Z'
const supplier: Supplier = {
  id: 6,
  name: 'PackRight Packaging',
  contact_name: null,
  email: null,
  phone: null,
  address: null,
  payment_terms: null,
  lead_time_days: 3,
  status: 'ACTIVE',
  created_at: ts,
  updated_at: ts,
}
const warehouse: Warehouse = { id: 1, code: 'WH-NORTH', name: 'North DC', location: null, status: 'ACTIVE', created_at: ts, updated_at: ts }
const mkProduct = (id: number, sku: string, cost: string, isActive = true): Product => ({
  id,
  sku,
  name: `Product ${sku}`,
  description: null,
  category: 'Packaging',
  unit: 'pcs',
  cost,
  price: '9.99',
  min_stock: 0,
  reorder_point: 10,
  safety_stock: 5,
  lead_time_days: 3,
  is_active: isActive,
  supplier_id: 6,
  supplier: { id: 6, name: 'PackRight Packaging', lead_time_days: 3 },
  created_at: ts,
  updated_at: ts,
})
const page = <T,>(items: T[], extra: Record<string, unknown> = {}) => ({ items, total: items.length, page: 1, page_size: 25, pages: 1, ...extra })

function wrap(ui: ReactNode, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={ui} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.get.mockImplementation(async (path: string) => {
    if (path === '/meta') return { version: '2.3.4', forecast_interval_level: 0.9, max_import_file_mb: 20 }
    if (path === '/suppliers') return page([supplier])
    if (path === '/warehouses') return page([warehouse])
    return page([])
  })
})

describe('LookupError', () => {
  it('renders nothing when lookups are fine, and retries only the failed ones', async () => {
    const user = userEvent.setup()
    const ok = { error: null, refetch: vi.fn() }
    const failed = { error: new Error('boom'), refetch: vi.fn() }
    const { rerender } = render(<LookupError lookups={{ warehouses: ok }} />)
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(<LookupError lookups={{ warehouses: failed, categories: ok }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn.t load warehouses for the filters\./)
    await user.click(screen.getByRole('button', { name: /Retry/ }))
    expect(failed.refetch).toHaveBeenCalledTimes(1)
    expect(ok.refetch).not.toHaveBeenCalled()
  })

  it('shows a disabled option and a retry notice when a report filter lookup fails', async () => {
    apiMock.get.mockImplementation(async (path: string) => {
      if (path === '/warehouses') throw new ApiError(500, 'INTERNAL', 'down')
      if (path === '/products/categories') return ['Packaging']
      if (path === '/reports/sales-summary')
        return { date_from: '2026-01-01', date_to: '2026-01-31', granularity: 'week', totals: { units: 0, revenue: 0, orders: 0, avg_order_value: 0 }, series: [{ period: '2026-01-01', units: 0, revenue: 0, orders: 0 }], top_products: [] }
      return page([])
    })
    wrap(<SalesReport />)
    expect(await screen.findByText(/Couldn.t load warehouses for the filters/)).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Couldn.t load — retry/ })).toBeDisabled()
    // Zero-filled series with no units is an empty period, not a flat chart.
    expect(await screen.findByText('No sales in this period')).toBeInTheDocument()
  })
})

describe('ShortagesReport (paged envelope)', () => {
  const risk = (i: number): StockRisk =>
    ({
      inventory_item_id: i,
      product_id: 100 + i,
      sku: `SKU-${i}`,
      product_name: `Item ${i}`,
      warehouse_id: 1,
      warehouse_code: 'WH-NORTH',
      available_quantity: 3,
      days_of_cover: 1.5,
      stockout_date: '2026-10-05',
      risk_level: 'CRITICAL',
    }) as unknown as StockRisk

  it('reads counts from summary.by_risk_level and pages the urgent list', async () => {
    const user = userEvent.setup()
    apiMock.get.mockImplementation(async (path: string, q: Record<string, unknown>) => {
      if (path === '/warehouses') return page([warehouse])
      if (path === '/shortages') {
        const summary = { total_items: 40, by_risk_level: { CRITICAL: 12, HIGH: 9, MEDIUM: 4, LOW: 2, NONE: 13 } }
        if (q.page_size === 1) return { ...page([risk(1)]), total: 27, page_size: 1, summary }
        const p = Number(q.page)
        return { items: Array.from({ length: 10 }, (_, k) => risk((p - 1) * 10 + k + 1)), total: 27, page: p, page_size: 10, pages: 3, summary }
      }
      return page([])
    })
    wrap(<ShortagesReport />, '/reports?tab=shortages')
    expect(await screen.findByText('12')).toBeInTheDocument()
    expect(screen.getByText('9')).toBeInTheDocument()
    expect(screen.getByText(/27 items total/)).toBeInTheDocument()
    expect(screen.getByText('Item 1')).toBeInTheDocument()
    expect(apiMock.get).toHaveBeenCalledWith('/shortages', { min_risk: 'LOW', warehouse_id: '', page: 1, page_size: 10 }, expect.anything())

    await user.click(screen.getByRole('button', { name: /next/i }))
    expect(await screen.findByText('Item 11')).toBeInTheDocument()
    expect(apiMock.get).toHaveBeenCalledWith('/shortages', expect.objectContaining({ page: 2, page_size: 10 }), expect.anything())
    // Per-warehouse chart has a text alternative built from the summary counts.
    expect(await screen.findByRole('img', { name: /WH-NORTH 12 critical, 9 high, 4 medium, 2 low/ })).toBeInTheDocument()
  })
})

describe('ForecastsReport', () => {
  const accuracy = (byModel: Array<{ model_name: string; items: number; avg_wape: number | null }>) => ({
    by_model: byModel.map((m) => ({ ...m, avg_mae: 1, total_predicted: 10, last_generated_at: ts })),
    items_forecasted: byModel.reduce((s, m) => s + m.items, 0),
    last_generated_at: ts,
  })
  const mock = (acc: ReturnType<typeof accuracy>) =>
    apiMock.get.mockImplementation(async (path: string) => {
      if (path === '/meta') return { forecast_interval_level: 0.9 }
      if (path === '/reports/forecast-accuracy') return acc
      if (path === '/reports/forecast-aggregate') return [{ date: '2026-10-03', predicted: 5, lower: 3, upper: 7 }]
      return page([])
    })

  it('weights WAPE only over models that report one and labels the interval from /meta', async () => {
    mock(
      accuracy([
        { model_name: 'croston', items: 10, avg_wape: 0.2 },
        { model_name: 'holt_winters', items: 30, avg_wape: 0.4 },
        { model_name: 'moving_average', items: 60, avg_wape: null },
      ]),
    )
    wrap(<ForecastsReport />)
    // (0.2*10 + 0.4*30) / 40 = 35% — the null model is excluded from numerator and denominator.
    expect(await screen.findByText('35%')).toBeInTheDocument()
    expect(await screen.findByText(/summed 90% interval/)).toBeInTheDocument()
  })

  it('shows a dash when no model has a WAPE', async () => {
    mock(accuracy([{ model_name: 'moving_average', items: 5, avg_wape: null }]))
    wrap(<ForecastsReport />)
    expect(await screen.findByText('no measurable backtests')).toBeInTheDocument()
  })
})

describe('PurchaseOrdersReport overdue', () => {
  it('shows the total overdue_count and notes when the list is capped', async () => {
    const overdue = [1, 2].map((id) => ({ id, po_number: `PO-${id}`, supplier_name: 'PackRight', expected_delivery_date: '2026-09-01', status: 'SUBMITTED', days_overdue: 30 - id }))
    apiMock.get.mockImplementation(async (path: string) => {
      if (path === '/reports/purchase-orders')
        return { by_status: [{ status: 'SUBMITTED', count: 40, value: 1000, outstanding_units: 50 }], overdue_count: 37, overdue_list_limit: 2, overdue }
      return page([])
    })
    wrap(<PurchaseOrdersReport />)
    expect(await screen.findByText('37')).toBeInTheDocument()
    expect(screen.getByText(/showing the first 2 of 37/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /open purchase orders by status: Submitted 40/ })).toBeInTheDocument()
  })

  it('shows an empty pipeline state when nothing is open', async () => {
    apiMock.get.mockImplementation(async (path: string) => {
      if (path === '/reports/purchase-orders') return { by_status: [{ status: 'RECEIVED', count: 3, value: 10, outstanding_units: 0 }], overdue_count: 0, overdue_list_limit: 50, overdue: [] }
      return page([])
    })
    wrap(<PurchaseOrdersReport />)
    expect(await screen.findByText('No open purchase orders')).toBeInTheDocument()
  })
})

describe('PurchaseOrderCreatePage prefill', () => {
  it('seeds the first line from product_id and quantity, with the product cost', async () => {
    apiMock.get.mockImplementation(async (path: string) => {
      if (path === '/suppliers') return page([supplier])
      if (path === '/warehouses') return page([warehouse])
      if (path === '/products') return page([mkProduct(10, 'PKG-BOX-M', '0.45'), mkProduct(11, 'PKG-TAPE', '1.20')])
      return page([])
    })
    wrap(<PurchaseOrderCreatePage />, '/purchase-orders/new?supplier_id=6&warehouse_id=1&product_id=11&quantity=40')
    await waitFor(() => expect(screen.getByLabelText('Product for line 1')).toHaveValue('11'))
    expect(screen.getByLabelText('Quantity for line 1')).toHaveValue(40)
    await waitFor(() => expect(screen.getByLabelText('Unit cost for line 1')).toHaveValue(1.2))
    expect(screen.getByLabelText(/^Supplier/)).toHaveValue('6')
    expect(screen.getByLabelText('Line 1 total')).toHaveTextContent('$48.00')
  })
})

describe('EditDraftDialog', () => {
  it('keeps lines whose product is inactive, but does not offer inactive products for other lines', async () => {
    apiMock.get.mockImplementation(async (path: string, q: Record<string, unknown>) => {
      if (path === '/products') {
        expect(q.is_active).toBeUndefined() // includeInactive
        return page([mkProduct(10, 'PKG-BOX-M', '0.45'), mkProduct(12, 'OLD-ITEM', '2.00', false)])
      }
      return page([])
    })
    const po = {
      id: 5,
      po_number: 'PO-5',
      supplier_id: 6,
      supplier_name: 'PackRight',
      warehouse_id: 1,
      warehouse_code: 'WH-NORTH',
      order_date: '2026-09-01',
      expected_delivery_date: '2026-12-01',
      notes: null,
      created_at: ts,
      lines: [
        { id: 1, product_id: 12, sku: 'OLD-ITEM', product_name: 'Product OLD-ITEM', quantity_ordered: 4, quantity_received: 0, quantity_outstanding: 4, unit_cost: '2.00', line_total: '8.00' },
        { id: 2, product_id: 10, sku: 'PKG-BOX-M', product_name: 'Product PKG-BOX-M', quantity_ordered: 1, quantity_received: 0, quantity_outstanding: 1, unit_cost: '0.45', line_total: '0.45' },
      ],
    } as unknown as PurchaseOrder
    wrap(<EditDraftDialog po={po} open onOpenChange={() => {}} />)
    const first = await screen.findByLabelText('Product for line 1')
    await waitFor(() => expect(first).toHaveValue('12'))
    expect(within(first).getByRole('option', { name: /OLD-ITEM .*\(inactive\)/ })).not.toBeDisabled()
    const second = screen.getByLabelText('Product for line 2')
    expect(second).toHaveValue('10')
    expect(within(second).getByRole('option', { name: /OLD-ITEM .*\(inactive\)/ })).toBeDisabled()
  })
})

describe('UserDialog', () => {
  const target: User = { id: 7, email: 'ana@example.com', full_name: 'Ana Admin', role: 'ADMIN', is_active: true, last_login_at: null, created_at: ts }

  it('closes with an info toast instead of sending an empty PATCH', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    wrap(<EditUserDialog user={target} isSelf={false} onOpenChange={onOpenChange} />)
    await user.click(await screen.findByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('No changes to save'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(apiMock.patch).not.toHaveBeenCalled()
  })

  it('asks for confirmation before deactivating and demoting an admin', async () => {
    const user = userEvent.setup()
    apiMock.patch.mockResolvedValue({ ...target, role: 'ANALYST', is_active: false })
    wrap(<EditUserDialog user={target} isSelf={false} onOpenChange={() => {}} />)
    await user.selectOptions(await screen.findByLabelText(/^Role/), 'ANALYST')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(confirm).toHaveTextContent('Deactivate Ana Admin and remove admin access?')
    expect(apiMock.patch).not.toHaveBeenCalled()
    await user.click(within(confirm).getByRole('button', { name: 'Deactivate user' }))
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/users/7', { role: 'ANALYST', is_active: false }))
  })

  it('saves a plain rename without confirmation', async () => {
    const user = userEvent.setup()
    apiMock.patch.mockResolvedValue({ ...target, full_name: 'Ana B' })
    wrap(<EditUserDialog user={target} isSelf={false} onOpenChange={() => {}} />)
    const name = await screen.findByLabelText(/^Full name/)
    await user.clear(name)
    await user.type(name, 'Ana B')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/users/7', { full_name: 'Ana B' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('maps only DUPLICATE conflicts onto the email field', async () => {
    const user = userEvent.setup()
    apiMock.post.mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'Seat limit reached'))
    wrap(<CreateUserDialog open onOpenChange={() => {}} />)
    await user.type(await screen.findByLabelText(/^Full name/), 'New Person')
    await user.type(screen.getByLabelText(/^Email/), 'new@example.com')
    await user.type(screen.getByLabelText(/^Initial password/), 'abcdef12345')
    await user.click(screen.getByRole('button', { name: 'Create user' }))
    expect(await screen.findByText('Seat limit reached')).toBeInTheDocument()
    expect(screen.queryByText('A user with this email already exists')).toBeNull()

    apiMock.post.mockRejectedValueOnce(new ApiError(409, 'DUPLICATE', 'Duplicate'))
    await user.click(screen.getByRole('button', { name: 'Create user' }))
    expect(await screen.findByText('A user with this email already exists')).toBeInTheDocument()
  })
})
