// Types mirroring the backend's Pydantic response schemas (app/schemas/*).

export type Role = 'ADMIN' | 'WAREHOUSE_MANAGER' | 'INVENTORY_MANAGER' | 'PURCHASING_MANAGER' | 'ANALYST'
export type EntityStatus = 'ACTIVE' | 'INACTIVE'
export type StockStatus = 'HEALTHY' | 'LOW_STOCK' | 'CRITICAL' | 'OUT_OF_STOCK'
export type RiskLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type DemandSource = 'FORECAST' | 'HISTORICAL_AVERAGE' | 'NONE'
export type POStatus = 'DRAFT' | 'SUBMITTED' | 'CONFIRMED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED'
export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
export type JobType = 'FORECAST_ITEM' | 'FORECAST_ALL' | 'IMPORT_SALES'
export type TransactionType =
  | 'PURCHASE_RECEIPT'
  | 'SALE'
  | 'ISSUE'
  | 'ADJUSTMENT'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'RETURN'
  | 'RESERVATION'
  | 'RESERVATION_RELEASE'

export interface Page<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  pages: number
}

export interface User {
  id: number
  email: string
  full_name: string
  role: Role
  is_active: boolean
  last_login_at: string | null
  created_at: string
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  user: User
}

export interface Supplier {
  id: number
  name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  address: string | null
  payment_terms: string | null
  lead_time_days: number
  status: EntityStatus
  created_at: string
  updated_at: string
}

export interface SupplierStats {
  total_purchase_orders: number
  open_purchase_orders: number
  total_spend: number
  on_time_rate: number | null
  avg_actual_lead_time_days: number | null
  product_count: number
}

export interface SupplierDetail extends Supplier {
  stats: SupplierStats
}

export interface Warehouse {
  id: number
  code: string
  name: string
  location: string | null
  status: EntityStatus
  created_at: string
  updated_at: string
}

export interface WarehouseSummary extends Warehouse {
  product_count: number
  total_units: number
  reserved_units: number
  inventory_value: number
  low_stock_items: number
}

export interface Product {
  id: number
  sku: string
  name: string
  description: string | null
  category: string
  unit: string
  cost: string
  price: string
  min_stock: number
  reorder_point: number
  safety_stock: number
  lead_time_days: number
  is_active: boolean
  supplier_id: number | null
  supplier: { id: number; name: string; lead_time_days: number } | null
  created_at: string
  updated_at: string
}

export interface ProductDetail extends Product {
  stock: Array<{
    warehouse_id: number
    warehouse_code: string
    warehouse_name: string
    quantity_on_hand: number
    reserved_quantity: number
    available_quantity: number
  }>
  total_on_hand: number
  total_available: number
}

export interface InventoryItem {
  id: number
  product_id: number
  sku: string
  product_name: string
  category: string
  unit: string
  warehouse_id: number
  warehouse_code: string
  warehouse_name: string
  quantity_on_hand: number
  reserved_quantity: number
  available_quantity: number
  safety_stock: number
  reorder_point: number
  unit_cost: number
  stock_value: number
  status: StockStatus
  updated_at: string
}

export interface Transaction {
  id: number
  product_id: number
  warehouse_id: number
  sku: string | null
  product_name: string | null
  warehouse_code: string | null
  type: TransactionType
  quantity: number
  on_hand_delta: number
  reserved_delta: number
  on_hand_after: number
  reserved_after: number
  reference: string | null
  note: string | null
  transfer_group: string | null
  actor_id: number | null
  actor_name: string | null
  created_at: string
}

export interface StockOperationResult {
  items: InventoryItem[]
  transactions: Transaction[]
}

export interface POLine {
  id: number
  product_id: number
  sku: string
  product_name: string
  quantity_ordered: number
  quantity_received: number
  quantity_outstanding: number
  unit_cost: string
  line_total: string
}

export interface Receipt {
  id: number
  receipt_key: string
  received_at: string
  received_by_id: number | null
  notes: string | null
  lines: Array<{ purchase_order_line_id: number; product_id: number; sku: string; quantity: number }>
}

export interface PurchaseOrderSummary {
  id: number
  po_number: string
  supplier_id: number
  supplier_name: string
  warehouse_id: number
  warehouse_code: string
  status: POStatus
  order_date: string
  expected_delivery_date: string | null
  received_date: string | null
  total_amount: string
  total_units: number
  received_units: number
  line_count: number
  created_at: string
}

export interface PurchaseOrder extends PurchaseOrderSummary {
  notes: string | null
  submitted_at: string | null
  lines: POLine[]
  receipts: Receipt[]
  allowed_transitions: POStatus[]
}

export interface ReceiveResult {
  purchase_order: PurchaseOrder
  receipt: Receipt
  replayed: boolean
}

