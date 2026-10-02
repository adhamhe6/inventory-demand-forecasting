import { expect, test } from '@playwright/test'
import { apiAs, login, unique } from './helpers'

/**
 * UI → create PO → FastAPI → PostgreSQL → submit/confirm → receive → inventory updated → UI shows it.
 */
test('purchase order lifecycle updates inventory', async ({ page, request }) => {
  const api = await apiAs(request)
  const product = (await api.get('/products?search=TOOL-TAPE-5M')).items[0]
  const warehouses = (await api.get('/warehouses?search=WH-NORTH')).items
  const wh = warehouses.find((w: { code: string }) => w.code === 'WH-NORTH')
  const before = (await api.get(`/inventory?product_id=${product.id}&warehouse_id=${wh.id}`)).items[0]
  const qty = 37

  await login(page)
  await page.goto(`/purchase-orders/new?supplier_id=${product.supplier_id}`)
  await page.getByLabel('Deliver to warehouse').selectOption({ value: String(wh.id) })
  await page.getByLabel('Product for line 1').selectOption({ value: String(product.id) })
  await page.getByLabel('Quantity for line 1').fill(String(qty))
  await page.getByLabel('Notes').fill(`E2E ${unique()}`)
  await page.getByRole('button', { name: 'Review & create' }).click()
  await page.getByRole('button', { name: 'Create draft' }).click()
  await expect(page).toHaveURL(/\/purchase-orders\/\d+$/)
  await expect(page.getByText('Draft').first()).toBeVisible()

  await page.getByRole('button', { name: 'Submit to supplier' }).click()
  await page.getByRole('button', { name: 'Submit order' }).click()
  await expect(page.getByRole('button', { name: 'Mark confirmed' })).toBeVisible()
  await page.getByRole('button', { name: 'Mark confirmed' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Mark confirmed' }).click()

  await page.getByRole('button', { name: 'Receive goods' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel(`Receive quantity for ${product.sku}`)).toHaveValue(String(qty))
  await dialog.getByLabel('Delivery note / GRN').fill(`GRN-E2E-${unique()}`)
  await dialog.getByRole('button', { name: `Receive ${qty} units` }).click()
  await page.getByRole('button', { name: 'Receive into stock' }).click()
  await expect(page.getByText(`Received ${qty} units into WH-NORTH`)).toBeVisible()
  await expect(page.getByText('Received', { exact: true }).first()).toBeVisible()

  // Database state via the API
  const after = (await api.get(`/inventory?product_id=${product.id}&warehouse_id=${wh.id}`)).items[0]
  expect(after.quantity_on_hand).toBe(before.quantity_on_hand + qty)

  // ...and the inventory UI shows the new on-hand figure.
  await page.goto(`/inventory?search=${product.sku}&warehouse_id=${wh.id}`)
  await expect(page.getByRole('row').filter({ hasText: 'WH-NORTH' }).first()).toContainText(String(after.quantity_on_hand))
})
