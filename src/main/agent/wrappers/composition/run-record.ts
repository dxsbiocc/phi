import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { getPhiAgentDir } from '../../runtime-paths'
import {
  appendWrapperAuditEvent,
  appendWrapperRunEvent,
  getWrapperRunsDir,
  listWrapperRuns,
  writeWrapperRun
} from '../store'
import type { WrapperOutputRecord, WrapperRun, WrapperRunProgress, WrapperRunState } from '../types'
import type { WrapperCompositionEntry } from './discovery'
import { resolveOutputPaths } from './validate'

/**
 * Persists composition-layer runs (`wrapper_run`) into the same run store the
 * Wrappers view already reads, so an agent-initiated run shows up in that
 * wrapper's 运行记录 with its state, output directory and reproducibility
 * export. These runs have no plan: `planId` is empty and `origin` is
 * 'composition'. Recording is best-effort — callers must not let a store
 * problem block or fail the run itself.
 */

export type CompositionRunOutcome = 'completed' | 'failed' | 'cancelled'

const TERMINAL_STATES: WrapperRunState[] = ['completed', 'failed', 'cancelled', 'lost']

function wrapperIdentity(id: string): WrapperRun['wrapper'] {
  const cut = id.lastIndexOf('/')
  return {
    canonicalId: id,
    namespace: cut >= 0 ? id.slice(0, cut) : '',
    shortId: id.slice(cut + 1),
    // The composition manifest has no version; don't invent a SemVer.
    version: 'unversioned'
  }
}

function writeRunFile(runId: string, agentDir: string, fileName: string, value: unknown): void {
  const dir = join(getWrapperRunsDir(agentDir), runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function recordTransition(
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
      wrapperId: run.wrapper.canonicalId,
      wrapperVersion: run.wrapper.version,
      detail: { state }
    },
    agentDir
  )
  return updated
}

/** Records a run that is about to start, in state `running`. `params` are the merged (default + override) values. */
export function startCompositionRun(input: {
  entry: WrapperCompositionEntry
  params: Record<string, unknown>
  profile: string
  originSessionId?: string
  continueWhenDone?: boolean
  agentDir?: string
}): WrapperRun {
  const { entry, params, profile } = input
  const agentDir = input.agentDir ?? getPhiAgentDir()
  const now = new Date().toISOString()
  const declaredOutdir = typeof params.outdir === 'string' ? params.outdir : ''
  const outDir = !declaredOutdir
    ? ''
    : isAbsolute(declaredOutdir)
      ? declaredOutdir
      : resolve(entry.componentDir, declaredOutdir)

  const run: WrapperRun = {
    runId: `wrun_${randomUUID()}`,
    planId: '',
    revision: 1,
    state: 'running',
    actor: 'agent',
    wrapper: wrapperIdentity(entry.manifest.id),
    trustTier: 'bundled',
    executor: 'local',
    profile,
    nextflowProfile: profile,
    cwd: entry.componentDir,
    outDir,
    origin: 'composition',
    ...(input.originSessionId ? { originSessionId: input.originSessionId } : {}),
    ...(input.continueWhenDone === false ? { continueWhenDone: false } : {}),
    createdAt: now,
    updatedAt: now,
    startedAt: now
  }
  writeWrapperRun(run, agentDir)
  writeRunFile(run.runId, agentDir, 'params.json', params)
  appendWrapperRunEvent(
    run.runId,
    { type: 'run_created', timestamp: now, wrapperId: run.wrapper.canonicalId, profile },
    agentDir
  )
  appendWrapperAuditEvent(
    {
      type: 'run_state_changed',
      timestamp: now,
      actor: 'agent',
      runId: run.runId,
      wrapperId: run.wrapper.canonicalId,
      wrapperVersion: run.wrapper.version,
      detail: { state: 'running' }
    },
    agentDir
  )
  return run
}

function outputRecords(
  entry: WrapperCompositionEntry,
  params: Record<string, unknown>
): WrapperOutputRecord[] {
  return resolveOutputPaths(entry.manifest, params, entry.componentDir).map((output) => {
    const exists = existsSync(output.absolutePath)
    let bytes: number | undefined
    try {
      if (exists && statSync(output.absolutePath).isFile())
        bytes = statSync(output.absolutePath).size
    } catch {
      bytes = undefined
    }
    return {
      id: output.id,
      path: output.absolutePath,
      exists,
      ...(bytes !== undefined ? { bytes } : {}),
      primary: output.primary,
      location: 'local'
    }
  })
}

/** Moves a started run to its terminal state and stores its outputs, summary and log tail. */
export function finishCompositionRun(input: {
  run: WrapperRun
  entry: WrapperCompositionEntry
  params: Record<string, unknown>
  outcome: CompositionRunOutcome
  exitCode: number
  output: string
  missingOutputs: string[]
  progress?: WrapperRunProgress
  agentDir?: string
}): WrapperRun {
  const { run, entry, params, outcome } = input
  const agentDir = input.agentDir ?? getPhiAgentDir()
  const outputs = outputRecords(entry, params)
  const completedAt = new Date().toISOString()

  writeRunFile(run.runId, agentDir, 'outputs.json', outputs)
  writeRunFile(run.runId, agentDir, 'summary.json', {
    success: outcome === 'completed',
    state: outcome,
    exitCode: input.exitCode,
    missingOutputs: input.missingOutputs,
    logTail: input.output,
    // The composition manifest as it was when the run started (the legacy
    // export path only knows the older package manifest).
    manifest: entry.manifest,
    finishedAt: completedAt
  })
  return recordTransition(run, agentDir, outcome, {
    completedAt,
    exitCode: input.exitCode,
    outputs,
    ...(input.progress ? { progress: input.progress } : {})
  })
}

/** A cancel was requested for a live run; Nextflow is being stopped. */
export function markCompositionRunCancelling(run: WrapperRun, agentDir?: string): WrapperRun {
  return recordTransition(run, agentDir ?? getPhiAgentDir(), 'cancelling')
}

/**
 * Startup pass: a composition run still in a non-terminal state belongs to a
 * process that no longer exists (the app or worker quit mid-run), so nobody
 * will ever finish it. It is marked `lost` — not `failed`, because its real
 * outcome is unknown. Returns how many runs were changed.
 */
export function markInterruptedCompositionRuns(agentDir: string = getPhiAgentDir()): number {
  let changed = 0
  for (const run of listWrapperRuns(agentDir)) {
    if (run.origin !== 'composition' || TERMINAL_STATES.includes(run.state)) continue
    recordTransition(run, agentDir, 'lost', { completedAt: new Date().toISOString() })
    changed += 1
  }
  return changed
}
