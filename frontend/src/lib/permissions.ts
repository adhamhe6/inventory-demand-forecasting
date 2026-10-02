import type { Role } from './types'

/** Mirrors backend ROLE_PERMISSIONS (app/core/security.py). The UI only uses it to hide
 *  actions; the API enforces authorization on every request. */
export type Permission =
  | 'manage_users'
  | 'manage_products'
  | 'delete_products'
  | 'manage_warehouses'
  | 'manage_suppliers'
  | 'stock_operations'
  | 'stock_adjust'
  | 'manage_purchase_orders'
  | 'receive_purchase_orders'
  | 'record_sales'
  | 'import_sales'
  | 'run_forecasts'

const ROLE_PERMISSIONS: Record<Role, Permission[] | 'all'> = {
  ADMIN: 'all',
  WAREHOUSE_MANAGER: ['manage_warehouses', 'stock_operations', 'stock_adjust', 'receive_purchase_orders', 'record_sales'],
  INVENTORY_MANAGER: ['manage_products', 'stock_operations', 'stock_adjust', 'record_sales', 'import_sales', 'run_forecasts'],
  PURCHASING_MANAGER: ['manage_suppliers', 'manage_purchase_orders', 'receive_purchase_orders', 'run_forecasts'],
  ANALYST: ['import_sales', 'run_forecasts'],
}

export function roleCan(role: Role | undefined, permission: Permission): boolean {
  if (!role) return false
  const perms = ROLE_PERMISSIONS[role]
  return perms === 'all' || perms.includes(permission)
}
