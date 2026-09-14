import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'

import { getProjectByCwd } from '../projects'
import { getPhiAgentDir } from '../runtime-paths'
import type { WrapperCatalogEntry } from './catalog'
import { isEngineExecutable } from './manifest'
import type { WrapperManifest, WrapperManifestEngineProfile } from './manifest-types'
import { checkLocalResourceRequestSanity, requiresHeavyWorkloadAcknowledgement } from './policy'
import { resolveLocalInputPath } from './path-mapping'
import { buildPairedEndFastqSamplesheet } from './samplesheet'
import { validateWrapperParams } from './schema'
import {
  appendWrapperAuditEvent,
  readWrapperPlan,
  writeWrapperPlan,
  writeWrapperPlanArtifact
} from './store'
import type {
  WrapperActor,
  WrapperExecutor,
  WrapperInputResolution,
  WrapperResourceRequest,
  WrapperRunPlan
} from './types'

/** Plans go stale after this long unsubmitted — see technical design's Plan State. */
export const WRAPPER_PLAN_TTL_MS = 24 * 60 * 60 * 1000

export interface CreateWrapperRunPlanInput {
  actor: WrapperActor
  wrapper: WrapperCatalogEntry
  params: Record<string, unknown>
  /** Used to resolve relative/glob input paths. */
  cwd: string
  outputDir?: string
  agentDir?: string
}

function wrapperIdentityFromManifest(manifest: WrapperManifest): WrapperRunPlan['wrapper'] {
  const segments = manifest.id.split('/')
  return {
    canonicalId: manifest.id,
    namespace: segments.slice(0, -1).join('/'),
    shortId: manifest.shortId,
    version: manifest.version
  }
}

function defaultOutputDir(manifest: WrapperManifest): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `results/phi-wrapper/${manifest.shortId}/${stamp}`
}

function resolveLocalProfileId(manifest: WrapperManifest): {
  profileId?: string
  errors: string[]
} {
  const profile = manifest.engine.profiles.find((candidate) => candidate.id === 'local')
  if (!profile) {
    return {
      errors: [`wrapper ${manifest.id} 未声明 "local" profile，Phase 1 无法为其创建本地执行计划`]
    }
  }
  return { profileId: profile.id, errors: [] }
}

/** A manifest profile shaped like the design doc's `slurm-controller` example: `executor: remote`, `controller: sbatch`. */
function findSbatchControllerProfile(
  manifest: WrapperManifest
): WrapperManifestEngineProfile | undefined {
  return manifest.engine.profiles.find(
    (profile) => profile.executor === 'remote' && profile.controller === 'sbatch'
  )
}

/**
 * Phase 2's executor resolver — see docs/design/phi-wrapper-technical-design.md's
 * stability notes: this replaces `resolveLocalProfileId`'s role inside
 * `buildPlan`, rather than bolting remote logic onto it (that function stays
 * as-is, just becomes one branch here).
 *
 * Only the "project default" tier of the PRD's full resolver chain
 * (explicit → project default → global default → auto) exists so far:
 * there's no per-submit override or global default yet, no `wrapper.execute`
 * tool parameter for it either — a project opts in purely by configuring
 * `defaultRemoteConnectionId` + `remoteWorkspaceRoot` (see
 * `WrapperRemoteSettings.tsx`). A wrapper that hasn't declared an
 * `sbatch`-controller profile, or a project that hasn't configured remote
 * execution, both fall straight back to local — this is additive, not a
 * behavior change for any wrapper/project that doesn't opt in.
 */
function resolveExecutor(
  manifest: WrapperManifest,
  cwd: string
): { executor: WrapperExecutor; profileId?: string; errors: string[] } {
  const remoteProfile = findSbatchControllerProfile(manifest)
  if (remoteProfile) {
    const project = getProjectByCwd(cwd)
    if (project?.defaultRemoteConnectionId && project.remoteWorkspaceRoot) {
      return { executor: 'slurm-controller', profileId: remoteProfile.id, errors: [] }
    }
  }
  const { profileId, errors } = resolveLocalProfileId(manifest)
  return { executor: 'local', profileId, errors }
}

