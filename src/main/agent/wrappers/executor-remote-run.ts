import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  joinRemote,
  type RemoteJobHandle,
  type RemoteRunner,
  type RemoteRunStatus
} from './executor-remote'
import type { WrapperManifest } from './manifest-types'
import type { RemoteSshSession } from './remote-ssh-session'
import {
  appendWrapperAuditEvent,
  appendWrapperRunEvent,
  getWrapperRunsDir,
  readWrapperRun,
  writeWrapperRun
} from './store'
import type { WrapperOutputRecord, WrapperRun, WrapperRunState } from './types'

/**
 * Orchestration primitives shared by every remote submit orchestrator —
 * `executor-slurm-submit.ts`'s `runSlurmWrapperExecution` (the `sbatch`
 * controller) and `executor-remote-background-submit.ts`'s
 * `runRemoteBackgroundWrapperExecution` (the `detached_ssh` controller).
 * None of this is specific to either controller: state transitions, output
 * collection, and the reconnect snapshot all operate on the generic
 * `RemoteRunner`/`RemoteSshSession` interfaces from `executor-remote.ts`.
 * The actual submit *sequence* (connect → upload → launch → poll →
 * finalize) is deliberately still duplicated between the two orchestrators
 * rather than unified behind this module — matches this codebase's existing
 * "duplicated on purpose" convention for keeping executors independently
 * modifiable (see `executor-slurm-submit.ts`'s own doc comment on
 * `transition`/`failRun`).
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function transition(
  run: WrapperRun,
  agentDir: string,
  state: WrapperRunState,
  patch: Partial<WrapperRun> = {}
): WrapperRun {
  const updated: WrapperRun = { ...run, ...patch, state, updatedAt: new Date().toISOString() }
  writeWrapperRun(updated, agentDir)
  appendWrapperRunEvent(
    run.runId,
    { type: 'run_state_changed', timestamp: updated.updatedAt, state },
    agentDir
  )
  appendWrapperAuditEvent(
    {
      type: 'run_state_changed',
      timestamp: updated.updatedAt,
      actor: run.actor,
      runId: run.runId,
      planId: run.planId,
      wrapperId: run.wrapper.canonicalId,
      wrapperVersion: run.wrapper.version,
      detail: { state }
    },
    agentDir
  )
  return updated
}

/** A verified cancel may finish while an older poll is awaiting SSH or outputs. */
export function transitionUnlessCancelled(
  run: WrapperRun,
  agentDir: string,
  state: WrapperRunState,
  patch: Partial<WrapperRun> = {}
): WrapperRun {
  const current = readWrapperRun(run.runId, agentDir)
  return current?.state === 'cancelled'
    ? current
    : transition(current ?? run, agentDir, state, patch)
}

export function failRun(run: WrapperRun, agentDir: string, reason: string): WrapperRun {
  const failed = transition(run, agentDir, 'failed', { completedAt: new Date().toISOString() })
  appendWrapperAuditEvent(
    {
      type: 'run_state_changed',
      timestamp: failed.updatedAt,
      actor: run.actor,
      runId: run.runId,
      planId: run.planId,
      wrapperId: run.wrapper.canonicalId,
      wrapperVersion: run.wrapper.version,
      detail: { state: 'failed', reason }
    },
    agentDir
  )
  return failed
}

/**
 * Existence-only output collection — there's no cheap remote `stat` in
 * `RemoteSshSession` yet, so `bytes` is left unset. `location: 'remote'` is
 * already part of `WrapperOutputRecord`'s type (added when the full Phase 2
 * shape was typed up front), so this needs no type changes.
 */
export async function collectRemoteOutputs(
  session: RemoteSshSession,
  manifest: WrapperManifest,
  remoteOutDir: string
): Promise<WrapperOutputRecord[]> {
  const outputs: WrapperOutputRecord[] = []
  for (const output of manifest.outputs) {
    const path = joinRemote(remoteOutDir, output.path)
    const exists = await session.exists(path)
    outputs.push({ id: output.id, path, exists, primary: output.primary, location: 'remote' })
  }
  return outputs
}

export async function pollUntilTerminal(
  runner: RemoteRunner,
  handle: RemoteJobHandle,
  pollIntervalMs: number
): Promise<RemoteRunStatus> {
  for (;;) {
    const status = await runner.status(handle)
    if (status.outcome !== 'running') return status
    await sleep(pollIntervalMs)
  }
}

/** What `readRemoteRunSnapshot` needs to rebuild a `RemoteJobHandle` for a run submitted in a prior app session. */
export interface RemoteRunSnapshot {
  remoteRunDir: string
  /** No second launch is allowed while this claim's outcome is uncertain. */
  launchUnknown?: true
  /** Set by the `sbatch` controller. Exactly one of jobId/pid is set. */
  jobId?: string
  /** Set by the `detached_ssh` controller. Exactly one of jobId/pid is set. */
  pid?: number
}

const REMOTE_SNAPSHOT_FILE = 'remote.snapshot.json'

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

export function writeRemoteRunSnapshot(
  runId: string,
  agentDir: string,
  snapshot: RemoteRunSnapshot
): void {
  const runDir = join(getWrapperRunsDir(agentDir), runId)
  ensureDir(runDir)
  writeFileSync(
    join(runDir, REMOTE_SNAPSHOT_FILE),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf-8'
  )
}

/**
 * Reads back the snapshot a submit orchestrator writes right after its
 * controller accepts the job — enough to rebuild a `RemoteJobHandle` and
 * resume polling after a restart. Used by the startup remote reconciliation
 * pass and by `runs.ts`'s `cancelWrapperRun` (to find
 * the job id/pid to cancel for an already-running remote run).
 */
export function readRemoteRunSnapshot(
  runId: string,
  agentDir: string
): RemoteRunSnapshot | undefined {
  const path = join(getWrapperRunsDir(agentDir), runId, REMOTE_SNAPSHOT_FILE)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RemoteRunSnapshot
  } catch {
    return undefined
  }
}
