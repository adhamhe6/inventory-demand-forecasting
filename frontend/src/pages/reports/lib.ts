import { useQuery } from '@tanstack/react-query'
import { qk } from '@/api/queries'
import { api, type Query } from '@/lib/api'

/** GET a report endpoint, keyed under qk.reports so mutations invalidate it. */
export function useReport<T>(name: string, path: string, query: Query = {}, enabled = true) {
  return useQuery({
    queryKey: qk.reports(name, query),
    queryFn: ({ signal }) => api.get<T>(path, query, signal),
    enabled,
    placeholderData: (prev) => prev,
  })
}

export const hideCls = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' }
