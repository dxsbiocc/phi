import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import { findWrapperCatalogEntry } from './catalog'
import { getWrapperRunsDir, readWrapperPlan, readWrapperRun, readWrapperRunEvents } from './store'
import type { WrapperManifest } from './manifest-types'
import type { WrapperEvent, WrapperRun, WrapperRunPlan } from './types'

export interface WrapperReproducibilityBundle {
  exportedAt: string
  run: WrapperRun
  plan?: WrapperRunPlan
  /** The manifest as currently installed — not a byte-for-byte snapshot at run time (see technical design's Audit And Reproducibility for the full target). */
  manifest?: WrapperManifest
  events: WrapperEvent[]
  params?: unknown
  outputs?: unknown
  summary?: unknown
}

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
}

/**
 * Gathers everything Phase 1 actually has on disk for one run into a single
 * exportable bundle — see technical design's "Audit And Reproducibility".
 * This is a Phase 1-honest subset of the full target (no registry snapshot,
 * no workflow/environment digest pinning beyond what the manifest itself
 * carries, no Nextflow/container runtime version capture yet): everything
 * included here is something the run/plan store or run directory already
 * has, not new data invented for the export.
 */
export function buildWrapperReproducibilityBundle(
  runId: string,
  agentDir: string = getPhiAgentDir()
): WrapperReproducibilityBundle {
  const run = readWrapperRun(runId, agentDir)
  if (!run) {
    throw new Error(`run 不存在: ${runId}`)
  }

  const plan = readWrapperPlan(run.planId, agentDir)
  const entry = findWrapperCatalogEntry(run.wrapper.canonicalId, run.wrapper.version, agentDir)
  const events = readWrapperRunEvents(runId, agentDir)
  const runDir = join(getWrapperRunsDir(agentDir), runId)

  return {
    exportedAt: new Date().toISOString(),
    run,
    plan,
    manifest: entry?.manifest,
    events,
    params: readJsonIfExists(join(runDir, 'params.json')),
    outputs: readJsonIfExists(join(runDir, 'outputs.json')),
    summary: readJsonIfExists(join(runDir, 'summary.json'))
  }
}
