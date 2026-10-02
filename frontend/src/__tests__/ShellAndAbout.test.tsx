import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '@/components/layout/AppShell'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AboutTab } from '@/pages/settings/AboutTab'

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
const auth = vi.hoisted(() => ({ role: 'ADMIN' }))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: apiMock }))
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { full_name: 'Test User', email: 't@example.com', role: auth.role }, can: () => true, logout: vi.fn() }),
}))

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  apiMock.get.mockImplementation(async (path: string) =>
    path === '/meta' ? { version: '1.0.0', environment: 'development', forecast_interval_level: 0.8 } : { items: [], total: 0, page: 1, page_size: 8, pages: 0 },
  )
  localStorage.clear()
})

describe('Settings › About', () => {
  it('shows the API section to admins', async () => {
    auth.role = 'ADMIN'
    wrap(<AboutTab />)
    expect(await screen.findByText('Interactive API docs')).toBeInTheDocument()
    expect(screen.getByText('Bearer token (JWT)')).toBeInTheDocument()
  })

  it.each(['WAREHOUSE_MANAGER', 'INVENTORY_MANAGER', 'PURCHASING_MANAGER', 'ANALYST'])(
    'does not render the API section (or leave a gap) for %s',
    async (role) => {
      auth.role = role
      const { container } = wrap(<AboutTab />)
      expect(await screen.findByText('StockSense')).toBeInTheDocument()
      expect(screen.queryByText('Interactive API docs')).not.toBeInTheDocument()
      expect(screen.queryByText('Base URL')).not.toBeInTheDocument()
      // Only the StockSense card remains, without the three-column grid reserving space.
      expect(container.firstElementChild?.children).toHaveLength(1)
      expect(container.firstElementChild?.className).not.toContain('xl:grid-cols-3')
    },
  )
})

describe('AppShell sidebar', () => {
  it('collapses to an icon rail, remembers the choice and expands again', async () => {
    auth.role = 'ADMIN'
    const { unmount } = wrap(<AppShell>content</AppShell>)
    const sidebar = document.getElementById('app-sidebar')!
    expect(sidebar).toHaveClass('w-64')
    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(sidebar).toHaveClass('w-[4.5rem]')
    // Labels stay available to assistive tech while visually hidden.
    expect(screen.getAllByText('Inventory')[0]).toHaveClass('sr-only')
    expect(localStorage.getItem('stocksense.sidebar-collapsed')).toBe('1')
    unmount()

    wrap(<AppShell>content</AppShell>)
    const expand = screen.getByRole('button', { name: 'Expand sidebar' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(expand)
    expect(document.getElementById('app-sidebar')).toHaveClass('w-64')
    expect(localStorage.getItem('stocksense.sidebar-collapsed')).toBe('0')
  })
})
