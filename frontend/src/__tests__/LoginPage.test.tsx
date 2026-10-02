import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import LoginPage from '@/pages/LoginPage'

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: apiMock }))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: null, login: vi.fn(), sessionMessage: null }) }))

const meta = (demo_mode: boolean) => ({
  app_name: 'x',
  version: '1.0.0',
  environment: 'development',
  demo_mode,
  max_import_file_mb: 20,
  forecast_interval_level: 0.8,
  restock_review_period_days: 14,
})

function renderLogin() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('LoginPage', () => {
  it('offers seeded demo accounts only in demo mode', async () => {
    apiMock.get.mockResolvedValue(meta(true))
    renderLogin()
    await userEvent.click(await screen.findByRole('button', { name: 'Admin' }))
    expect(screen.getByLabelText('Email')).toHaveValue('admin@demo.example')
    expect(screen.getByLabelText('Password')).toHaveValue('DemoPass123!')
  })

  it('hides demo accounts outside demo mode', async () => {
    apiMock.get.mockResolvedValue(meta(false))
    renderLogin()
    await screen.findByRole('button', { name: 'Sign in' })
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText(/Demo accounts/)).not.toBeInTheDocument()
  })

  it('links validation messages to their inputs', async () => {
    apiMock.get.mockResolvedValue(meta(false))
    renderLogin()
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Email is required')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-describedby', 'email-error')
  })
})
