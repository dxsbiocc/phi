/**
 * Phi workstation toolchain environment — detection snapshot and user overrides.
 * Persisted under ~/.phi/environment.json (see main/agent/environment/store.ts).
 */

import type { EnvironmentBuildEstimate } from './environmentBuildTypes'

export const ENVIRONMENT_TOOL_IDS = [
  'micromamba',
  'nextflow',
  'docker',
  'singularity',
  'jupyter',
  'rscript'
] as const

export type EnvironmentToolId = (typeof ENVIRONMENT_TOOL_IDS)[number]

/** ready = usable active path; missing = none; invalid = custom path failed probe */
export type EnvironmentToolStatus = 'ready' | 'missing' | 'invalid'

export type EnvironmentPathSource = 'detected' | 'custom' | 'none'

export interface EnvironmentToolState {
  id: EnvironmentToolId
  label: string
  status: EnvironmentToolStatus
  /** Last successful auto-detection path (may differ from activePath if custom). */
  detectedPath?: string
  detectedVersion?: string
  /** Path Phi will use at runtime (custom wins when set and valid). */
  activePath?: string
  source: EnvironmentPathSource
  /** Short human detail (e.g. kernel counts). */
  detail?: string
  messages?: string[]
  /** Set when the active path is a host tool the user chose explicitly instead of a managed one. */
  management?: 'host-unmanaged'
}

export interface EnvironmentSnapshot {
  scannedAt: string
  /** True after the first successful scan has been written. */
  firstScanCompleted: boolean
  /** User dismissed the post-scan summary dialog. */
  summaryDismissed: boolean
  /** Legacy detection cache. New UI requirements use the explicit sections below. */
  tools: EnvironmentToolState[]
  hostDependencies: EnvironmentHostDependency[]
  hostTools: EnvironmentHostTool[]
}

export interface EnvironmentGetResult {
  snapshot: EnvironmentSnapshot
  /** Renderer should show the first-launch / post-scan summary. */
  showSummary: boolean
}

export const ENVIRONMENT_TOOL_LABELS: Record<EnvironmentToolId, string> = {
  micromamba: 'Micromamba / Mamba / Conda',
  nextflow: 'Nextflow',
  docker: 'Docker',
  singularity: 'Singularity / Apptainer',
  jupyter: 'Jupyter',
  rscript: 'Rscript'
}

export type EnvironmentHostDependencyId = 'docker' | 'singularity' | 'libreoffice'
export type EnvironmentHostDependencyStatus = 'ready' | 'missing' | 'unavailable'

export interface EnvironmentHostDependency {
  id: EnvironmentHostDependencyId
  label: string
  status: EnvironmentHostDependencyStatus
  path?: string
  version?: string
  detail?: string
  messages?: string[]
}

export interface EnvironmentHostKernel {
  id: string
  displayName: string
  language: string
  path?: string
}

export interface EnvironmentHostTool {
  id: 'nextflow' | 'jupyter'
  label: string
  status: EnvironmentToolStatus | 'not-configured'
  management: 'host-unmanaged'
  /** Host Nextflow is active only after an explicit custom-path choice. */
  selected: boolean
  path?: string
  detectedPath?: string
  version?: string
  detail?: string
  messages?: string[]
  kernels?: EnvironmentHostKernel[]
}

export type ManagedEnvironmentState = 'absent' | 'building' | 'ready' | 'failed' | 'drifted'
export type ManagedEnvironmentSource = 'official' | 'plugin' | 'project' | 'orphaned'
export type ManagedEnvironmentConsumerKind =
  'skill' | 'agent' | 'plugin' | 'wrapper' | 'notebook' | 'kernel'

export interface ManagedEnvironmentConsumer {
  kind: ManagedEnvironmentConsumerKind
  name: string
  label?: string
}

export interface ManagedEnvironmentEntry {
  ref: string
  envId: string
  state: ManagedEnvironmentState
  source: ManagedEnvironmentSource
  /** Installed plugin that owns a private `plugin:` environment. */
  pluginId?: string
  label?: string
  description?: string
  sizeBytes?: number
  estimate?: EnvironmentBuildEstimate
  referrers: string[]
  consumers: ManagedEnvironmentConsumer[]
  /** Base reference replaced by this project environment. */
  overrideFrom?: string[]
  error?: string
}

export interface ManagedEnvironmentRemoveResult {
  removed: boolean
  bytesFreed: number
}

export interface ManagedEnvironmentCleanResult {
  removed: string[]
  orphans: string[]
  skipped: Array<{ envId: string; reason: 'building' | 'locked' }>
  logsRemoved: number
  bytesFreed: number
}
