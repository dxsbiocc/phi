/**
 * Phi workstation toolchain environment — detection snapshot and user overrides.
 * Persisted under ~/.phi/environment.json (see main/agent/environment/store.ts).
 */

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
  tools: EnvironmentToolState[]
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
