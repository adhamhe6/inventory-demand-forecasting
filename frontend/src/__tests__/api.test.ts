import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, buildQuery, onUnauthorized, tokenStore } from '@/lib/api'
import { roleCan } from '@/lib/permissions'
import { jsonResponse } from './test-utils'

afterEach(() => {
  vi.restoreAllMocks()
  tokenStore.set(null)
})

describe('buildQuery', () => {
  it('skips empty values and repeats arrays', () => {
    expect(buildQuery({ a: 1, b: '', c: null, d: undefined, s: ['X', 'Y'], f: false })).toBe('?a=1&s=X&s=Y&f=false')
    expect(buildQuery({})).toBe('')
  })
})

describe('request', () => {
  it('sends the bearer token and parses JSON', async () => {
    tokenStore.set('tok')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: 1 }))
    await expect(api.get('/x', { page: 2 })).resolves.toEqual({ ok: 1 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/x?page=2')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('normalises backend errors and exposes field errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: [{ field: 'sku', message: 'Value error, SKU may contain letters', type: 'value_error' }],
          },
          request_id: 'abc',
        },
        422,
      ),
    )
    const err = (await api.post('/products', {}).catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(422)
    expect(err.requestId).toBe('abc')
    expect(err.fieldErrors).toEqual({ sku: 'SKU may contain letters' })
  })

  it('maps network failures and non-JSON 5xx to friendly messages', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(api.get('/x')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
    await expect(api.get('/x')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('temporarily unavailable') })
  })

  it('notifies listeners on 401 when a token was sent', async () => {
    tokenStore.set('expired')
    const listener = vi.fn()
    const off = onUnauthorized(listener)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: { code: 'TOKEN_EXPIRED', message: 'expired' } }, 401))
    await api.get('/x').catch(() => undefined)
    expect(listener).toHaveBeenCalledOnce()
    off()
  })
})

describe('roleCan mirrors the backend permission matrix', () => {
  it.each([
    ['ADMIN', 'manage_users', true],
    ['ANALYST', 'stock_operations', false],
    ['ANALYST', 'run_forecasts', true],
    ['WAREHOUSE_MANAGER', 'receive_purchase_orders', true],
    ['WAREHOUSE_MANAGER', 'manage_purchase_orders', false],
    ['PURCHASING_MANAGER', 'stock_adjust', false],
  ] as const)('%s %s → %s', (role, perm, expected) => {
    expect(roleCan(role, perm)).toBe(expected)
  })
})

describe('downloadCsv', () => {
  it('notifies the auth layer when the token was rejected', async () => {
    tokenStore.set('expired')
    const listener = vi.fn()
    const off = onUnauthorized(listener)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Token expired' } }, 401),
    )
    const { downloadCsv } = await import('@/lib/api')
    await expect(downloadCsv('/reports/low-stock')).rejects.toMatchObject({ status: 401 })
    expect(listener).toHaveBeenCalledOnce()
    off()
  })
})
