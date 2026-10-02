import {
  BarChart3,
  Boxes,
  Building2,
  ClipboardList,
  LayoutDashboard,
  type LucideIcon,
  Package,
  Receipt,
  Settings,
  ShieldAlert,
  ShoppingCart,
  TrendingUp,
  Truck,
} from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

export const NAV_SECTIONS: Array<{ title: string; items: NavItem[] }> = [
  { title: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    title: 'Operations',
    items: [
      { to: '/inventory', label: 'Inventory', icon: Boxes },
      { to: '/products', label: 'Products', icon: Package },
      { to: '/warehouses', label: 'Warehouses', icon: Building2 },
      { to: '/suppliers', label: 'Suppliers', icon: Truck },
      { to: '/purchase-orders', label: 'Purchase Orders', icon: ClipboardList },
      { to: '/sales', label: 'Sales', icon: Receipt },
    ],
  },
  {
    title: 'Planning',
    items: [
      { to: '/forecasting', label: 'Demand Forecasting', icon: TrendingUp },
      { to: '/stock-risks', label: 'Stock Risks', icon: ShieldAlert },
      { to: '/restocking', label: 'Restocking', icon: ShoppingCart },
      { to: '/reports', label: 'Reports', icon: BarChart3 },
    ],
  },
  { title: 'System', items: [{ to: '/settings', label: 'Settings', icon: Settings }] },
]

export const ALL_NAV = NAV_SECTIONS.flatMap((s) => s.items)
