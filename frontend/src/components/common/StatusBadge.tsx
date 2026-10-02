import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, Clock, PackageX, XCircle } from 'lucide-react'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import type { JobStatus, POStatus, RiskLevel, StockStatus } from '@/lib/types'

type Variant = BadgeProps['variant']

const STOCK: Record<StockStatus, { label: string; variant: Variant; icon: typeof CheckCircle2 }> = {
  HEALTHY: { label: 'Healthy', variant: 'success', icon: CheckCircle2 },
  LOW_STOCK: { label: 'Low Stock', variant: 'warning', icon: AlertTriangle },
  CRITICAL: { label: 'Critical', variant: 'orange', icon: AlertOctagon },
  OUT_OF_STOCK: { label: 'Out of Stock', variant: 'danger', icon: PackageX },
}

export function StockStatusBadge({ status }: { status: StockStatus }) {
  const s = STOCK[status]
  const Icon = s.icon
  return (
    <Badge variant={s.variant}>
      <Icon aria-hidden />
      {s.label}
    </Badge>
  )
}

const RISK: Record<RiskLevel, { label: string; variant: Variant }> = {
  CRITICAL: { label: 'Critical', variant: 'danger' },
  HIGH: { label: 'High', variant: 'orange' },
  MEDIUM: { label: 'Medium', variant: 'warning' },
  LOW: { label: 'Low', variant: 'info' },
  NONE: { label: 'None', variant: 'success' },
}

export const RISK_COLORS: Record<RiskLevel, string> = {
  CRITICAL: '#dc2626',
  HIGH: '#ea580c',
  MEDIUM: '#d97706',
  LOW: '#0284c7',
  NONE: '#059669',
}

export function RiskBadge({ level }: { level: RiskLevel }) {
  const r = RISK[level]
  return (
    <Badge variant={r.variant}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {r.label}
    </Badge>
  )
}

const PO: Record<POStatus, { label: string; variant: Variant }> = {
  DRAFT: { label: 'Draft', variant: 'muted' },
  SUBMITTED: { label: 'Submitted', variant: 'info' },
  CONFIRMED: { label: 'Confirmed', variant: 'default' },
  PARTIALLY_RECEIVED: { label: 'Partially received', variant: 'warning' },
  RECEIVED: { label: 'Received', variant: 'success' },
  CANCELLED: { label: 'Cancelled', variant: 'danger' },
}

export function POStatusBadge({ status }: { status: POStatus }) {
  return <Badge variant={PO[status].variant}>{PO[status].label}</Badge>
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const map: Record<JobStatus, { v: Variant; icon: typeof Clock; label: string }> = {
    QUEUED: { v: 'muted', icon: Clock, label: 'Queued' },
    RUNNING: { v: 'info', icon: CircleDashed, label: 'Running' },
    SUCCEEDED: { v: 'success', icon: CheckCircle2, label: 'Succeeded' },
    FAILED: { v: 'danger', icon: XCircle, label: 'Failed' },
  }
  const m = map[status]
  const Icon = m.icon
  return (
    <Badge variant={m.v}>
      <Icon className={status === 'RUNNING' ? 'animate-spin' : undefined} aria-hidden />
      {m.label}
    </Badge>
  )
}

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? <Badge variant="success">Active</Badge> : <Badge variant="muted">Inactive</Badge>
}
