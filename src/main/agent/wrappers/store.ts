import { createHash } from 'node:crypto'
import { restoreResearchQc } from './composition/research-qc'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import { appendAuditLine } from './audit'
import type { WrapperAuditEvent, WrapperEvent, WrapperRun, WrapperRunPlan } from './types'

const WRAPPERS_DIR_NAME = 'wrappers'
const GLOBAL_AUDIT_FILE = 'audit.jsonl'

export function getWrappersRootDir(agentDir = getPhiAgentDir()): string {
  return join(agentDir, WRAPPERS_DIR_NAME)
}

export function getInstalledWrappersDir(agentDir = getPhiAgentDir()): string {
  return join(getWrappersRootDir(agentDir), 'installed')
}

export function getWrapperPlansDir(agentDir = getPhiAgentDir()): string {
  return join(getWrappersRootDir(agentDir), 'plans')
}

export function getWrapperRunsDir(agentDir = getPhiAgentDir()): string {
  return join(getWrappersRootDir(agentDir), 'runs')
}

function getPlanDir(planId: string, agentDir = getPhiAgentDir()): string {
  return join(getWrapperPlansDir(agentDir), planId)
}

function getRunDir(runId: string, agentDir = getPhiAgentDir()): string {
  return join(getWrapperRunsDir(agentDir), runId)
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
  }
}

/** Creates `installed/`, `plans/`, and `runs/` under `~/.phi/wrappers` if they don't exist. */
export function ensureWrapperStorageDirs(agentDir = getPhiAgentDir()): void {
  ensureDir(getInstalledWrappersDir(agentDir))
  ensureDir(getWrapperPlansDir(agentDir))
  ensureDir(getWrapperRunsDir(agentDir))
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return undefined
  }
}

function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path))
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

// --- Plans ---------------------------------------------------------------

export function writeWrapperPlan(
  plan: WrapperRunPlan,
  agentDir = getPhiAgentDir()
): WrapperRunPlan {
  writeJson(join(getPlanDir(plan.planId, agentDir), 'plan.json'), plan)
  return plan
}

export function readWrapperPlan(
  planId: string,
  agentDir = getPhiAgentDir()
): WrapperRunPlan | undefined {
  return readJson<WrapperRunPlan>(join(getPlanDir(planId, agentDir), 'plan.json'))
}

/** Persists a plan-scoped artifact (e.g. a generated samplesheet CSV) alongside `plan.json`. */
export function writeWrapperPlanArtifact(
  planId: string,
  fileName: string,
  content: string,
  agentDir = getPhiAgentDir()
): void {
  const dir = getPlanDir(planId, agentDir)
  ensureDir(dir)
  writeFileSync(join(dir, fileName), content, 'utf-8')
}

export function readWrapperPlanArtifact(
  planId: string,
  fileName: string,
  agentDir = getPhiAgentDir()
): string | undefined {
  const path = join(getPlanDir(planId, agentDir), fileName)
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf-8')
}

export function listWrapperPlanIds(agentDir = getPhiAgentDir()): string[] {
  const dir = getWrapperPlansDir(agentDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

export function listWrapperPlans(agentDir = getPhiAgentDir()): WrapperRunPlan[] {
  return listWrapperPlanIds(agentDir)
    .map((id) => readWrapperPlan(id, agentDir))
    .filter((plan): plan is WrapperRunPlan => plan !== undefined)
}

// --- Runs ------------------------------------------------------------------

export function writeWrapperRun(run: WrapperRun, agentDir = getPhiAgentDir()): WrapperRun {
  writeJson(join(getRunDir(run.runId, agentDir), 'run.json'), run)
  return run
}

export function readWrapperRun(runId: string, agentDir = getPhiAgentDir()): WrapperRun | undefined {
  const run = readJson<WrapperRun>(join(getRunDir(runId, agentDir), 'run.json'))
  if (!run || run.researchQc === undefined) return run
  const researchQc = restoreResearchQc(run.researchQc)
  const state =
    run.state === 'completed' &&
    (researchQc.disposition === 'invalid' || researchQc.disposition === 'needs_input')
      ? 'failed'
      : run.state
  return { ...run, researchQc, state }
}

export function listWrapperRunIds(agentDir = getPhiAgentDir()): string[] {
  const dir = getWrapperRunsDir(agentDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

export function listWrapperRuns(agentDir = getPhiAgentDir()): WrapperRun[] {
  return listWrapperRunIds(agentDir)
    .map((id) => readWrapperRun(id, agentDir))
    .filter((run): run is WrapperRun => run !== undefined)
}

export interface WrapperManifestSnapshot {
  capturedAt: string
  sha256: string
  manifest: unknown
}

const MANIFEST_SNAPSHOT_FILE = 'manifest.snapshot.json'

/**
 * Freezes the wrapper manifest as it existed when the run was created.
 * Write-once: if a snapshot already exists for this run, it is never overwritten.
 */
export function writeWrapperManifestSnapshot(
  runId: string,
  manifest: unknown,
  agentDir = getPhiAgentDir()
): WrapperManifestSnapshot {
  const path = join(getRunDir(runId, agentDir), MANIFEST_SNAPSHOT_FILE)
  const existing = readJson<WrapperManifestSnapshot>(path)
  if (existing) return existing
  const snapshot: WrapperManifestSnapshot = {
    capturedAt: new Date().toISOString(),
    sha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    manifest
  }
  ensureDir(dirname(path))
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8')
  return snapshot
}

export function readWrapperManifestSnapshot(
  runId: string,
  agentDir = getPhiAgentDir()
): WrapperManifestSnapshot | undefined {
  return readJson<WrapperManifestSnapshot>(join(getRunDir(runId, agentDir), MANIFEST_SNAPSHOT_FILE))
}

// --- Append-only run events --------------------------------------------------

/** Appends one event to `runs/<runId>/events.jsonl` without touching prior lines. */
export function appendWrapperRunEvent(
  runId: string,
  event: WrapperEvent,
  agentDir = getPhiAgentDir()
): void {
  const path = join(getRunDir(runId, agentDir), 'events.jsonl')
  ensureDir(getRunDir(runId, agentDir))
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf-8')
}

export function readWrapperRunEvents(runId: string, agentDir = getPhiAgentDir()): WrapperEvent[] {
  const path = join(getRunDir(runId, agentDir), 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WrapperEvent)
}

// --- Audit -------------------------------------------------------------------

/**
 * Appends a redacted audit event to the global wrapper audit log, and, when
 * the event names a run, also to that run's own `audit.jsonl` so run detail
 * views can show a self-contained trail.
 */
export function appendWrapperAuditEvent(
  event: WrapperAuditEvent,
  agentDir = getPhiAgentDir()
): void {
  appendAuditLine(join(getWrappersRootDir(agentDir), GLOBAL_AUDIT_FILE), event)
  if (event.runId) {
    appendAuditLine(join(getRunDir(event.runId, agentDir), 'audit.jsonl'), event)
  }
}

export function readGlobalWrapperAuditEvents(agentDir = getPhiAgentDir()): WrapperAuditEvent[] {
  const path = join(getWrappersRootDir(agentDir), GLOBAL_AUDIT_FILE)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WrapperAuditEvent)
}