interface ResolvedInputsResult {
  inputs: WrapperInputResolution[]
  errors: string[]
  /**
   * `params`, with every input's value made execution-ready. For a local
   * plan, that means absolute: Nextflow runs with its own cwd
   * (`executor-local.ts` spawns it from the run's own directory, not
   * `cwd`) — not `input.cwd` — so whatever the user typed (often a
   * relative path) is meaningless to it verbatim. Absolute-ifying works
   * for both a single resolved file and a still-a-glob multi-file pattern
   * (Nextflow's `Channel.fromFilePairs`/`fromPath` accept an absolute glob
   * exactly like a relative one) — so, unlike an earlier version of this
   * function, every string input gets this treatment, not just single-file
   * ones. For a remote plan, values are left exactly as the user typed
   * them — see this function's own doc comment for why.
   */
  resolvedParams: Record<string, unknown>
}

/**
 * Resolves every manifest-declared input against `params`. Branches on
 * `isLocalExecution` because "resolve a path" means something different
 * for each: locally, Phi can and should check the file actually exists
 * and rewrite it to an absolute form Nextflow can use from its own run
 * directory. Remotely, none of that applies — per
 * docs/design/phi-wrapper-product-prd.md's Non-Goals ("Do not auto-sync
 * project data to remote servers", "Do not auto-download remote results"),
 * Phi never uploads local files to a remote host, so a `slurm-controller`/
 * `remote-background` input value is trusted verbatim as an absolute path
 * the user already placed on the remote host themselves. Checking it
 * against *this* machine's filesystem would either find nothing (the file
 * genuinely isn't here) or, worse, silently validate against a same-named
 * local file that has nothing to do with the remote run. `remotePaths` is
 * the `WrapperInputResolution` field the type was already shaped for this
 * (see wrapperTypes.ts) — Phase 1 just never had a remote executor to
 * populate it from.
 */
function resolveManifestInputs(
  manifest: WrapperManifest,
  params: Record<string, unknown>,
  cwd: string,
  planId: string,
  agentDir: string,
  isLocalExecution: boolean
): ResolvedInputsResult {
  const inputs: WrapperInputResolution[] = []
  const errors: string[] = []
  const resolvedParams: Record<string, unknown> = { ...params }

  for (const declaration of manifest.inputs) {
    const rawValue = params[declaration.id]
    if (rawValue === undefined) {
      if (declaration.required) errors.push(`缺少必填输入: ${declaration.id}`)
      continue
    }
    if (typeof rawValue !== 'string') {
      errors.push(`输入 "${declaration.id}" 必须是字符串路径或通配符`)
      continue
    }

    if (!isLocalExecution) {
      inputs.push({
        id: declaration.id,
        kind: 'path',
        userValue: rawValue,
        localPaths: [],
        remotePaths: [rawValue]
      })
      continue
    }

    const resolved = resolveLocalInputPath(declaration.id, rawValue, cwd)
    errors.push(...resolved.errors)
    if (!resolved.resolution) continue
    inputs.push(resolved.resolution)
    resolvedParams[declaration.id] = isAbsolute(rawValue) ? rawValue : join(cwd, rawValue)

    if (declaration.samplesheet && declaration.layout === 'paired_end') {
      const sheet = buildPairedEndFastqSamplesheet(
        resolved.resolution.localPaths,
        declaration.samplesheet.columns
      )
      errors.push(...sheet.errors)
      if (sheet.rows.length > 0) {
        writeWrapperPlanArtifact(planId, `${declaration.id}.samplesheet.csv`, sheet.csv, agentDir)
      }
    }
  }

  return { inputs, errors, resolvedParams }
}

