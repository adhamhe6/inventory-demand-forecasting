import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StockOperationDialog } from '@/components/inventory/StockOperationDialog'
import { jsonResponse, renderWithProviders } from './test-utils'

const page = (items: unknown[]) => ({ items, total: items.length, page: 1, page_size: 200, pages: 1 })
const WAREHOUSES = page([
  { id: 1, code: 'WH-A', name: 'A', status: 'ACTIVE' },
  { id: 2, code: 'WH-B', name: 'B', status: 'ACTIVE' },
])
const PRODUCTS = page([{ id: 7, sku: 'SKU-7', name: 'Widget', unit: 'pcs' }])
const item = {
  product_id: 7, warehouse_id: 1, sku: 'SKU-7', product_name: 'Widget', warehouse_code: 'WH-A',
  available_quantity: 10, reserved_quantity: 0, quantity_on_hand: 10,
}

function mockFetch(onPost: (url: string, init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST') return onPost(url, init)
    if (url.startsWith('/api/v1/warehouses')) return jsonResponse(WAREHOUSES)
    if (url.startsWith('/api/v1/products')) return jsonResponse(PRODUCTS)
    return jsonResponse({})
  })
}

afterEach(() => vi.restoreAllMocks())

describe('StockOperationDialog', () => {
  it('validates quantity and transfer destination client-side', async () => {
    const post = vi.fn()
    mockFetch(post)
    renderWithProviders(<StockOperationDialog op="transfer" item={item} onOpenChange={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Transfer' }))
    expect(await screen.findByText('Quantity must be greater than zero')).toBeInTheDocument()
    expect(screen.getByText('Select a destination')).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
  })

  it('requires a reason and non-zero change for adjustments', async () => {
    mockFetch(vi.fn())
    renderWithProviders(<StockOperationDialog op="adjust" item={item} onOpenChange={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/Quantity change/), '0')
    fireEvent.click(screen.getByRole('button', { name: 'Adjust' }))
    expect(await screen.findByText('Change cannot be zero')).toBeInTheDocument()
    expect(screen.getByText(/Give a reason/)).toBeInTheDocument()
  })

  it('posts a transfer with an idempotency key and closes on success', async () => {
    const onOpenChange = vi.fn()
    const post = vi.fn(() => jsonResponse({ items: [], transactions: [] }))
    mockFetch(post)
    renderWithProviders(<StockOperationDialog op="transfer" item={item} onOpenChange={onOpenChange} />)
    const to = await screen.findByLabelText(/To warehouse/)
    await waitFor(() => expect(screen.getByRole('option', { name: /WH-B/ })).toBeInTheDocument())
    await userEvent.selectOptions(to, '2')
    await userEvent.type(screen.getByLabelText(/Quantity/), '4')
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/inventory/transfer')
    expect(JSON.parse(String(init.body))).toMatchObject({ product_id: 7, from_warehouse_id: 1, to_warehouse_id: 2, quantity: 4 })
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('shows a server business-rule error inline', async () => {
    mockFetch(() =>
      jsonResponse({ error: { code: 'INSUFFICIENT_STOCK', message: 'Insufficient available stock: requested 99, available 10' } }, 422),
    )
    renderWithProviders(<StockOperationDialog op="issue" item={item} onOpenChange={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/Quantity/), '99')
    fireEvent.click(screen.getByRole('button', { name: 'Issue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Insufficient available stock')
  })
})
