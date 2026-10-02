import { useCallback, useSyncExternalStore } from 'react'

const KEY = 'stocksense.theme'
export type Theme = 'light' | 'dark'

function initial(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* storage unavailable */
  }
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// Tiny external store so every component (header toggle, settings page) sees the same theme.
let current: Theme = initial()
const listeners = new Set<() => void>()

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

function setThemeGlobal(theme: Theme) {
  current = theme
  applyTheme(theme)
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current, () => current)
  const toggle = useCallback(() => setThemeGlobal(current === 'dark' ? 'light' : 'dark'), [])
  return { theme, setTheme: setThemeGlobal, toggle }
}

applyTheme(current)
