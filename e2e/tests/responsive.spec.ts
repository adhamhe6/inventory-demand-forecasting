import { expect, test } from '@playwright/test'
import { login } from './helpers'

const PAGES = [
  '/', '/inventory', '/products', '/products/1', '/warehouses', '/warehouses/1', '/suppliers', '/suppliers/1',
  '/purchase-orders', '/purchase-orders/new', '/sales', '/forecasting', '/stock-risks', '/restocking',
  '/settings',
  ...['inventory', 'low-stock', 'sales', 'warehouses', 'suppliers', 'purchase-orders', 'forecasts', 'shortages'].map((t) => `/reports?tab=${t}`),
]

test('pages have no horizontal overflow on mobile and navigation works', async ({ page }) => {
  await login(page)
  for (const path of PAGES) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    // Measure against the device screen, not innerWidth: with mobile emulation the browser zooms out
    // to fit overflowing content, which widens innerWidth too and would hide the overflow.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.screen.width)
    expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(1)
  }
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('dialog', { name: 'Navigation' }).getByRole('link', { name: 'Suppliers' }).click()
  await expect(page.getByRole('heading', { name: 'Suppliers' })).toBeVisible()
})
