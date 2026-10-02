/**
 * Minimal typed fetch client for the FastAPI backend.
 *
 * - attaches the bearer token
 * - normalises backend errors ({error:{code,message,details}}) into ApiError
 * - on 401 notifies the auth layer (token expired / revoked) so the app can log out
 */

const TOKEN_KEY = 'stocksense.token'
export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1'

export class ApiError extends Error {
  status: number
  code: string
  details: unknown
  requestId?: string | null

  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string | null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.requestId = requestId
  }

  /** Field-level messages from a 422 VALIDATION_ERROR, keyed by field path. */
  get fieldErrors(): Record<string, string> {
    if (this.code !== 'VALIDATION_ERROR' || !Array.isArray(this.details)) return {}
    const out: Record<string, string> = {}
    for (const d of this.details as Array<{ field?: string; message?: string }>) {
      if (d.field && d.message) out[d.field] = d.message.replace(/^Value error, /, '')
    }
    return out
  }
}

type Listener = () => void
const unauthorizedListeners = new Set<Listener>()
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn)
  return () => unauthorizedListeners.delete(fn)
}

export const tokenStore = {
  get: (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  },
  set: (token: string | null) => {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token)
      else localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* storage unavailable (private mode) – token lives for this page only */
    }
  },
}

export type Query = Record<string, string | number | boolean | null | undefined | Array<string | number>>

export function buildQuery(params?: Query): string {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) v.forEach((item) => sp.append(k, String(item)))
    else sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

interface RequestOptions {
  method?: string
  body?: unknown
  query?: Query
  headers?: Record<string, string>
  signal?: AbortSignal
}

async function parseError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; details?: unknown }; request_id?: string } | null = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON error (proxy / gateway) */
  }
  const fallback =
    res.status >= 500
      ? 'The server is temporarily unavailable. Please try again.'
      : res.status === 404
        ? 'The requested resource was not found.'
        : `Request failed (${res.status})`
  return new ApiError(
    res.status,
    body?.error?.code ?? `HTTP_${res.status}`,
    body?.error?.message ?? fallback,
    body?.error?.details,
    body?.request_id,
  )
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers }
  const token = tokenStore.get()
  if (token) headers.Authorization = `Bearer ${token}`
  let body: BodyInit | undefined
  if (opts.body instanceof FormData) body = opts.body
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}${buildQuery(opts.query)}`, {
      method: opts.method ?? 'GET',
      headers,
      body,
      signal: opts.signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.')
  }
  if (res.status === 401 && token) unauthorizedListeners.forEach((fn) => fn())
  if (!res.ok) throw await parseError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body, headers }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T = void>(path: string) => request<T>(path, { method: 'DELETE' }),
}

/** Download a CSV export (authenticated) and trigger a browser save. */
export async function downloadCsv(path: string, query: Query = {}, fallbackName = 'export.csv'): Promise<void> {
  const token = tokenStore.get()
  const res = await fetch(`${API_BASE}${path}${buildQuery({ ...query, format: 'csv' })}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw await parseError(res)
  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const name = /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? fallbackName
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return 'Something went wrong'
}
