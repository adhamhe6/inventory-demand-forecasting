import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiError } from '@/lib/api'
import type { Product, PurchaseOrder, RestockRecommendation, Supplier, Warehouse } from '@/lib/types'
import { poSchema } from '../purchasing/poForm'
import PurchaseOrderCreatePage from '../purchasing/PurchaseOrderCreatePage'
import { ReceiveDialog } from '../purchasing/ReceiveDialog'
import { addDaysIso, todayIso } from '../purchasing/utils'
import RestockingPage from '../RestockingPage'
import { buildRestockPlan, qtyError } from '../risk/restockUtils'
import { ImportSalesDialog } from '../sales/ImportSalesDialog'
import { RecordSaleDialog } from '../sales/RecordSaleDialog'

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: apiMock }))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ can: () => true, user: { role: 'ADMIN' } }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const ts = '2026-01-01T00:00:00Z'
const supplier: Supplier = {
  id: 6,
  name: 'PackRight Packaging',
  contact_name: 'Tom',
  email: null,
  phone: null,
  address: null,
  payment_terms: 'Net 10',
  lead_time_days: 3,
  status: 'ACTIVE',
  created_at: ts,
  updated_at: ts,
}
const warehouse: Warehouse = { id: 1, code: 'WH-NORTH', name: 'North DC', location: null, status: 'ACTIVE', created_at: ts, updated_at: ts }
const mkProduct = (id: number, sku: string, cost: string, supplierId: number | null): Product => ({
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
  is_active: true,
  supplier_id: supplierId,
  supplier: supplierId ? { id: supplierId, name: 'PackRight Packaging', lead_time_days: 3 } : null,
  created_at: ts,
  updated_at: ts,
})
const products = [mkProduct(10, 'PKG-BOX-M', '0.45', 6), mkProduct(11, 'PKG-TAPE-48', '1.20', 6), mkProduct(12, 'ELEC-HUB', '9.00', null)]
const page = <T,>(items: T[]) => ({ items, total: items.length, page: 1, page_size: 25, pages: 1 })

function wrap(ui: ReactNode, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={ui} />
            <Route path="/purchase-orders/:id" element={<p>PO detail route</p>} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.get.mockImplementation(async (path: string) => {
    if (path === '/suppliers') return page([supplier])
    if (path === '/warehouses') return page([warehouse])
    if (path === '/products') return page(products)
    if (path === '/inventory') return page([])
    return page([])
  })
})

describe('poSchema', () => {
  const base = { supplier_id: 6, warehouse_id: 1, expected_delivery_date: addDaysIso(3), notes: '' }
  it('rejects duplicate products, past dates and non-integer quantities', () => {
    const r = poSchema(todayIso()).safeParse({
      ...base,
      expected_delivery_date: addDaysIso(-1),
      lines: [
        { product_id: 10, quantity: 2, unit_cost: '1.00' },
        { product_id: 10, quantity: 1.5, unit_cost: '1.234' },
      ],
    })
    expect(r.success).toBe(false)
    const paths = r.error!.issues.map((i) => i.path.join('.'))
    expect(paths).toEqual(expect.arrayContaining(['expected_delivery_date', 'lines.1.product_id', 'lines.1.quantity', 'lines.1.unit_cost']))
  })
  it('accepts a valid order', () => {
    expect(poSchema(todayIso()).safeParse({ ...base, lines: [{ product_id: 10, quantity: 3, unit_cost: '0.45' }] }).success).toBe(true)
  })
})

