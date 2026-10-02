import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { Product, Supplier } from '@/lib/types'
import { buildForecastSeries } from '../products/forecastSeries'
import { ProductFormDialog } from '../products/ProductFormDialog'
import ProductsPage from '../products/ProductsPage'
import { SupplierFormDialog } from '../suppliers/SupplierFormDialog'
import { WarehouseFormDialog } from '../warehouses/WarehouseFormDialog'

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: apiMock }))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ can: () => true, user: { role: 'ADMIN' } }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const supplier: Supplier = {
  id: 1,
  name: 'Northwind Electronics',
  contact_name: 'Dana',
  email: 'orders@northwind.example',
  phone: '+1 312 555 0101',
  address: null,
  payment_terms: 'Net 30',
  lead_time_days: 10,
  status: 'ACTIVE',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const product: Product = {
  id: 7,
  sku: 'ELEC-EARBUD-PRO',
  name: 'Wireless Earbuds Pro',
  description: null,
  category: 'Electronics',
  unit: 'pcs',
  cost: '22.00',
  price: '69.99',
  min_stock: 15,
  reorder_point: 93,
  safety_stock: 15,
  lead_time_days: 10,
  is_active: true,
  supplier_id: 1,
  supplier: { id: 1, name: 'Northwind Electronics', lead_time_days: 10 },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const page = <T,>(items: T[]) => ({ items, total: items.length, page: 1, page_size: 25, pages: 1 })

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.get.mockImplementation(async (path: string) => {
    if (path === '/suppliers') return page([supplier])
    if (path === '/products/categories') return ['Electronics', 'Packaging']
    if (path === '/products') return page([product])
    return page([])
  })
})

describe('ProductFormDialog', () => {
  it('validates SKU pattern, money and integers before calling the API', async () => {
    const user = userEvent.setup()
    wrap(<ProductFormDialog open onOpenChange={() => {}} />)
    await user.type(screen.getByLabelText(/^SKU/), '-bad sku')
    await user.type(screen.getByLabelText(/^Name/), 'Thing')
    await user.type(screen.getByLabelText(/^Category/), 'Electronics')
    await user.type(screen.getByLabelText(/Unit cost/), '-1')
    await user.type(screen.getByLabelText(/Sale price/), '1.234')
    await user.clear(screen.getByLabelText(/Min stock/))
    await user.type(screen.getByLabelText(/Min stock/), '1.5')
    await user.click(screen.getByRole('button', { name: 'Create product' }))

    expect(await screen.findByText(/must start with a letter or digit/)).toBeInTheDocument()
    expect(screen.getByText('Cost cannot be negative')).toBeInTheDocument()
    expect(screen.getByText('Up to 10 digits and 2 decimal places')).toBeInTheDocument()
    expect(screen.getByText('Enter a whole number of 0 or more')).toBeInTheDocument()
    expect(apiMock.post).not.toHaveBeenCalled()
  })

  it('creates a product and shows a duplicate-SKU 409 on the SKU field', async () => {
    const user = userEvent.setup()
    apiMock.post.mockRejectedValueOnce(new ApiError(409, 'DUPLICATE', "SKU 'NEW-1' already exists"))
    wrap(<ProductFormDialog open onOpenChange={() => {}} />)
    await user.type(screen.getByLabelText(/^SKU/), 'new-1')
    await user.type(screen.getByLabelText(/^Name/), 'New thing')
    await user.type(screen.getByLabelText(/^Category/), 'Electronics')
    await user.type(screen.getByLabelText(/Unit cost/), '2.5')
    await user.type(screen.getByLabelText(/Sale price/), '9.99')
    await waitFor(() => expect(screen.getByRole('option', { name: 'Northwind Electronics' })).toBeInTheDocument())
    await user.selectOptions(screen.getByLabelText(/Preferred supplier/), '1')
    await user.click(screen.getByRole('button', { name: 'Create product' }))

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1))
    expect(apiMock.post).toHaveBeenCalledWith('/products', {
      sku: 'new-1',
      name: 'New thing',
      description: null,
      category: 'Electronics',
      unit: 'pcs',
      cost: '2.5',
      price: '9.99',
      min_stock: 0,
      reorder_point: 0,
      safety_stock: 0,
      lead_time_days: 7,
      supplier_id: 1,
      is_active: true,
    })
    const sku = screen.getByLabelText(/^SKU/)
    expect(await screen.findByText("SKU 'NEW-1' already exists")).toBeInTheDocument()
    expect(sku).toHaveAttribute('aria-invalid', 'true')
  })

  it('PATCHes only the changed fields when editing', async () => {
    const user = userEvent.setup()
    apiMock.patch.mockResolvedValueOnce({ ...product, price: '74.99' })
    const onOpenChange = vi.fn()
    wrap(<ProductFormDialog open onOpenChange={onOpenChange} product={product} />)
    expect(screen.getByLabelText(/^SKU/)).toBeDisabled()
    const price = screen.getByLabelText(/Sale price/)
    await user.clear(price)
    await user.type(price, '74.99')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/products/7', { price: '74.99' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})

describe('ProductsPage', () => {
  it('offers "Deactivate instead" when delete fails with PRODUCT_IN_USE', async () => {
    const user = userEvent.setup()
    apiMock.delete.mockRejectedValueOnce(
      new ApiError(409, 'PRODUCT_IN_USE', 'Product has stock, sales or purchase history and cannot be deleted; deactivate it instead'),
    )
    apiMock.patch.mockResolvedValueOnce({ ...product, is_active: false })
    wrap(<ProductsPage />)

    await user.click(await screen.findByRole('button', { name: 'Actions for ELEC-EARBUD-PRO' }))
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }))
    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: 'Delete product' }))

    await waitFor(() => expect(apiMock.delete).toHaveBeenCalledWith('/products/7'))
    const inUse = await screen.findByRole('alertdialog')
    expect(within(inUse).getByText('This product can’t be deleted')).toBeInTheDocument()
    await user.click(within(inUse).getByRole('button', { name: 'Deactivate instead' }))
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/products/7', { is_active: false }))
  })
})

