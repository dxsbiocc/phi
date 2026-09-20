import type { WrapperManifestStep } from './wrapperManifestTypes'

// Phi Wrapper core types.
//
// These types model the FULL target shape described in
// docs/design/phi-wrapper-technical-design.md (Phase 1/2/3), so later phases
// are additive rather than breaking changes. Phase 1 code only ever produces
// a subset of these values (see the per-field comments below) — the wider
// unions exist now so Phase 2/3 don't need a migration later.

/**
 * Phase 1 only produces `bundled` (shipped with the app) and `custom` (a
 * user-provided dev/local wrapper path). The remaining tiers are Phase 3
 * (signed registry) values.
 */
export type WrapperTrustTier =
  | 'bundled'
  | 'custom'
  | 'official_verified'
  | 'community_verified'
  | 'organization_verified'
  | 'compatible'
  | 'blocked'

/** Phase 1 only produces `local`. The rest arrive with Phase 2 remote execution. */
export type WrapperExecutor = 'local' | 'remote-background' | 'slurm' | 'slurm-controller'

export type WrapperResourceClass = 'light' | 'standard' | 'heavy' | 'hpc'

export type WrapperEngineType = 'nextflow' | 'snakemake' | 'cwl' | 'wdl'

export type WrapperPlanState =
  'draft' | 'validating' | 'valid' | 'invalid' | 'expired' | 'submitted' | 'cancelled'

export type WrapperRunState =
  | 'created'
  | 'validating'
  | 'provisioning'
  | 'queued'
  | 'running'
  | 'collecting'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'lost'

/** Who initiated a plan or an audit event. */
export type WrapperActor = 'user' | 'agent'

export interface WrapperIdentity {
  /** e.g. "phi/ngs/fastq-qc" */
  canonicalId: string
  /** e.g. "phi/ngs" */
  namespace: string
  /** e.g. "fastq-qc" — a UX alias only, never used as a storage key */
  shortId: string
  /** SemVer, e.g. "1.0.0" */
  version: string
}

export interface WrapperOutputDeclaration {
  id: string
  label: string
  type: string
  /** Path relative to the run's work directory */
  path: string
  primary?: boolean
}

export interface WrapperResourceRequest {
  cpus?: number
  /** e.g. "8 GB" */
  memory?: string
  /** e.g. "2h" */
  time?: string
}

export interface WrapperInputResolution {
  /** Manifest input id */
  id: string
  kind: 'path' | 'glob' | 'samplesheet'
  userValue: string
  localPaths: string[]
  /** Populated once Phase 2 remote path mapping exists; empty in Phase 1. */
  remotePaths?: string[]
  /** Populated once a container profile needs it; empty when unused. */
  containerPaths?: string[]
}

export interface WrapperCommandPlanPreview {
  /** e.g. "nextflow run wrapper/main.nf -params-file params.json -profile local" */
  command: string
  profile: string
}

/**
 * A persisted, executable plan that has not yet been submitted.
 * Independent of chat/session lifetime — see docs/design/phi-wrapper-product-prd.md
 * "Run Plan".
 */
export interface WrapperRunPlan {
  planId: string
  revision: number
  state: WrapperPlanState
  actor: WrapperActor
  wrapper: WrapperIdentity
  /** Snapshotted from the manifest at plan-creation time — the plan card's structure diagram source. */
  wrapperName: string
  /** Snapshotted from the manifest at plan-creation time; see `wrapperFlow.ts` for how it's rendered. */
  steps?: WrapperManifestStep[]
  trustTier: WrapperTrustTier
  /** Phase 1 is always "local"; the field is typed for the full union from the start. */
  executor: WrapperExecutor
  /** A Phi engine profile id (`manifest.engine.profiles[].id`) — see `nextflowProfile` for the actual Nextflow `-profile` value. */
  profile: string
  /** The literal value passed to Nextflow's `-profile` flag — see `WrapperManifestEngineProfile.nextflowProfile`'s doc comment. Optional only for backward compatibility with plans persisted before this field existed; falls back to `profile` wherever it's consumed. */
  nextflowProfile?: string
  resourceClass: WrapperResourceClass
  /** Set when resourceClass is heavy/hpc and there is no remote to redirect to (Phase 1). */
  requiresHeavyWorkloadAcknowledgement?: boolean
  heavyWorkloadAcknowledged?: boolean
  params: Record<string, unknown>
  inputs: WrapperInputResolution[]
  /** Project directory the plan was created against — `outputDir` is relative to this. */
  cwd: string
  outputDir: string
  resources: WrapperResourceRequest
  commandPlan: WrapperCommandPlanPreview
  validation: {
    valid: boolean
    errors: string[]
  }
  createdAt: string
  updatedAt: string
  /** Plan revisions become stale on a TTL or when upstream state changes. */
  expiresAt?: string
  submittedRunId?: string
}

