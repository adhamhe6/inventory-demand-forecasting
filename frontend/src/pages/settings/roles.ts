import type { Role } from '@/lib/types'

export const ROLE_META: Record<Role, { label: string; description: string }> = {
  ADMIN: { label: 'Administrator', description: 'Full access, including user management.' },
  WAREHOUSE_MANAGER: { label: 'Warehouse manager', description: 'Runs warehouses: stock operations, adjustments, receiving and sales.' },
  INVENTORY_MANAGER: { label: 'Inventory manager', description: 'Manages the catalog and stock, imports sales and runs forecasts.' },
  PURCHASING_MANAGER: { label: 'Purchasing manager', description: 'Manages suppliers and purchase orders, receives goods and runs forecasts.' },
  ANALYST: { label: 'Analyst', description: 'Read access to everything, plus sales imports and forecasting.' },
}

export const ROLES = Object.keys(ROLE_META) as Role[]