describe('WarehouseFormDialog', () => {
  it('rejects invalid codes and upper-cases valid ones', async () => {
    const user = userEvent.setup()
    apiMock.post.mockResolvedValueOnce({ id: 9, code: 'WH-EAST', name: 'East', location: null, status: 'ACTIVE' })
    wrap(<WarehouseFormDialog open onOpenChange={() => {}} />)
    await user.type(screen.getByLabelText(/^Code/), 'w')
    await user.type(screen.getByLabelText(/^Name/), 'East')
    await user.click(screen.getByRole('button', { name: 'Create warehouse' }))
    expect(await screen.findByText(/2–20 characters/)).toBeInTheDocument()
    expect(apiMock.post).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText(/^Code/), 'h-east')
    await user.click(screen.getByRole('button', { name: 'Create warehouse' }))
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/warehouses', { code: 'WH-EAST', name: 'East', location: null, status: 'ACTIVE' }))
  })
})

describe('SupplierFormDialog', () => {
  it('validates lead time and maps duplicate-name 409 to the name field', async () => {
    const user = userEvent.setup()
    apiMock.post.mockRejectedValueOnce(new ApiError(409, 'DUPLICATE', 'A supplier with this name already exists'))
    wrap(<SupplierFormDialog open onOpenChange={() => {}} />)
    await user.type(screen.getByLabelText(/Company name/), 'Northwind Electronics')
    const lead = screen.getByLabelText(/Promised lead time/)
    await user.clear(lead)
    await user.type(lead, '400')
    await user.click(screen.getByRole('button', { name: 'Create supplier' }))
    expect(await screen.findByText('Must be between 0 and 365 days')).toBeInTheDocument()
    expect(apiMock.post).not.toHaveBeenCalled()

    await user.clear(lead)
    await user.type(lead, '12')
    await user.click(screen.getByRole('button', { name: 'Create supplier' }))
    expect(await screen.findByText('A supplier with this name already exists')).toBeInTheDocument()
    expect(apiMock.post).toHaveBeenCalledWith('/suppliers', expect.objectContaining({ name: 'Northwind Electronics', lead_time_days: 12, email: null }))
  })

  it('asks for confirmation before deactivating a supplier', async () => {
    const user = userEvent.setup()
    apiMock.patch.mockResolvedValueOnce({ ...supplier, status: 'INACTIVE' })
    wrap(<SupplierFormDialog open onOpenChange={() => {}} supplier={supplier} />)
    await user.selectOptions(screen.getByLabelText('Status'), 'INACTIVE')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(apiMock.patch).not.toHaveBeenCalled()
    await user.click(within(confirm).getByRole('button', { name: 'Deactivate supplier' }))
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/suppliers/1', { status: 'INACTIVE' }))
  })
})

describe('buildForecastSeries', () => {
  it('joins history and forecast at the last actual point', () => {
    const rows = buildForecastSeries({
      history: [
        { date: '2026-09-30', quantity: 4 },
        { date: '2026-10-01', quantity: 6 },
      ],
      forecast: { points: [{ date: '2026-10-02', predicted: 5, lower: -1, upper: 9 }] } as never,
    })
    expect(rows).toEqual([
      { date: '2026-09-30', actual: 4 },
      { date: '2026-10-01', actual: 6, predicted: 6, band: [6, 6] },
      { date: '2026-10-02', predicted: 5, band: [0, 9] },
    ])
  })
})
