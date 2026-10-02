import { type APIRequestContext, expect, type Page } from '@playwright/test'

export const ADMIN = { email: 'admin@example.com', password: 'ChangeMe123!' }
export const DEMO_PASSWORD = 'DemoPass123!'

export async function login(page: Page, email = ADMIN.email, password = ADMIN.password) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

/** Authenticated API client for arranging/asserting state alongside the UI. */
export async function apiAs(request: APIRequestContext, email = ADMIN.email, password = ADMIN.password) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok()).toBeTruthy()
  const { access_token } = await res.json()
  const headers = { Authorization: `Bearer ${access_token}` }
  return {
    get: async (path: string) => {
      const r = await request.get(`/api/v1${path}`, { headers })
      expect(r.ok(), `${path} → ${r.status()}`).toBeTruthy()
      return r.json()
    },
    post: async (path: string, data: unknown) => {
      const r = await request.post(`/api/v1${path}`, { headers, data })
      expect(r.ok(), `${path} → ${r.status()} ${await r.text()}`).toBeTruthy()
      return r.json()
    },
  }
}

export const unique = () => Date.now().toString(36).toUpperCase()
