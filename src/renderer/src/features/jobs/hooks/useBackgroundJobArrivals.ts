import { useEffect, useRef, useState } from 'react'

import type { LiveBackgroundJob } from '../lib/backgroundJobs'
import { groupBackgroundJobs, type BackgroundJobDisplayItem } from '../lib/backgroundJobGroups'
import { useBackgroundJobsData } from './useBackgroundJobsData'

const NOTICE_MS = 5000
const MAX_NOTICES = 3

export type BackgroundJobArrival = {
  item: BackgroundJobDisplayItem
  phase: 'added' | 'completed' | 'failed'
}

export function workflowPhase(item: BackgroundJobDisplayItem): 'running' | 'completed' | 'failed' {
  if (item.kind !== 'workflow') return 'running'
  if (item.jobs.some((job) => ['failed', 'lost'].includes(job.run.state))) return 'failed'
  if (
    item.expectedSteps !== undefined &&
    item.jobs.length >= item.expectedSteps &&
    item.jobs.every((job) => job.run.state === 'completed')
  )
    return 'completed'
  return 'running'
}

/** A plugin install reports its terminal transition; other single jobs only report arrival. */
export function backgroundJobPhase(
  item: BackgroundJobDisplayItem
): 'running' | 'completed' | 'failed' {
  if (item.kind === 'workflow') return workflowPhase(item)
  if (item.kind === 'job' && item.job.kind === 'plugin' && !item.job.active) {
    return item.job.install.state === 'succeeded' ? 'completed' : 'failed'
  }
  return 'running'
}

/**
 * A history entry is never a new task. The first loaded snapshot only establishes a baseline.
 * A job that first appears already finished before `sinceMs` (for example the plan steps of a
 * session that was just reopened) is old work being loaded, not a new task.
 */
export function newlyObservedJobs<T extends { key: string; active?: boolean; timestamp?: string }>(
  jobs: readonly T[],
  known: Set<string>,
  sinceMs?: number
): T[] {
  const added = jobs.filter((job) => !known.has(job.key) && !finishedBefore(job, sinceMs))
  for (const job of jobs) known.add(job.key)
  return added
}

function finishedBefore(job: { active?: boolean; timestamp?: string }, sinceMs?: number): boolean {
  if (sinceMs === undefined || job.active !== false || !job.timestamp) return false
  const finishedMs = Date.parse(job.timestamp)
  return Number.isFinite(finishedMs) && finishedMs < sinceMs
}

export function useBackgroundJobArrivals(): {
  arrivals: BackgroundJobArrival[]
  dismiss: (key: string) => void
} {
  const { jobs, loaded } = useBackgroundJobsData()
  const known = useRef<Set<string> | null>(null)
  const baselineMs = useRef(0)
  const phases = useRef(new Map<string, ReturnType<typeof workflowPhase>>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [arrivals, setArrivals] = useState<BackgroundJobArrival[]>([])

  useEffect(() => {
    if (!loaded) return
    const live = [...jobs.active, ...jobs.recent].filter(
      (job): job is LiveBackgroundJob => job.kind !== 'history'
    )
    const display = groupBackgroundJobs(live)
    if (known.current === null) {
      known.current = new Set(display.map((job) => job.key))
      baselineMs.current = Date.now()
      for (const item of display) phases.current.set(item.key, backgroundJobPhase(item))
      return
    }
    const added = newlyObservedJobs(display, known.current, baselineMs.current)
    const addedKeys = new Set(added.map((item) => item.key))
    const notices: BackgroundJobArrival[] = added.map((item) => ({ item, phase: 'added' }))
    for (const item of display) {
      const phase = backgroundJobPhase(item)
      const previous = phases.current.get(item.key)
      if (
        !addedKeys.has(item.key) &&
        previous !== undefined &&
        previous !== phase &&
        (phase === 'completed' || phase === 'failed')
      )
        notices.push({ item, phase })
      phases.current.set(item.key, phase)
    }
    if (notices.length === 0) return
    const keys = new Set(notices.map(({ item }) => item.key))
    setArrivals((previous) =>
      [...notices, ...previous.filter(({ item }) => !keys.has(item.key))].slice(0, MAX_NOTICES)
    )
    for (const { item } of notices) {
      const job = item
      const previous = timers.current.get(job.key)
      if (previous) clearTimeout(previous)
      timers.current.set(
        job.key,
        setTimeout(() => {
          setArrivals((current) => current.filter((arrival) => arrival.item.key !== job.key))
          timers.current.delete(job.key)
        }, NOTICE_MS)
      )
    }
  }, [jobs.active, jobs.recent, loaded])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const dismiss = (key: string): void => {
    const timer = timers.current.get(key)
    if (timer) clearTimeout(timer)
    timers.current.delete(key)
    setArrivals((current) => current.filter((arrival) => arrival.item.key !== key))
  }

  return { arrivals, dismiss }
}
