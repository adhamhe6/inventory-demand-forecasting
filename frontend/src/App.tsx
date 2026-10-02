import { Loader2 } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppShell } from './components/layout/AppShell'
import { useAuth } from './lib/auth'
import LoginPage from './pages/LoginPage'

const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const InventoryPage = lazy(() => import('./pages/InventoryPage'))
const ProductsPage = lazy(() => import('./pages/products/ProductsPage'))
const ProductDetailPage = lazy(() => import('./pages/products/ProductDetailPage'))
const WarehousesPage = lazy(() => import('./pages/warehouses/WarehousesPage'))
const WarehouseDetailPage = lazy(() => import('./pages/warehouses/WarehouseDetailPage'))
const SuppliersPage = lazy(() => import('./pages/suppliers/SuppliersPage'))
const SupplierDetailPage = lazy(() => import('./pages/suppliers/SupplierDetailPage'))
const PurchaseOrdersPage = lazy(() => import('./pages/purchasing/PurchaseOrdersPage'))
const PurchaseOrderCreatePage = lazy(() => import('./pages/purchasing/PurchaseOrderCreatePage'))
const PurchaseOrderDetailPage = lazy(() => import('./pages/purchasing/PurchaseOrderDetailPage'))
const SalesPage = lazy(() => import('./pages/SalesPage'))
const ForecastingPage = lazy(() => import('./pages/ForecastingPage'))
const StockRisksPage = lazy(() => import('./pages/StockRisksPage'))
const RestockingPage = lazy(() => import('./pages/RestockingPage'))
const ReportsPage = lazy(() => import('./pages/ReportsPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'))

function FullPageSpinner() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center" role="status" aria-label="Loading">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  )
}

function RequireAuth() {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <FullPageSpinner />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  return (
    <AppShell>
      <Suspense fallback={<FullPageSpinner />}>
        <Routes>
          <Route index element={<DashboardPage />} />
          <Route path="inventory" element={<InventoryPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="products/:id" element={<ProductDetailPage />} />
          <Route path="warehouses" element={<WarehousesPage />} />
          <Route path="warehouses/:id" element={<WarehouseDetailPage />} />
          <Route path="suppliers" element={<SuppliersPage />} />
          <Route path="suppliers/:id" element={<SupplierDetailPage />} />
          <Route path="purchase-orders" element={<PurchaseOrdersPage />} />
          <Route path="purchase-orders/new" element={<PurchaseOrderCreatePage />} />
          <Route path="purchase-orders/:id" element={<PurchaseOrderDetailPage />} />
          <Route path="sales" element={<SalesPage />} />
          <Route path="forecasting" element={<ForecastingPage />} />
          <Route path="stock-risks" element={<StockRisksPage />} />
          <Route path="restocking" element={<RestockingPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </AppShell>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/*" element={<RequireAuth />} />
    </Routes>
  )
}
