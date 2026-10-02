import { expect, test } from '@playwright/test'
import { apiAs, login, unique } from './helpers'

test('transfer stock between warehouses updates both sides (UI → API → DB → UI)', async ({ page, request }) => {
  const api = await apiAs(request)
  const inv = await api.get('/inventory?search=PKG-TAPE-48&warehouse_id=1')
  const source = inv.items[0]
  const destBefore = (await api.get(`/inventory?product_id=${source.product_id}&warehouse_id=2`)).items[0]

  await login(page)
  await page.goto('/inventory?search=PKG-TAPE-48')
  await page.getByRole('button', { name: /^Transfer$/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Product').selectOption({ label: `${source.sku} — ${source.product_name}` })
  await dialog.getByLabel('From warehouse').selectOption({ value: String(source.warehouse_id) })
  await dialog.getByLabel('To warehouse').selectOption({ value: '2' })
  await dialog.getByLabel(/Quantity/).fill('3')
  await dialog.getByLabel('Reference').fill(`E2E-TRF-${unique()}`)
  await dialog.getByRole('button', { name: 'Transfer' }).click()
  await expect(page.getByText('Transfer stock completed')).toBeVisible()

  const srcAfter = (await api.get(`/inventory?product_id=${source.product_id}&warehouse_id=1`)).items[0]
  const destAfter = (await api.get(`/inventory?product_id=${source.product_id}&warehouse_id=2`)).items[0]
  expect(srcAfter.quantity_on_hand).toBe(source.quantity_on_hand - 3)
  expect(destAfter.quantity_on_hand).toBe(destBefore.quantity_on_hand + 3)
  // UI reflects the new numbers
  const row = page.getByRole('row').filter({ hasText: 'WH-NORTH' }).first()
  await expect(row).toContainText(String(srcAfter.available_quantity))
})

test('reserve then release changes available stock', async ({ page, request }) => {
  const api = await apiAs(request)
  const item = (await api.get('/inventory?search=PKG-BOX-M&warehouse_id=2')).items[0]
  await login(page)
  await page.goto('/inventory?search=PKG-BOX-M&warehouse_id=2')
  const row = page.getByRole('row').filter({ hasText: 'WH-SOUTH' }).first()
  await row.getByRole('button', { name: /Actions for/ }).click()
  await page.getByRole('menuitem', { name: 'Reserve' }).click()
  await page.getByRole('dialog').getByLabel(/Quantity/).fill('5')
  await page.getByRole('dialog').getByRole('button', { name: 'Reserve' }).click()
  await expect(page.getByText('Reserve stock completed')).toBeVisible()
  let now = (await api.get(`/inventory/${item.id}`))
  expect(now.available_quantity).toBe(item.available_quantity - 5)
  expect(now.reserved_quantity).toBe(item.reserved_quantity + 5)

  await row.getByRole('button', { name: /Actions for/ }).click()
  await page.getByRole('menuitem', { name: 'Release reservation' }).click()
  await page.getByRole('dialog').getByLabel(/Quantity/).fill('5')
  await page.getByRole('dialog').getByRole('button', { name: 'Release' }).click()
  await expect(page.getByText('Release reservation completed')).toBeVisible()
  now = await api.get(`/inventory/${item.id}`)
  expect(now.available_quantity).toBe(item.available_quantity)
})

test('issuing more than available shows an understandable error', async ({ page, request }) => {
  const api = await apiAs(request)
  const item = (await api.get('/inventory?search=HOME-KNIFE-CH&warehouse_id=2')).items[0]
  await login(page)
  await page.goto('/inventory?search=HOME-KNIFE-CH')
  const row = page.getByRole('row').filter({ hasText: 'WH-SOUTH' }).first()
  await row.getByRole('button', { name: /Actions for/ }).click()
  await page.getByRole('menuitem', { name: 'Issue' }).click()
  await page.getByRole('dialog').getByLabel(/Quantity/).fill(String(item.available_quantity + 1))
  await page.getByRole('dialog').getByRole('button', { name: 'Issue' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Insufficient available stock')
})