describe('PurchaseOrderCreatePage', () => {
  it('prefills supplier from the URL, defaults the date from lead time, validates and posts the order', async () => {
    const user = userEvent.setup()
    apiMock.post.mockResolvedValue({ id: 999, po_number: 'PO-1', line_count: 1, total_amount: '4.50' })
    wrap(<PurchaseOrderCreatePage />, '/new?supplier_id=6')

    await waitFor(() => expect(screen.getByLabelText(/^Supplier/)).toHaveValue('6'))
    expect(screen.getByLabelText(/^Expected delivery/)).toHaveValue(addDaysIso(3))
    expect(screen.getByText('Net 10')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText(/Deliver to warehouse/)).toHaveValue('1')) // only active warehouse auto-selected

    await user.click(screen.getByRole('button', { name: /Review & create/ }))
    await waitFor(() => expect(screen.getAllByRole('alert').map((e) => e.textContent)).toContain('Select a product'))
    expect(screen.getByText('Must be greater than 0')).toBeInTheDocument()
    expect(apiMock.post).not.toHaveBeenCalled()

    await user.selectOptions(screen.getByLabelText('Product for line 1'), '10')
    expect(screen.getByLabelText('Unit cost for line 1')).toHaveValue(0.45) // defaults to product cost
    await user.type(screen.getByLabelText('Quantity for line 1'), '10')
    expect(screen.getByLabelText('Line 1 total')).toHaveTextContent('$4.50')

    await user.click(screen.getByRole('button', { name: /Review & create/ }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Create draft' }))
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/purchase-orders', {
        supplier_id: 6,
        warehouse_id: 1,
        expected_delivery_date: addDaysIso(3),
        notes: null,
        lines: [{ product_id: 10, quantity_ordered: 10, unit_cost: '0.45' }],
      }),
    )
    expect(await screen.findByText('PO detail route')).toBeInTheDocument()
  })

  it('maps server validation errors onto line fields', async () => {
    const user = userEvent.setup()
    apiMock.post.mockRejectedValue(
      new ApiError(422, 'VALIDATION_ERROR', 'Invalid', [{ field: 'lines.0.quantity_ordered', message: 'Input should be less than or equal to 1000000' }]),
    )
    wrap(<PurchaseOrderCreatePage />, '/new?supplier_id=6')
    await waitFor(() => expect(screen.getByLabelText(/^Supplier/)).toHaveValue('6'))
    await user.selectOptions(screen.getByLabelText('Product for line 1'), '11')
    await user.type(screen.getByLabelText('Quantity for line 1'), '5')
    await user.click(screen.getByRole('button', { name: /Review & create/ }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Create draft' }))
    expect(await screen.findByText('Input should be less than or equal to 1000000')).toBeInTheDocument()
  })
})

const po: PurchaseOrder = {
  id: 5,
  po_number: 'PO-2026-000005',
  supplier_id: 6,
  supplier_name: 'PackRight Packaging',
  warehouse_id: 1,
  warehouse_code: 'WH-NORTH',
  status: 'CONFIRMED',
  order_date: '2026-09-01',
  expected_delivery_date: '2026-09-05',
  received_date: null,
  total_amount: '10.50',
  total_units: 15,
  received_units: 2,
  line_count: 2,
  created_at: ts,
  notes: null,
  submitted_at: ts,
  receipts: [],
  allowed_transitions: ['CANCELLED', 'PARTIALLY_RECEIVED', 'RECEIVED'],
  lines: [
    { id: 101, product_id: 10, sku: 'PKG-BOX-M', product_name: 'Box', quantity_ordered: 10, quantity_received: 2, quantity_outstanding: 8, unit_cost: '0.45', line_total: '4.50' },
    { id: 102, product_id: 11, sku: 'PKG-TAPE-48', product_name: 'Tape', quantity_ordered: 5, quantity_received: 0, quantity_outstanding: 5, unit_cost: '1.20', line_total: '6.00' },
  ],
}

describe('ReceiveDialog', () => {
  it('defaults to outstanding, blocks over-receipt and sends a stable receipt reference', async () => {
    const user = userEvent.setup()
    apiMock.post.mockResolvedValue({
      purchase_order: { ...po, status: 'PARTIALLY_RECEIVED' },
      receipt: { id: 1, receipt_key: 'GRN-X', received_at: ts, received_by_id: 1, notes: null, lines: [{ purchase_order_line_id: 101, product_id: 10, sku: 'PKG-BOX-M', quantity: 3 }] },
      replayed: false,
    })
    wrap(<ReceiveDialog po={po} open onOpenChange={() => {}} />)
    const box = screen.getByLabelText('Receive quantity for PKG-BOX-M')
    expect(box).toHaveValue(8)
    expect(screen.getByLabelText('Receive quantity for PKG-TAPE-48')).toHaveValue(5)

    await user.clear(box)
    await user.type(box, '9')
    await user.click(screen.getByRole('button', { name: /Receive 14 units/ }))
    expect(await screen.findByText('Only 8 outstanding')).toBeInTheDocument()

    await user.clear(box)
    await user.type(box, '3')
    const tape = screen.getByLabelText('Receive quantity for PKG-TAPE-48')
    await user.clear(tape)
    await user.type(tape, '0')
    await user.click(screen.getByRole('button', { name: /Receive 3 units/ }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Receive into stock' }))

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1))
    const [path, body] = apiMock.post.mock.calls[0]
    expect(path).toBe('/purchase-orders/5/receive')
    expect(body.lines).toEqual([{ line_id: 101, quantity: 3 }])
    expect(body.receipt_reference).toMatch(/^GRN-\d{8}-\d{6}$/)
    expect(toast.success).toHaveBeenCalled()
  })

  it('reports a replayed receipt without claiming stock changed', async () => {
    const user = userEvent.setup()
    apiMock.post.mockResolvedValue({
      purchase_order: po,
      receipt: { id: 1, receipt_key: 'DN-77', received_at: ts, received_by_id: 1, notes: null, lines: [] },
      replayed: true,
    })
    wrap(<ReceiveDialog po={po} open onOpenChange={() => {}} />)
    await user.type(screen.getByLabelText(/Delivery note/), 'DN-77')
    await user.click(screen.getByRole('button', { name: /Receive 13 units/ }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Receive into stock' }))
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('DN-77'), { description: 'Already received — no stock changed.' }))
    expect(apiMock.post.mock.calls[0][1].receipt_reference).toBe('DN-77')
  })
})

