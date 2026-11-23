import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import { findWrapperCatalogEntry } from './catalog'
import type { WrapperCompositionManifest } from './composition/manifest'
import {
  getWrapperRunsDir,
  readWrapperManifestSnapshot,
  readWrapperPlan,
  readWrapperQcSummary,
  readWrapperRun,
  readWrapperRunEvents,
  readWrapperRuntimeProvenance
} from './store'
import type { WrapperManifest } from './manifest-types'
import type {
  WrapperEvent,
  WrapperRun,
  WrapperRunPlan,
  WrapperRuntimeProvenance,
  WrapperStepQcSummary
} from './types'

export type WrapperManifestSource = 'snapshot' | 'summary' | 'catalog'

export interface WrapperReproducibilityBundle {
  exportedAt: string
  run: WrapperRun
  plan?: WrapperRunPlan
  /** Frozen run-time manifest snapshot when present; falls back to summary/catalog only for legacy runs. */
  manifest?: WrapperManifest | WrapperCompositionManifest
  manifestSource?: WrapperManifestSource
  manifestSha256?: string
  nextflow?: unknown
  runtime?: WrapperRuntimeProvenance
  qc?: WrapperStepQcSummary
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

function summaryManifest(
  summary: unknown
): WrapperManifest | WrapperCompositionManifest | undefined {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return undefined
  const manifest = (summary as { manifest?: unknown }).manifest
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined
  return manifest as WrapperManifest | WrapperCompositionManifest
}

/**
 * Gathers everything persisted on disk for one run into a single exportable
 * reproducibility bundle, preferring the immutable manifest snapshot captured
 * when the run was created over the mutable installed catalog.
 */
export function buildWrapperReproducibilityBundle(
  runId: string,
  agentDir: string = getPhiAgentDir()
): WrapperReproducibilityBundle {
  const run = readWrapperRun(runId, agentDir)
  if (!run) {
    throw new Error(`Run not found: ${runId}`)
  }

  const plan = readWrapperPlan(run.planId, agentDir)
  const events = readWrapperRunEvents(runId, agentDir)
  const runDir = join(getWrapperRunsDir(agentDir), runId)
  const summary = readJsonIfExists(join(runDir, 'summary.json'))

  const snapshot = readWrapperManifestSnapshot(runId, agentDir)
  let manifest: WrapperManifest | WrapperCompositionManifest | undefined
  let manifestSource: WrapperManifestSource | undefined
  let manifestSha256: string | undefined

  if (snapshot) {
    manifest = snapshot.manifest as WrapperManifest | WrapperCompositionManifest
    manifestSource = 'snapshot'
    manifestSha256 = snapshot.sha256
  } else {
    const fromSummary = summaryManifest(summary)
    if (fromSummary) {
      manifest = fromSummary
      manifestSource = 'summary'
    } else {
      const entry = findWrapperCatalogEntry(run.wrapper.canonicalId, run.wrapper.version, agentDir)
      if (entry?.manifest) {
        manifest = entry.manifest
        manifestSource = 'catalog'
      }
    }
  }

  const nextflow = readJsonIfExists(join(runDir, 'nextflow.json'))
  const runtime = readWrapperRuntimeProvenance(runId, agentDir)
  const qc = readWrapperQcSummary(runId, agentDir)

  return {
    exportedAt: new Date().toISOString(),
    run,
    plan,
    manifest,
    ...(manifestSource ? { manifestSource } : {}),
    ...(manifestSha256 ? { manifestSha256 } : {}),
    ...(nextflow !== undefined ? { nextflow } : {}),
    ...(runtime ? { runtime } : {}),
    ...(qc ? { qc } : {}),
    events,
    params: readJsonIfExists(join(runDir, 'params.json')),
    outputs: readJsonIfExists(join(runDir, 'outputs.json')),
    summary
  }
}
