import { Boxes, ClipboardList, LineChart, PackageX, ShieldAlert, ShoppingCart, Truck, Warehouse } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/common/PageHeader'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { InventoryReport, LowStockReport, WarehousesReport } from './reports/InventoryReports'
import { ForecastsReport, ShortagesReport } from './reports/PlanningReports'
import { PurchaseOrdersReport, SuppliersReport } from './reports/PurchasingReports'
import { SalesReport } from './reports/SalesReport'

const TABS = [
  { id: 'inventory', label: 'Inventory', icon: Boxes, el: InventoryReport },
  { id: 'low-stock', label: 'Low stock', icon: PackageX, el: LowStockReport },
  { id: 'sales', label: 'Sales', icon: ShoppingCart, el: SalesReport },
  { id: 'warehouses', label: 'Warehouses', icon: Warehouse, el: WarehousesReport },
  { id: 'suppliers', label: 'Suppliers', icon: Truck, el: SuppliersReport },
  { id: 'purchase-orders', label: 'Purchase orders', icon: ClipboardList, el: PurchaseOrdersReport },
  { id: 'forecasts', label: 'Forecasts', icon: LineChart, el: ForecastsReport },
  { id: 'shortages', label: 'Shortage risk', icon: ShieldAlert, el: ShortagesReport },
] as const

export default function ReportsPage() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab = TABS.some((t) => t.id === raw) ? raw! : 'inventory'

  return (
    <>
      <PageHeader title="Reports" description="Operational reporting across stock, sales, purchasing and planning. Every table can be exported to CSV." />
      <Tabs
        value={tab}
        onValueChange={(v) =>
          // Switching tabs drops the previous tab's filters so URLs stay clean and shareable.
          setParams(v === 'inventory' ? {} : { tab: v }, { replace: true })
        }
      >
        <TabsList aria-label="Report" className="w-full justify-start sm:w-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              <t.icon aria-hidden /> {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((t) => (
          <TabsContent key={t.id} value={t.id} className="mt-6">
            <t.el />
          </TabsContent>
        ))}
      </Tabs>
    </>
  )
}
