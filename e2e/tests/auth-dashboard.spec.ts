import { expect, test } from '@playwright/test'
import { apiAs, DEMO_PASSWORD, login } from './helpers'

test('rejects bad credentials with a friendly message', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@example.com')
  await page.getByLabel('Password').fill('wrong-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('Incorrect email or password')
})

test('redirects unauthenticated users to login and back after sign-in', async ({ page }) => {
  await page.goto('/inventory')
  await expect(page).toHaveURL(/\/login/)
  await page.getByLabel('Email').fill('admin@example.com')
  await page.getByLabel('Password').fill('ChangeMe123!')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/inventory/)
})

test('dashboard shows KPIs computed by the API', async ({ page, request }) => {
  const api = await apiAs(request)
  const dash = await api.get('/reports/dashboard')
  await login(page)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  const kpis = page.getByRole('region', { name: 'Key metrics' })
  await expect(kpis.getByText('Active products')).toBeVisible()
  await expect(kpis.getByText(String(dash.kpis.active_products), { exact: true })).toBeVisible()
  await expect(page.getByText('Units sold per day')).toBeVisible()
  await expect(page.getByText('Items needing attention')).toBeVisible()
})

test('stock operation actions are shown to warehouse staff but not to analysts', async ({ page }) => {
  // Positive control first, so a renamed button can't make the negative check pass vacuously.
  await login(page, 'warehouse@demo.example', DEMO_PASSWORD)
  await page.goto('/inventory')
  await expect(page.getByRole('button', { name: 'Receive stock' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Transfer' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Actions for / }).first()).toBeVisible()

  await page.context().clearCookies()
  await page.evaluate(() => localStorage.clear())
  await login(page, 'analyst@demo.example', DEMO_PASSWORD)
  await page.goto('/inventory')
  await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible()
  await expect(page.getByRole('row').nth(1)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Receive stock' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Transfer' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Actions for / })).toHaveCount(0)
})
