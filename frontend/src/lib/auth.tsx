import { useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, onUnauthorized, tokenStore } from './api'
import { type Permission, roleCan } from './permissions'
import type { TokenResponse, User } from './types'

export type { Permission }

interface AuthContextValue {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<User>
  logout: (reason?: string) => void
  can: (permission: Permission) => boolean
  sessionMessage: string | null
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState<boolean>(() => !!tokenStore.get())
  const [sessionMessage, setSessionMessage] = useState<string | null>(null)

  const logout = useCallback(
    (reason?: string) => {
      tokenStore.set(null)
      setUser(null)
      setSessionMessage(reason ?? null)
      queryClient.clear()
    },
    [queryClient],
  )

  useEffect(() => onUnauthorized(() => logout('Your session has expired. Please sign in again.')), [logout])

  useEffect(() => {
    if (!tokenStore.get()) return
    let cancelled = false
    api
      .get<User>('/auth/me')
      .then((u) => !cancelled && setUser(u))
      .catch(() => !cancelled && tokenStore.set(null))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<TokenResponse>('/auth/login', { email, password })
    tokenStore.set(res.access_token)
    setSessionMessage(null)
    setUser(res.user)
    return res.user
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, logout, can: (p) => roleCan(user?.role, p), sessionMessage }),
    [user, loading, login, logout, sessionMessage],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
