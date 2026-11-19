import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isResearchQcGated } from '../../../../shared/wrapperResearchQcTypes'
import { getWrapperRunsDir, readWrapperRun } from '../store'
import type { WrapperRun } from '../types'
import { TERMINAL_RUN_STATES, type WrapperJobStatus } from './job-types'

export const LOG_FILE = 'nextflow.log'
export const LOG_TAIL_CHARS = 4000

export function elapsedSeconds(run: WrapperRun, now = Date.now()): number {
  const start = Date.parse(run.startedAt ?? run.createdAt)
  const end = run.completedAt ? Date.parse(run.completedAt) : now
  return Math.max(0, Math.round((end - start) / 1000))
}

export function readTail(path: string, maxChars: number): string {
  try {
    const text = readFileSync(path, 'utf-8')
    return text.length > maxChars ? text.slice(-maxChars) : text
  } catch {
    return ''
  }
}

function readSummary(runsDir: string, runId: string): { missingOutputs?: string[] } {
  try {
    return JSON.parse(readFileSync(join(runsDir, runId, 'summary.json'), 'utf-8')) as {
      missingOutputs?: string[]
    }
  } catch {
    return {}
  }
}

export function remoteField(run: WrapperRun): { remote?: { host: string; runDir: string } } {
  return run.remote ? { remote: { host: run.remote.host, runDir: run.remote.runDir } } : {}
}

export function readStoredJobStatus(runId: string, agentDir: string): WrapperJobStatus | undefined {
  const run = readWrapperRun(runId, agentDir)
  if (!run) return undefined
  const runsDir = getWrapperRunsDir(agentDir)
  return {
    runId: run.runId,
    wrapperId: run.wrapper.canonicalId,
    state: run.state,
    profile: run.profile,
    ...(run.targetReason ? { targetReason: run.targetReason } : {}),
    outDir: run.outDir,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    elapsedSeconds: elapsedSeconds(run),
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    progress: run.progress ?? { started: 0 },
    logTail: isResearchQcGated(run)
      ? ''
      : readTail(join(runsDir, run.runId, LOG_FILE), LOG_TAIL_CHARS),
    ...(run.outputs ? { outputs: run.outputs } : {}),
    ...(run.researchQc ? { researchQc: run.researchQc } : {}),
    ...(run.researchQcExpected ? { researchQcExpected: true } : {}),
    ...(TERMINAL_RUN_STATES.includes(run.state)
      ? {
          missingOutputs: run.missingOutputs ?? readSummary(runsDir, run.runId).missingOutputs ?? []
        }
      : {}),
    ...remoteField(run)
  }
}
