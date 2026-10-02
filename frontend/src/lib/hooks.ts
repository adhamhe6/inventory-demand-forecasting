import { useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Filter/sort/pagination state stored in the URL query string, so views are shareable,
 * survive reloads and work with browser back/forward.
 *
 * Updates are applied to a ref holding the latest params, so several updates in the same
 * tick (e.g. two setters in one handler) compose instead of overwriting each other.
 */
export function useUrlState<T extends Record<string, string | number>>(defaults: T) {
  const [params, setParams] = useSearchParams()
  const latest = useRef(params)
  latest.current = params
  const defaultsRef = useRef(defaults)

  const state = useMemo(() => {
    const out: Record<string, string | number> = { ...defaultsRef.current }
    for (const [k, def] of Object.entries(defaultsRef.current)) {
      const raw = params.get(k)
      if (raw !== null) out[k] = typeof def === 'number' ? Number(raw) || def : raw
    }
    return out as T
  }, [params])

  const update = useCallback(
    (patch: Partial<T>, { resetPage = true }: { resetPage?: boolean } = {}) => {
      const defs = defaultsRef.current
      const next = new URLSearchParams(latest.current)
      const merged: Record<string, unknown> = { ...patch }
      if (resetPage && 'page' in defs && !('page' in patch)) merged.page = 1
      for (const [k, v] of Object.entries(merged)) {
        if (v === undefined || v === '' || v === defs[k]) next.delete(k)
        else next.set(k, String(v))
      }
      latest.current = next
      setParams(next, { replace: true })
    },
    [setParams],
  )
  return [state, update] as const
}