export interface WrapperOutputRecord {
  id: string
  path: string
  exists: boolean
  bytes?: number
  primary?: boolean
  location: 'local' | 'remote'
  connectionId?: string
}

/**
 * A durable, independent object created when a validated plan is submitted.
 * Survives chat context changes and app restarts.
 */
/**
 * Per-step run state, driven by Nextflow's `-with-weblog` events (Phase 1,
 * Milestone P1.7) and matched against the manifest's declared `steps[].id`.
 * See technical design's "Workflow Structure And Live Run State".
 */
export type WrapperStepState = 'pending' | 'running' | 'completed' | 'failed'

/** How far a running wrapper has got, estimated from Nextflow's console output. */
export interface WrapperRunProgress {
  /** Distinct processes that have started so far. */
  started: number
  /** Distinct processes in the wrapper's DAG, when known. */
  total?: number
  /** The most recently started process. */
  current?: string
}

/** Where a remote run lives; what is needed to find it again, never credentials. */
export interface WrapperRunRemote {
  host: string
  /** Absolute run directory on the remote host. */
  runDir: string
  /** The saved connection and project that were used, so a restart can reconnect to the same host. */
  connectionId?: string
  projectId?: string
}

export interface WrapperRun {
  runId: string
  runName?: string
  planId: string
  revision: number
  state: WrapperRunState
  actor: WrapperActor
  wrapper: WrapperIdentity
  trustTier: WrapperTrustTier
  executor: WrapperExecutor
  profile: string
  /** Snapshotted from the plan — see `WrapperRunPlan.nextflowProfile`. */
  nextflowProfile?: string
  /** Project directory this run executes against — `outDir` is relative to this. Snapshotted from the plan. */
  cwd: string
  outDir: string
  /** Snapshotted from the plan — the executor's weblog listener matches Nextflow process names against these. */
  steps?: WrapperManifestStep[]
  originSessionId?: string
  /**
   * Set on runs started by the agent-composition layer (`wrapper_run`), which has no plan:
   * `planId` is empty and there is no `plan.json`. Absent on runs created from a plan.
   */
  origin?: 'composition'
  /** Set when the run executes on a remote host; `outDir` and output paths are then remote paths. */
  remote?: WrapperRunRemote
  /**
   * Whether Phi should wake the conversation that started this run once it ends. Only
   * `false` opts out; absent means yes (the default for runs the agent starts).
   */
  continueWhenDone?: boolean
  /** Latest known progress of a run in flight; the final value is kept once it ends. */
  progress?: WrapperRunProgress
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  exitCode?: number
  outputs?: WrapperOutputRecord[]
  /** Keyed by manifest `steps[].id`. Absent/empty when the wrapper declared no steps or nothing has run yet. */
  stepStates?: Record<string, WrapperStepState>
}

export type WrapperEventType =
  | 'plan_requested'
  | 'plan_validated'
  | 'plan_invalid'
  | 'plan_submitted'
  | 'plan_cancelled'
  | 'run_created'
  | 'run_state_changed'
  | 'run_output_collected'
  | 'run_cancel_requested'

export interface WrapperEvent {
  type: WrapperEventType
  timestamp: string
  [key: string]: unknown
}

export type WrapperAuditActionType =
  | 'plan_requested'
  | 'plan_validated'
  | 'plan_confirmation_decision'
  | 'plan_submitted'
  | 'plan_cancelled'
  | 'run_state_changed'
  | 'run_cancel_requested'
  | 'run_output_collected'
  | 'run_download_action'

export interface WrapperAuditEvent {
  type: WrapperAuditActionType
  timestamp: string
  actor: WrapperActor
  planId?: string
  runId?: string
  wrapperId?: string
  wrapperVersion?: string
  /** Digest of the resolved command plan, for reproducibility — never a secret value. */
  commandDigest?: string
  detail?: Record<string, unknown>
}
