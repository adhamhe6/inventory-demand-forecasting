import { expect, test } from '@playwright/test'
import { login } from './helpers'

const PAGES = ['/', '/inventory', '/products', '/purchase-orders', '/forecasting', '/stock-risks', '/restocking', '/reports', '/settings']

test('pages have no horizontal overflow on mobile and navigation works', async ({ page }) => {
  await login(page)
  for (const path of PAGES) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(1)
  }
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('dialog', { name: 'Navigation' }).getByRole('link', { name: 'Suppliers' }).click()
  await expect(page.getByRole('heading', { name: 'Suppliers' })).toBeVisible()
})