export interface Sale {
  id: number
  product_id: number
  sku: string
  product_name: string
  warehouse_id: number
  warehouse_code: string
  sold_at: string
  quantity: number
  unit_price: string
  revenue: string
  order_reference: string
  created_at: string
}

export interface Job {
  id: string
  type: JobType
  status: JobStatus
  params: Record<string, unknown>
  result: Record<string, unknown> | null
  error: string | null
  progress: number
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface ImportResult {
  total_rows: number
  inserted: number
  duplicates: number
  invalid: number
  errors: Array<{ line: number; error: string; raw?: Record<string, string> | null }>
  errors_truncated: boolean
}

export interface ForecastMetrics {
  mae?: number | null
  rmse?: number | null
  wape?: number | null
  mape?: number | null
  bias?: number | null
  holdout_days?: number | null
}

export interface ForecastRunSummary {
  id: number
  product_id: number
  sku: string
  product_name: string
  warehouse_id: number
  warehouse_code: string
  horizon_days: number
  model_name: string
  model_version: string
  generated_at: string
  total_predicted: number
  avg_daily_demand: number
  history_days: number
  metrics: ForecastMetrics
}

export interface ForecastPoint {
  date: string
  predicted: number
  lower: number
  upper: number
}

export interface ForecastRun extends ForecastRunSummary {
  history_start: string | null
  history_end: string | null
  details: {
    profile?: { pattern: string; zero_ratio: number; mean: number; n_days: number; adi: number | null; cv2: number | null }
    candidates?: Record<string, ForecastMetrics & { error?: string }>
    selection?: string
    selection_metric?: string
    backtest?: { folds: number; fold_days: number; evaluated_days: number }
    interval?: { level: number; method: string; sigma: number }
    [k: string]: unknown
  }
  points: ForecastPoint[]
}

export interface ForecastWithHistory {
  forecast: ForecastRun | null
  history: Array<{ date: string; quantity: number }>
}

export interface StockRisk {
  inventory_item_id: number
  product_id: number
  sku: string
  product_name: string
  category: string
  warehouse_id: number
  warehouse_code: string
  warehouse_name: string
  quantity_on_hand: number
  available_quantity: number
  inbound_quantity: number
  /** Submitted/confirmed PO units expected within the lead time (what risk counts on). */
  inbound_within_lead_time: number
  next_inbound_date: string | null
  /** Stock is expected to run out before the next scheduled delivery. */
  stockout_before_inbound: boolean
  safety_stock: number
  reorder_point: number
  lead_time_days: number
  avg_daily_demand: number
  demand_during_lead_time: number
  projected_stock_at_lead_time: number
  days_of_cover: number | null
  stockout_date: string | null
  demand_source: DemandSource
  forecast_run_id: number | null
  risk_level: RiskLevel
  reason: string
  recommended_action: string
}

export interface RestockRecommendation {
  inventory_item_id: number
  product_id: number
  sku: string
  product_name: string
  category: string
  warehouse_id: number
  warehouse_code: string
  warehouse_name: string
  supplier_id: number | null
  supplier_name: string | null
  available_quantity: number
  inbound_quantity: number
  inventory_position: number
  avg_daily_demand: number
  lead_time_days: number
  review_period_days: number
  demand_during_lead_time: number
  safety_stock: number
  reorder_point: number
  order_up_to_level: number
  recommended_quantity: number
  unit_cost: number
  estimated_cost: number
  risk_level: RiskLevel
  demand_source: DemandSource
  rationale: string
}

export interface Dashboard {
  generated_at: string
  kpis: {
    active_products: number
    stocked_products: number
    total_units: number
    inventory_value: number
    low_stock_items: number
    out_of_stock_items: number
    shortage_risk_items: number
    open_purchase_orders: number
    open_purchase_order_value: number
    sales_units_30d: number
    revenue_30d: number
    sales_units_change_pct: number | null
    forecast_units_30d: number
    restock_recommendations: number
  }
  sales_trend: Array<{ period: string; units: number; revenue: number; orders: number }>
  inventory_trend: Array<{ date: string; units: number; value: number }>
  forecast_trend: ForecastPoint[]
  risk_distribution: Array<{ risk_level: RiskLevel; count: number }>
  warehouse_distribution: Array<{ warehouse_id: number; code: string; name: string; units: number; value: number; low_stock_items: number }>
  category_value: Array<{ group: string; products: number; units: number; cost_value: number; retail_value: number }>
}

export interface StockRiskPage extends Page<StockRisk> {
  summary: { total_items: number; by_risk_level: Record<RiskLevel, number> }
}

export interface RestockPage extends Page<RestockRecommendation> {
  summary: { items: number; total_units: number; total_estimated_cost: number; critical: number; without_supplier: number }
}