describe('RecordSaleDialog', () => {
  it('shows INSUFFICIENT_STOCK on the quantity field and sends an Idempotency-Key', async () => {
    const user = userEvent.setup()
    apiMock.post.mockRejectedValue(new ApiError(422, 'INSUFFICIENT_STOCK', 'Insufficient available stock: requested 50, available 4'))
    wrap(<RecordSaleDialog open onOpenChange={() => {}} />)
    await waitFor(() => expect(screen.getAllByRole('option', { name: /PKG-BOX-M/ }).length).toBeGreaterThan(0))
    await user.selectOptions(screen.getByLabelText(/^Product/), '10')
    await user.selectOptions(screen.getByLabelText(/^Warehouse/), '1')
    await user.type(screen.getByLabelText(/^Quantity/), '50')
    await user.type(screen.getByLabelText(/^Order reference/), 'SO-1')
    await user.click(screen.getByRole('button', { name: 'Record sale' }))
    expect(await screen.findByText('Insufficient available stock: requested 50, available 4')).toHaveAttribute('id', 'sale-qty-error')
    const [path, body, headers] = apiMock.post.mock.calls[0]
    expect(path).toBe('/sales')
    expect(body).toMatchObject({ product_id: 10, warehouse_id: 1, quantity: 50, order_reference: 'SO-1', issue_stock: true, unit_price: null })
    expect(headers['Idempotency-Key']).toBeTruthy()
  })
})

describe('ImportSalesDialog', () => {
  it('uploads multipart, polls the job and shows counts and row errors', async () => {
    const user = userEvent.setup()
    apiMock.post.mockResolvedValue({ id: 'job-1', status: 'QUEUED', progress: 0 })
    apiMock.get.mockImplementation(async (path: string) => {
      if (path === '/jobs/job-1')
        return {
          id: 'job-1',
          type: 'IMPORT_SALES',
          status: 'SUCCEEDED',
          progress: 100,
          params: {},
          error: null,
          created_at: ts,
          started_at: ts,
          finished_at: ts,
          result: { total_rows: 3, inserted: 1, duplicates: 1, invalid: 1, errors: [{ line: 4, error: "unknown sku 'NOPE'" }], errors_truncated: false },
        }
      return page([])
    })
    wrap(<ImportSalesDialog open onOpenChange={() => {}} />)
    expect(screen.getByRole('button', { name: /Upload & import/ })).toBeDisabled()
    // Wrong extension is rejected client-side.
    fireEvent.change(screen.getByLabelText(/Choose a CSV file/), { target: { files: [new File(['x'], 'sales.xlsx')] } })
    expect(await screen.findByText('Choose a .csv file')).toBeInTheDocument()

    const file = new File(['sku,warehouse_code,sold_at,quantity,order_reference\n'], 'sales.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText(/Choose a CSV file/), { target: { files: [file] } })
    await user.click(screen.getByRole('button', { name: /Upload & import/ }))
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled())
    const [path, body] = apiMock.post.mock.calls[0]
    expect(path).toBe('/sales/import')
    expect(body).toBeInstanceOf(FormData)
    expect((body as FormData).get('file')).toBeInstanceOf(File)

    expect(await screen.findByText("unknown sku 'NOPE'")).toBeInTheDocument()
    expect(screen.getByText('Duplicates skipped').nextSibling).toHaveTextContent('1')
    expect(screen.getByText('Invalid').nextSibling).toHaveTextContent('1')
  })
})