function buildPlan(
  planId: string,
  revision: number,
  input: CreateWrapperRunPlanInput,
  agentDir: string
): WrapperRunPlan {
  const { manifest, trustTier } = input.wrapper
  const errors: string[] = []

  const paramsValidation = validateWrapperParams(manifest.parameters.schema, input.params)
  errors.push(...paramsValidation.errors)

  if (!isEngineExecutable(manifest)) {
    errors.push(
      `wrapper ${manifest.id} 使用的 engine.type "${manifest.engine.type}" 暂不支持执行，目前仅支持 nextflow`
    )
  }

  const { executor, profileId, errors: profileErrors } = resolveExecutor(manifest, input.cwd)
  errors.push(...profileErrors)

  const {
    inputs,
    errors: inputErrors,
    resolvedParams
  } = resolveManifestInputs(
    manifest,
    input.params,
    input.cwd,
    planId,
    agentDir,
    executor === 'local'
  )
  errors.push(...inputErrors)

  const resources: WrapperResourceRequest = { ...manifest.resources.defaults }
  const resourceSanity = checkLocalResourceRequestSanity(resources)
  errors.push(...resourceSanity.errors)

  const now = new Date().toISOString()
  const valid = errors.length === 0
  const profile = profileId ?? 'local'
  // The engine profile's own `nextflowProfile` (its real Nextflow
  // `-profile` name) if declared, else `profile` itself — see
  // `WrapperManifestEngineProfile.nextflowProfile`'s doc comment for why
  // these two aren't always the same string.
  const nextflowProfile =
    manifest.engine.profiles.find((candidate) => candidate.id === profile)?.nextflowProfile ??
    profile

  return {
    planId,
    revision,
    state: valid ? 'valid' : 'invalid',
    actor: input.actor,
    wrapper: wrapperIdentityFromManifest(manifest),
    wrapperName: manifest.name,
    steps: manifest.steps,
    trustTier,
    executor,
    profile,
    nextflowProfile,
    resourceClass: manifest.resourceClass,
    // Only a *local* run of a heavy/hpc wrapper needs this gate — the
    // acknowledgement text ("running locally without a remote") is simply
    // wrong once resolveExecutor already routed to slurm-controller; see
    // policy.ts's requiresHeavyWorkloadAcknowledgement doc comment.
    requiresHeavyWorkloadAcknowledgement:
      (executor === 'local' && requiresHeavyWorkloadAcknowledgement(manifest.resourceClass)) ||
      undefined,
    heavyWorkloadAcknowledged: false,
    params: resolvedParams,
    inputs,
    cwd: input.cwd,
    outputDir: input.outputDir ?? defaultOutputDir(manifest),
    resources,
    commandPlan: {
      command: `nextflow run ${manifest.engine.entrypoint} -params-file params.json -profile ${nextflowProfile}`,
      profile
    },
    validation: { valid, errors },
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.parse(now) + WRAPPER_PLAN_TTL_MS).toISOString()
  }
}

function auditPlanRequest(plan: WrapperRunPlan, agentDir: string): void {
  appendWrapperAuditEvent(
    {
      type: 'plan_requested',
      timestamp: plan.createdAt,
      actor: plan.actor,
      planId: plan.planId,
      wrapperId: plan.wrapper.canonicalId,
      wrapperVersion: plan.wrapper.version
    },
    agentDir
  )
  appendWrapperAuditEvent(
    {
      type: 'plan_validated',
      timestamp: plan.updatedAt,
      actor: plan.actor,
      planId: plan.planId,
      wrapperId: plan.wrapper.canonicalId,
      wrapperVersion: plan.wrapper.version,
      detail: { valid: plan.validation.valid, errors: plan.validation.errors }
    },
    agentDir
  )
}

/**
 * Creates and persists a new wrapper run plan. Always resolves
 * `executor: "local"` — Phase 1 has no other executor to resolve to (see
 * PRD's Execution Policy > Phase 1: Local Only). Plans can come back valid
 * or invalid; both are persisted so the caller (a chat card, a test) can
 * show validation errors instead of the plan simply not existing.
 */
export function createWrapperRunPlan(input: CreateWrapperRunPlanInput): WrapperRunPlan {
  const agentDir = input.agentDir ?? getPhiAgentDir()
  const planId = `wplan_${randomUUID()}`
  const plan = buildPlan(planId, 1, input, agentDir)
  writeWrapperPlan(plan, agentDir)
  auditPlanRequest(plan, agentDir)
  return plan
}

/**
 * Revises an existing plan with new params, keeping the same `planId` but
 * bumping `revision` — see technical design's Plan State: "Same
 * wrapper/version/executor/source with parameter changes creates a new
 * revision."
 */
export function reviseWrapperRunPlan(
  planId: string,
  params: Record<string, unknown>,
  input: Omit<CreateWrapperRunPlanInput, 'params'>
): WrapperRunPlan {
  const agentDir = input.agentDir ?? getPhiAgentDir()
  const existing = readWrapperPlan(planId, agentDir)
  if (!existing) {
    throw new Error(`计划不存在: ${planId}`)
  }
  const plan = buildPlan(planId, existing.revision + 1, { ...input, params }, agentDir)
  writeWrapperPlan(plan, agentDir)
  auditPlanRequest(plan, agentDir)
  return plan
}

export function isWrapperPlanExpired(plan: WrapperRunPlan, now: Date = new Date()): boolean {
  if (!plan.expiresAt) return false
  return Date.parse(plan.expiresAt) < now.getTime()
}
