import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, type Query } from '@/lib/api'
import type { Job, Page, Product, Supplier, Warehouse } from '@/lib/types'

/** Query-key factory: one place to keep keys consistent for invalidation. */
export const qk = {
  dashboard: ['dashboard'] as const,
  inventory: (q?: Query) => ['inventory', q] as const,
  transactions: (q?: Query) => ['transactions', q] as const,
  products: (q?: Query) => ['products', q] as const,
  product: (id: number) => ['products', 'detail', id] as const,
  categories: ['products', 'categories'] as const,
  warehouses: (q?: Query) => ['warehouses', q] as const,
  warehouseSummary: ['warehouses', 'summary'] as const,
  suppliers: (q?: Query) => ['suppliers', q] as const,
  supplier: (id: number) => ['suppliers', 'detail', id] as const,
  purchaseOrders: (q?: Query) => ['purchase-orders', q] as const,
  purchaseOrder: (id: number) => ['purchase-orders', 'detail', id] as const,
  sales: (q?: Query) => ['sales', q] as const,
  forecasts: (q?: Query) => ['forecasts', q] as const,
  forecastItem: (p: number, w: number, h: number) => ['forecasts', 'item', p, w, h] as const,
  shortages: (q?: Query) => ['shortages', q] as const,
  restocking: (q?: Query) => ['restocking', q] as const,
  reports: (name: string, q?: Query) => ['reports', name, q] as const,
  jobs: (q?: Query) => ['jobs', q] as const,
  job: (id: string) => ['jobs', 'detail', id] as const,
  users: ['users'] as const,
}

/** Keys touched by stock-changing operations. */
export const STOCK_KEYS = [['inventory'], ['transactions'], ['dashboard'], ['shortages'], ['restocking'], ['warehouses'], ['reports'], ['products']]

export function usePaged<T>(key: readonly unknown[], path: string, query: Query, enabled = true) {
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get<Page<T>>(path, query, signal),
    placeholderData: keepPreviousData,
    enabled,
  })
}

export function useAllWarehouses() {
  return useQuery({
    queryKey: qk.warehouses({ all: 1 }),
    queryFn: () => api.get<Page<Warehouse>>('/warehouses', { page_size: 200, sort: 'code' }),
    staleTime: 5 * 60_000,
    select: (p) => p.items,
  })
}

export function useAllSuppliers() {
  return useQuery({
    queryKey: qk.suppliers({ all: 1 }),
    queryFn: () => api.get<Page<Supplier>>('/suppliers', { page_size: 200, sort: 'name' }),
    staleTime: 5 * 60_000,
    select: (p) => p.items,
  })
}

export function useAllProducts() {
  return useQuery({
    queryKey: qk.products({ all: 1 }),
    queryFn: () => api.get<Page<Product>>('/products', { page_size: 200, sort: 'sku', is_active: true }),
    staleTime: 5 * 60_000,
    select: (p) => p.items,
  })
}

export function useCategories() {
  return useQuery({ queryKey: qk.categories, queryFn: () => api.get<string[]>('/products/categories'), staleTime: 5 * 60_000 })
}

/** Polls a background job until it finishes. */
export function useJob(jobId: string | null | undefined) {
  return useQuery({
    queryKey: qk.job(jobId ?? 'none'),
    queryFn: () => api.get<Job>(`/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === 'SUCCEEDED' || s === 'FAILED' ? false : 1000
    },
  })
}
