// Wrapper manifest (wrapper.yaml) shape.
//
// This models the FULL target manifest described in
// docs/design/phi-wrapper-technical-design.md (Manifest section), including
// fields that only matter once Phase 2/3 land (engine profiles beyond
// `local`/`docker`, remote permissions, registry verification). Phase 1 only
// ever *produces* a subset (see manifest.ts / fixtures/phi-ngs-fastq-qc), but
// parsing accepts the whole shape so a Phase 2/3 manifest doesn't need a
// migration.

import type { WrapperEngineType, WrapperResourceClass } from './wrapperTypes'

export interface WrapperManifestRuntime {
  minVersion: string
  maxVersion: string
}

export interface WrapperManifestSource {
  repository?: string
  ref?: string
  commit?: string
}

/**
 * Parsed as-is, never trusted as a self-report. See technical design's
 * "Trust And Registry" — trust tier is derived from install location, not
 * from this block.
 */
export interface WrapperManifestVerification {
  status?: string
  registry?: string
  manifestDigest?: string
  workflowDigest?: string
  environmentDigest?: string
}

export interface WrapperManifestEngineProfile {
  id: string
  executor: 'local' | 'remote'
  containerRuntime?: string
  scheduler?: 'slurm' | 'none'
  controller?: 'detached_ssh' | 'sbatch'
  /**
   * The literal value passed to Nextflow's `-profile` flag when this engine
   * profile is selected. Defaults to `id` when omitted — that default is
   * only correct by coincidence for a wrapper whose own `nextflow.config`
   * happens to declare a profile with the exact same name as Phi's engine
   * profile id (true for the bundled demo wrapper, e.g. `docker`/`local`,
   * but not true in general: `id` is a Phi-internal selector — see
   * `executor-local.ts`'s `requiresDocker` lookup, which depends on it
   * matching a real `engine.profiles[].id` — while a real pipeline's own
   * Nextflow profile names are whatever its `nextflow.config` declares,
   * e.g. nf-core pipelines ship `docker`/`singularity`/`conda`/`test`, never
   * a profile literally named `slurm-controller`). Set this whenever the
   * two names diverge.
   */
  nextflowProfile?: string
}

export interface WrapperManifestEngine {
  type: WrapperEngineType
  entrypoint: string
  profiles: WrapperManifestEngineProfile[]
}

export interface WrapperManifestStep {
  id: string
  label: string
  /** Ids of other declared steps this one depends on. Empty for a starting step. */
  dependsOn: string[]
}

export interface WrapperManifestEnvironmentOption {
  kind: 'container' | 'conda'
  runtime?: string
  image?: string
  file?: string
  lock?: string
  digest?: string
}

export interface WrapperManifestEnvironment {
  default: string
  options: WrapperManifestEnvironmentOption[]
}

export interface WrapperManifestInput {
  id: string
  type: string
  layout?: string
  required: boolean
  samplesheet?: {
    columns: string[]
  }
}

/** JSON Schema object — validated at runtime with ajv, not modeled field-by-field here. */
export type JsonSchema = Record<string, unknown>

export interface WrapperManifestOutput {
  id: string
  label: string
  type: string
  path: string
  primary?: boolean
}

export interface WrapperManifestSummary {
  id: string
  fromOutput: string
  kind: string
  maxRows?: number
}

export interface WrapperManifestResources {
  defaults: {
    cpus?: number
    memory?: string
    time?: string
  }
  references?: unknown[]
}

export interface WrapperManifestPermissions {
  filesystem?: {
    read?: string[]
    write?: string[]
  }
  network?: {
    default: 'disabled' | 'enabled'
    allowedDomains?: string[]
  }
  remote?: {
    allowed: boolean
  }
}

export interface WrapperManifestSmokeTest {
  params: string
  expected: Array<{ path: string; exists: boolean }>
}

export interface WrapperManifestLicense {
  wrapper: string
  tools?: Array<{ name: string; license: string }>
}

export interface WrapperManifestCitation {
  id: string
  doi?: string
}

export interface WrapperManifestDataPolicy {
  acceptedSensitivity?: string[]
  externalTransfer?: {
    default: boolean
  }
}

export interface WrapperManifest {
  phiWrapperVersion: number
  id: string
  shortId: string
  name: string
  version: string
  summary: string
  runtime: WrapperManifestRuntime
  source?: WrapperManifestSource
  verification?: WrapperManifestVerification
  registryStatus?: 'active' | 'deprecated' | 'retired' | 'blocked'
  resourceClass: WrapperResourceClass
  engine: WrapperManifestEngine
  /**
   * Optional declared workflow DAG, used by the chat plan card and the
   * Wrappers sidebar to render a `@xyflow/react` structure/live-state
   * diagram (see technical design's "Workflow Structure And Live Run
   * State"). `id` should match the corresponding Nextflow process name so
   * `-with-weblog` events can be attributed to the right step (Phase 1,
   * Milestone P1.7). Omit for a wrapper that doesn't want a detailed
   * diagram — the UI falls back to a trivial inputs → wrapper → outputs
   * graph.
   */
  steps?: WrapperManifestStep[]
  environment?: WrapperManifestEnvironment
  inputs: WrapperManifestInput[]
  parameters: {
    schema: JsonSchema
  }
  outputs: WrapperManifestOutput[]
  summaries?: WrapperManifestSummary[]
  resources: WrapperManifestResources
  permissions?: WrapperManifestPermissions
  tests?: {
    smoke?: WrapperManifestSmokeTest
  }
  license?: WrapperManifestLicense
  citations?: WrapperManifestCitation[]
  dataPolicy?: WrapperManifestDataPolicy
}

export interface ManifestParseResult {
  valid: boolean
  manifest?: WrapperManifest
  errors: string[]
}
