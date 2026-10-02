import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const currencyCompact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export const fmt = {
  money: (v: number | string | null | undefined) => (v == null ? '—' : currency.format(Number(v))),
  moneyCompact: (v: number | string | null | undefined) => (v == null ? '—' : currencyCompact.format(Number(v))),
  num: (v: number | string | null | undefined) => (v == null ? '—' : number.format(Number(v))),
  int: (v: number | string | null | undefined) => (v == null ? '—' : integer.format(Number(v))),
  pct: (v: number | null | undefined, digits = 1) => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`),
  date: (v: string | null | undefined) =>
    v ? new Date(v.length === 10 ? `${v}T00:00:00` : v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
  shortDate: (v: string | null | undefined) =>
    v ? new Date(v.length === 10 ? `${v}T00:00:00` : v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—',
  dateTime: (v: string | null | undefined) =>
    v
      ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
      : '—',
  relative: (v: string | null | undefined) => {
    if (!v) return '—'
    const diff = (Date.now() - new Date(v).getTime()) / 1000
    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return `${Math.floor(diff / 86400)}d ago`
  },
  label: (v: string | null | undefined) =>
    v ? v.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—',
}

export function isoDate(d: Date): string {
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10)
}

export function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return isoDate(d)
}
