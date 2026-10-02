import { expect, test } from '@playwright/test'
import { apiAs, login } from './helpers'

/**
 * UI → run forecast → background worker → stored in PostgreSQL → UI fetches it → chart renders.
 */
test('forecast job runs in the background worker and the chart shows the result', async ({ page, request }) => {
  test.setTimeout(120_000)
  const api = await apiAs(request)
  const product = (await api.get('/products?search=OFF-PEN-BLK')).items[0]
  const before = await api.get(`/forecasts/item?product_id=${product.id}&warehouse_id=1`)

  await login(page)
  await page.goto(`/forecasting?product_id=${product.id}&warehouse_id=1&horizon=14`)
  await page.getByRole('button', { name: 'Run forecast' }).click()
  await expect(page.getByText('Forecast ready')).toBeVisible({ timeout: 90_000 })

  const after = await api.get(`/forecasts/item?product_id=${product.id}&warehouse_id=1`)
  expect(after.forecast.id).not.toBe(before.forecast?.id)
  expect(after.forecast.horizon_days).toBe(14)
  expect(after.forecast.points).toHaveLength(14)
  const jobs = await api.get('/jobs?type=FORECAST_ITEM')
  expect(jobs.items[0].status).toBe('SUCCEEDED')

  // Chart and model panel render the stored run
  await expect(page.locator('.recharts-surface').first()).toBeVisible()
  await expect(page.getByText('Model & accuracy')).toBeVisible()
  // The stored backtest MAE is what the page reports (anchored on the label, so other "3.0"-like text can't match).
  const mae = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(after.forecast.metrics.mae) // = fmt.num
  await expect(page.getByText(`MAE ${mae} units/day`)).toBeVisible()
})

/**
 * Sales history → forecast → shortage analysis → recommendation in UI → user creates PO →
 * PO appears in UI and the recommendation disappears (no duplicates).
 */
test('restocking recommendation becomes a purchase order', async ({ page, request }) => {
  const api = await apiAs(request)
  const recs = await api.get('/restocking?page_size=200')
  const rec = recs.items.find((r: { supplier_id: number | null; demand_source: string }) => r.supplier_id && r.demand_source === 'FORECAST')
  test.skip(!rec, 'no recommendation available in this dataset')

  await login(page)
  await page.goto(`/restocking?search=${rec.sku}`)
  await page.getByLabel(`Select ${rec.sku} for ${rec.warehouse_code}`).check()
  await page.getByRole('button', { name: 'Create purchase orders' }).click()
  await page.getByRole('button', { name: 'Create drafts' }).click()
  await expect(page.getByText('Created 1 draft purchase order', { exact: true })).toBeVisible()

  const pos = await api.get(`/purchase-orders?product_id=${rec.product_id}&status=DRAFT&sort=-created_at`)
  const po = pos.items[0]
  expect(po.total_units).toBe(rec.recommended_quantity)
  const remaining = await api.get(`/restocking?search=${rec.sku}&page_size=200`)
  expect(remaining.items.find((r: { inventory_item_id: number }) => r.inventory_item_id === rec.inventory_item_id)).toBeUndefined()

  await page.goto('/purchase-orders?status=DRAFT')
  await expect(page.getByText(po.po_number)).toBeVisible()
})