const rec = (id: number, extra: Partial<RestockRecommendation>): RestockRecommendation => ({
  inventory_item_id: id,
  product_id: id,
  sku: `SKU-${id}`,
  product_name: `Item ${id}`,
  category: 'Packaging',
  warehouse_id: 1,
  warehouse_code: 'WH-NORTH',
  warehouse_name: 'North',
  supplier_id: 6,
  supplier_name: 'PackRight Packaging',
  available_quantity: 1,
  inbound_quantity: 0,
  inventory_position: 1,
  avg_daily_demand: 2,
  lead_time_days: 3,
  review_period_days: 14,
  demand_during_lead_time: 6,
  safety_stock: 2,
  reorder_point: 8,
  order_up_to_level: 36,
  recommended_quantity: 35,
  unit_cost: 2,
  estimated_cost: 70,
  risk_level: 'CRITICAL',
  demand_source: 'FORECAST',
  rationale: 'Position below reorder point',
  ...extra,
})

describe('RestockingPage', () => {
  it('requires a supplier for unassigned products and posts selected items with edited quantities', async () => {
    const user = userEvent.setup()
    apiMock.get.mockImplementation(async (path: string) => {
      if (path === '/restocking')
        return {
          ...page([rec(1, {}), rec(2, { supplier_id: null, supplier_name: null, risk_level: 'HIGH' })]),
          summary: { items: 2, total_units: 70, total_estimated_cost: 140, critical: 1, without_supplier: 1 },
        }
      if (path === '/suppliers') return page([supplier])
      if (path === '/warehouses') return page([warehouse])
      return page([])
    })
    apiMock.post.mockResolvedValue({ purchase_order_ids: [70, 71], po_numbers: ['PO-70', 'PO-71'] })
    wrap(<RestockingPage />, '/restocking')

    await screen.findByLabelText('Select SKU-1 for WH-NORTH')
    // Server-side sort + pagination parameters are sent; totals come from the server summary.
    expect(apiMock.get).toHaveBeenCalledWith('/restocking', expect.objectContaining({ sort: 'risk', page: 1, page_size: 50 }), expect.anything())
    expect(screen.getByText('$140.00')).toBeInTheDocument()
    const box2 = screen.getByLabelText('Select SKU-2 for WH-NORTH')
    expect(box2).toBeDisabled()
    // Supplier picker (rendered in the product cell and the supplier column) unlocks the row.
    await user.selectOptions(screen.getAllByLabelText('Supplier for SKU-2 at WH-NORTH')[0], '6')
    // The row re-renders without its "why disabled" tooltip wrapper, so query again.
    const box2b = screen.getByLabelText('Select SKU-2 for WH-NORTH')
    expect(box2b).toBeEnabled()

    const qty = screen.getByLabelText('Order quantity for SKU-1 at WH-NORTH')
    await user.clear(qty)
    await user.type(qty, '40')
    await user.click(screen.getByLabelText('Select SKU-1 for WH-NORTH'))
    await user.click(box2b)
    await user.click(screen.getByRole('button', { name: /Create purchase orders/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getAllByText('$150.00')).toHaveLength(2) // 40×2 + 35×2, one supplier×warehouse group
    await user.click(within(dialog).getByRole('button', { name: 'Create drafts' }))
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/restocking/purchase-orders', {
        items: [
          { product_id: 1, warehouse_id: 1, quantity: 40 },
          { product_id: 2, warehouse_id: 1, quantity: 35, supplier_id: 6 },
        ],
      }),
    )
    expect(await screen.findByRole('link', { name: 'PO-70' })).toHaveAttribute('href', '/purchase-orders/70')
  })
})

describe('pure helpers', () => {
  it('validates restock quantities and groups plans by supplier × warehouse', () => {
    expect(qtyError('')).toBe('Required')
    expect(qtyError('1.5')).toBe('Whole units')
    expect(qtyError('0')).toBe('Must be > 0')
    expect(qtyError('12')).toBeNull()
    const rows = [rec(1, {}), rec(2, { warehouse_id: 2, warehouse_code: 'WH-SOUTH' }), rec(3, {})]
    const plan = buildRestockPlan(rows, { qtyOf: (r) => String(r.recommended_quantity), supplierOf: (r) => r.supplier_id, supplierName: () => 'x' })
    expect(plan.groups).toHaveLength(2)
    expect(plan.total).toBe(210)
  })
})
