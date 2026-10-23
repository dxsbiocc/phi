import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { PlanRunState } from '../../../../shared/planRunTypes'
import { getPhiAgentDir } from '../../runtime-paths'
import {
  readRecoveryFile,
  recoveryFile,
  writeRecoveryFile
} from '../../session/private-recovery-file'
import { getPhiSessionsDir } from '../../session/session-store'
import { validatePlanRunState } from '../model/plan-run-state'

export const PLAN_RUN_MAX_BYTES = 256 * 1024
const SAFE_FILENAME_FRAGMENT = /^[A-Za-z0-9_-]+$/
const PLAN_RUNS_DIRECTORY = 'plan-runs'

function assertSafeFragment(value: string, label: 'session' | 'run'): void {
  if (!SAFE_FILENAME_FRAGMENT.test(value)) throw new Error(`Invalid ${label} id`)
}

function assertSafeIdentifiers(sessionId: string, runId: string): void {
  assertSafeFragment(sessionId, 'session')
  assertSafeFragment(runId, 'run')
}

export function planRunPath(sessionId: string, runId: string, agentDir = getPhiAgentDir()): string {
  assertSafeIdentifiers(sessionId, runId)
  return join(getPhiSessionsDir(agentDir), sessionId, PLAN_RUNS_DIRECTORY, `${runId}.json`)
}

function securePlanRunPath(
  sessionId: string,
  runId: string,
  agentDir: string,
  create: boolean
): string {
  return recoveryFile(
    agentDir,
    ['sessions', sessionId, PLAN_RUNS_DIRECTORY, `${runId}.json`],
    create
  )
}

export function writePlanRun(state: PlanRunState, agentDir = getPhiAgentDir()): void {
  assertSafeIdentifiers(state.sessionId, state.id)
  const path = securePlanRunPath(state.sessionId, state.id, agentDir, true)
  writeRecoveryFile(path, state, PLAN_RUN_MAX_BYTES)
}

export function readPlanRun(
  sessionId: string,
  runId: string,
  agentDir = getPhiAgentDir()
): PlanRunState | null {
  assertSafeIdentifiers(sessionId, runId)
  try {
    const path = securePlanRunPath(sessionId, runId, agentDir, false)
    const state = validatePlanRunState(readRecoveryFile(path, PLAN_RUN_MAX_BYTES))
    if (state?.sessionId !== sessionId || state.id !== runId) return null
    return state
  } catch {
    return null
  }
}

function runIdFromEntry(name: string): string | null {
  if (!name.endsWith('.json')) return null
  const runId = name.slice(0, -'.json'.length)
  return SAFE_FILENAME_FRAGMENT.test(runId) ? runId : null
}

function isUnfinished(state: PlanRunState): boolean {
  return state.status === 'running' || state.status === 'paused'
}

export function listUnfinishedPlanRuns(
  sessionId: string,
  agentDir = getPhiAgentDir()
): PlanRunState[] {
  assertSafeFragment(sessionId, 'session')
  try {
    const directory = dirname(securePlanRunPath(sessionId, 'listing', agentDir, false))
    const runIds = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => runIdFromEntry(entry.name))
      .filter((runId): runId is string => runId !== null)
      .sort()
    return runIds
      .map((runId) => readPlanRun(sessionId, runId, agentDir))
      .filter((state): state is PlanRunState => state !== null && isUnfinished(state))
  } catch {
    return []
  }
}
