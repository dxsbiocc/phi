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

export type WrapperReproducibilityEvidenceItem =
  | 'manifest_snapshot'
  | 'params'
  | 'outputs'
  | 'host_provenance'
  | 'nextflow_provenance'
  | 'container_digests'
  | 'qc_summary'

export interface WrapperReproducibilityMissingItem {
  item: WrapperReproducibilityEvidenceItem
  reason: string
}

export interface WrapperReproducibilityCompleteness {
  complete: boolean
  present: WrapperReproducibilityEvidenceItem[]
  missing: WrapperReproducibilityMissingItem[]
}

export interface WrapperReproducibilityRerunGuide {
  wrapperId: string
  wrapperVersion: string
  executor: WrapperRun['executor']
  profile: string
  nextflowProfile: string
  cwd: string
  outDir: string
  commandHint?: string
  nextflowVersion?: string
  nextflowEnvId?: string
  nextflowLockSha256?: string
  containerEngine?: string
  pinnedImages: Array<{ ref: string; digest?: string; status: 'verified' | 'unknown' }>
  notes: string[]
}

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
  /** Honest audit of which reproducibility evidence items are present vs. missing. */
  completeness: WrapperReproducibilityCompleteness
  /** Deterministic summary for independently reproducing this run. */
  rerunGuide: WrapperReproducibilityRerunGuide
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

function evaluateBundleCompleteness(input: {
  run: WrapperRun
  manifestSource?: WrapperManifestSource
  manifestSha256?: string
  params: unknown
  outputs: unknown
  nextflow: unknown
  runtime?: WrapperRuntimeProvenance
  qc?: WrapperStepQcSummary
}): WrapperReproducibilityCompleteness {
  const present: WrapperReproducibilityEvidenceItem[] = []
  const missing: WrapperReproducibilityMissingItem[] = []

  if (input.manifestSource === 'snapshot' && input.manifestSha256) {
    present.push('manifest_snapshot')
  } else {
    missing.push({
      item: 'manifest_snapshot',
      reason: input.manifestSource
        ? `Manifest came from mutable ${input.manifestSource} rather than an immutable snapshot.`
        : 'Immutable manifest snapshot (manifest.snapshot.json) was not recorded.'
    })
  }

  if (input.params !== undefined) {
    present.push('params')
  } else {
    missing.push({ item: 'params', reason: 'Run parameters (params.json) were not recorded.' })
  }

  if (input.outputs !== undefined || (input.run.outputs?.length ?? 0) > 0) {
    present.push('outputs')
  } else {
    missing.push({ item: 'outputs', reason: 'Run output inventory was not recorded.' })
  }

  if (input.runtime?.host.platform && input.runtime?.host.arch) {
    present.push('host_provenance')
  } else {
    missing.push({
      item: 'host_provenance',
      reason: 'Host OS/architecture provenance (runtime.json) was not recorded.'
    })
  }

  if (
    input.runtime?.nextflow.version ||
    input.runtime?.nextflow.lockSha256 ||
    input.nextflow !== undefined
  ) {
    present.push('nextflow_provenance')
  } else {
    missing.push({
      item: 'nextflow_provenance',
      reason: 'Nextflow version or managed lock provenance was not recorded.'
    })
  }

  const images = input.runtime?.containerRuntime?.images ?? []
  if (images.length > 0) {
    const unverified = images.filter((img) => img.status !== 'verified' || !img.digest)
    if (unverified.length === 0) {
      present.push('container_digests')
    } else {
      missing.push({
        item: 'container_digests',
        reason: `Unverified container image digests: ${unverified.map((img) => img.ref).join(', ')}.`
      })
    }
  } else if (input.runtime?.containerRuntime?.engine === 'conda') {
    present.push('container_digests')
  } else {
    missing.push({
      item: 'container_digests',
      reason: 'Container image digest provenance was not recorded.'
    })
  }

  if ((input.qc?.entries.length ?? 0) > 0) {
    present.push('qc_summary')
  } else {
    missing.push({
      item: 'qc_summary',
      reason: 'Structured QC summary (qc.json) was not recorded.'
    })
  }

  return {
    complete: missing.length === 0,
    present,
    missing
  }
}

function buildRerunGuide(input: {
  run: WrapperRun
  plan?: WrapperRunPlan
  manifestSource?: WrapperManifestSource
  runtime?: WrapperRuntimeProvenance
  completeness: WrapperReproducibilityCompleteness
}): WrapperReproducibilityRerunGuide {
  const images = input.runtime?.containerRuntime?.images ?? []
  const notes: string[] = []
  if (input.manifestSource !== 'snapshot') {
    notes.push('Manifest was not frozen at submission time; verify wrapper version before rerunning.')
  }
  if (input.run.remote) {
    notes.push(`Originally executed on remote host "${input.run.remote.host}" in ${input.run.remote.runDir}.`)
  }
  if (images.some((img) => img.status !== 'verified' || !img.digest)) {
    notes.push('One or more container images lack a verified digest; pin image digests for strict bit-for-bit reproduction.')
  }
  if (!input.completeness.complete) {
    notes.push(
      `Missing reproducibility items: ${input.completeness.missing.map((m) => m.item).join(', ')}.`
    )
  }

  return {
    wrapperId: input.run.wrapper.canonicalId,
    wrapperVersion: input.run.wrapper.version,
    executor: input.run.executor,
    profile: input.run.profile,
    nextflowProfile: input.run.nextflowProfile ?? input.run.profile,
    cwd: input.run.cwd,
    outDir: input.run.outDir,
    ...(input.plan?.commandPlan.command ? { commandHint: input.plan.commandPlan.command } : {}),
    ...(input.runtime?.nextflow.version ? { nextflowVersion: input.runtime.nextflow.version } : {}),
    ...(input.runtime?.nextflow.envId ? { nextflowEnvId: input.runtime.nextflow.envId } : {}),
    ...(input.runtime?.nextflow.lockSha256
      ? { nextflowLockSha256: input.runtime.nextflow.lockSha256 }
      : {}),
    ...(input.runtime?.containerRuntime?.engine
      ? { containerEngine: input.runtime.containerRuntime.engine }
      : {}),
    pinnedImages: images.map((img) => ({
      ref: img.ref,
      ...(img.digest ? { digest: img.digest } : {}),
      status: img.status
    })),
    notes
  }
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
  const params = readJsonIfExists(join(runDir, 'params.json'))
  const outputs = readJsonIfExists(join(runDir, 'outputs.json'))

  const completeness = evaluateBundleCompleteness({
    run,
    manifestSource,
    manifestSha256,
    params,
    outputs,
    nextflow,
    runtime,
    qc
  })
  const rerunGuide = buildRerunGuide({
    run,
    plan,
    manifestSource,
    runtime,
    completeness
  })

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
    params,
    outputs,
    summary,
    completeness,
    rerunGuide
  }
}
