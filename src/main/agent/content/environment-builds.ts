import type { EnvHandle } from '../envs'
import { computeEnvId } from '../envs'
import { estimateBuild } from '../envs/estimate'
import type {
  EnvironmentBuild,
  EnvironmentBuildEstimate,
  EnvironmentBuildProgress
} from '../../../shared/environmentBuildTypes'
import { buildEnvironment, type EnvironmentDescriptor } from './environment-refs'

const FINISHED_LIMIT = 20
const SAMPLE_MS = 1000

export interface EnvironmentBuildStartOptions {
  ref: string
  requestedBy?: { skill?: string }
}

export interface EnvironmentBuilds {
  start(
    descriptor: EnvironmentDescriptor,
    options: EnvironmentBuildStartOptions
  ): Promise<EnvHandle>
  list(): EnvironmentBuild[]
  cancel(envId: string): void
}

interface ActiveBuild {
  controller: AbortController
  record: EnvironmentBuild
  promise: Promise<EnvHandle>
  timer?: ReturnType<typeof setInterval>
}

function cloneBuild(record: EnvironmentBuild): EnvironmentBuild {
  return {
    ...record,
    estimate: { ...record.estimate },
    progress: { ...record.progress }
  }
}

function progressFrom(estimate: EnvironmentBuildEstimate): EnvironmentBuildProgress {
  const progress: EnvironmentBuildProgress = {
    packagesDone: estimate.cachedPackages,
    packages: estimate.packages
  }
  if (estimate.downloadBytes !== undefined && estimate.remainingBytes !== undefined) {
    progress.bytesTotal = estimate.downloadBytes
    progress.bytesDone = estimate.downloadBytes - estimate.remainingBytes
  }
  return progress
}

function sameProgress(left: EnvironmentBuildProgress, right: EnvironmentBuildProgress): boolean {
  return (
    left.packagesDone === right.packagesDone &&
    left.packages === right.packages &&
    left.bytesDone === right.bytesDone &&
    left.bytesTotal === right.bytesTotal
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createEnvironmentBuilds({
  root,
  build = buildEnvironment,
  onChange
}: {
  root: string
  build?: typeof buildEnvironment
  onChange?: (build: EnvironmentBuild) => void
}): EnvironmentBuilds {
  const records = new Map<string, ActiveBuild>()
  const order: string[] = []

  function publish(active: ActiveBuild): void {
    onChange?.(cloneBuild(active.record))
  }

  function stopSampling(active: ActiveBuild): void {
    if (!active.timer) return
    clearInterval(active.timer)
    active.timer = undefined
  }

  function startSampling(active: ActiveBuild, lockText: string): void {
    if (active.timer) return
    const timer = setInterval(() => {
      if (active.record.state !== 'building' || active.record.phase !== 'create') {
        stopSampling(active)
        return
      }
      let progress: EnvironmentBuildProgress
      try {
        progress = progressFrom(estimateBuild(root, lockText))
      } catch {
        // The cache can change under a running build; skip this sample rather than
        // throwing from a timer in the main process.
        return
      }
      if (sameProgress(active.record.progress, progress)) return
      active.record.progress = progress
      publish(active)
    }, SAMPLE_MS)
    timer.unref()
    active.timer = timer
  }

  function remember(envId: string): void {
    const index = order.indexOf(envId)
    if (index !== -1) order.splice(index, 1)
    order.unshift(envId)
    let finished = 0
    for (let cursor = 0; cursor < order.length;) {
      const id = order[cursor]
      const active = id === undefined ? undefined : records.get(id)
      if (!id || !active) {
        order.splice(cursor, 1)
        continue
      }
      if (active.record.state === 'building') {
        cursor += 1
        continue
      }
      finished += 1
      if (finished <= FINISHED_LIMIT) {
        cursor += 1
        continue
      }
      stopSampling(active)
      records.delete(id)
      order.splice(cursor, 1)
    }
  }

  function finish(
    active: ActiveBuild,
    state: 'ready' | 'failed' | 'cancelled',
    error?: unknown
  ): void {
    if (active.record.state !== 'building') return
    stopSampling(active)
    active.record.state = state
    active.record.finishedAt = new Date().toISOString()
    if (state === 'ready') {
      if (!active.record.message) active.record.message = `${active.record.envId} is ready`
    } else {
      const message = error ? errorMessage(error) : state
      active.record.error = message
      if (state === 'cancelled') {
        active.record.phase = 'cancelled'
        active.record.message = message
      } else if (active.record.phase !== 'failed') {
        active.record.phase = 'failed'
        active.record.message = message
      }
    }
    remember(active.record.envId)
    publish(active)
  }

  function applyProgress(
    active: ActiveBuild,
    lockText: string,
    event: { phase: string; message: string }
  ): void {
    if (active.record.state !== 'building') return
    const changed = active.record.phase !== event.phase || active.record.message !== event.message
    active.record.phase = event.phase
    active.record.message = event.message
    if (event.phase === 'create') startSampling(active, lockText)
    else stopSampling(active)
    if (changed) publish(active)
  }

  async function execute(
    active: ActiveBuild,
    descriptor: EnvironmentDescriptor
  ): Promise<EnvHandle> {
    await Promise.resolve()
    try {
      const handle = await build(root, descriptor, {
        signal: active.controller.signal,
        onProgress: (event) => applyProgress(active, descriptor.lockText, event)
      })
      if (active.record.state === 'cancelled') {
        throw new Error(active.record.error ?? 'environment build cancelled')
      }
      finish(active, 'ready')
      return handle
    } catch (error) {
      if (active.record.state === 'building') {
        finish(active, active.controller.signal.aborted ? 'cancelled' : 'failed', error)
      }
      throw error instanceof Error ? error : new Error(errorMessage(error))
    }
  }

  return {
    start(descriptor, options) {
      const envId = computeEnvId({
        scope: descriptor.scope,
        owner: descriptor.owner,
        name: descriptor.spec.name,
        platform: descriptor.platform,
        lockText: descriptor.lockText,
        sourcePackages: descriptor.spec.sourcePackages
      })
      const existing = records.get(envId)
      if (existing?.record.state === 'building') return existing.promise

      const estimate = estimateBuild(root, descriptor.lockText)
      const record: EnvironmentBuild = {
        envId,
        ref: options.ref,
        state: 'building',
        phase: 'check',
        message: 'preparing',
        startedAt: new Date().toISOString(),
        estimate,
        progress: progressFrom(estimate)
      }
      const placeholder = Promise.reject(new Error('environment build was not started'))
      void placeholder.catch(() => undefined)
      const active: ActiveBuild = {
        controller: new AbortController(),
        record,
        promise: placeholder
      }
      active.promise = execute(active, descriptor)
      records.set(envId, active)
      remember(envId)
      publish(active)
      return active.promise
    },

    list() {
      return order.flatMap((id) => {
        const active = records.get(id)
        return active ? [cloneBuild(active.record)] : []
      })
    },

    cancel(envId) {
      const active = records.get(envId)
      if (!active || active.record.state !== 'building') return
      active.controller.abort()
      finish(active, 'cancelled', new Error('environment build cancelled'))
    }
  }
}
