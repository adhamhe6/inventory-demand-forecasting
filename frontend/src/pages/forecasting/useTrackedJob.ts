import { useEffect, useRef } from 'react'
import { useJob } from '@/api/queries'
import type { Job } from '@/lib/types'

/**
 * Polls a background job (via useJob) and fires `onDone` exactly once when it reaches a
 * terminal state. Returns the live job query.
 */
export function useTrackedJob(jobId: string | null, onDone: (job: Job) => void) {
  const q = useJob(jobId)
  const handled = useRef<string | null>(null)
  const cb = useRef(onDone)
  useEffect(() => {
    cb.current = onDone
  })
  const job = q.data
  useEffect(() => {
    if (!job || job.id !== jobId) return
    if ((job.status === 'SUCCEEDED' || job.status === 'FAILED') && handled.current !== job.id) {
      handled.current = job.id
      cb.current(job)
    }
  }, [job, jobId])
  return q
}

export function isActive(job: Job | undefined | null): boolean {
  return !!job && (job.status === 'QUEUED' || job.status === 'RUNNING')
}

export function jobDuration(job: Pick<Job, 'created_at' | 'started_at' | 'finished_at'>, now = Date.now()): string {
  const start = job.started_at ?? job.created_at
  const end = job.finished_at ? new Date(job.finished_at).getTime() : now
  const ms = Math.max(0, end - new Date(start).getTime())
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}
