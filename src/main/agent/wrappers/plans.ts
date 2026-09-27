import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'

import { getProject, getProjectByCwd, type Project } from '../projects'
import { getPhiAgentDir } from '../runtime-paths'
import { findWrapperCatalogEntry, type WrapperCatalogEntry } from './catalog'
import { isEngineExecutable } from './manifest'
import type { WrapperManifest } from './manifest-types'
import { checkLocalResourceRequestSanity, requiresHeavyWorkloadAcknowledgement } from './policy'
import { resolveProjectRemoteTarget } from './remote-connection-resolver'
import type { ResolvedRemoteTarget } from './remote-connection-resolver'
import { DEFAULT_REMOTE_RUNTIME } from '../../../shared/wrapperRemoteTypes'
import { chooseWrapperTarget, type WrapperTargetDecision } from './target-policy'
import {
  parseWrapperInputReference,
  resolveLocalInputPath,
  resolveRemoteInputPath
} from './path-mapping'
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
  WrapperRunPlan,
  WrapperRetargetRequest
} from './types'

/** Plans go stale after this long unsubmitted — see technical design's Plan State. */
export const WRAPPER_PLAN_TTL_MS = 24 * 60 * 60 * 1000

export interface CreateWrapperRunPlanInput {
  actor: WrapperActor
  wrapper: WrapperCatalogEntry
  params: Record<string, unknown>
  /** Used to resolve relative/glob input paths. */
  cwd: string
  /** Stable project identity for SSH sessions whose SDK cwd is a private local anchor. */
  projectId?: string
  connectionId?: string
  explicitTarget?: 'local' | 'remote'
  selectedProfileId?: string
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

function resolvePlanTarget(
  manifest: WrapperManifest,
  input: CreateWrapperRunPlanInput,
  agentDir: string
): {
  project?: Project
  remote?: ResolvedRemoteTarget
  requestedRemote: boolean
  decision: WrapperTargetDecision
  errors: string[]
} {
  const project = input.projectId ? getProject(input.projectId) : getProjectByCwd(input.cwd)
  const errors = input.projectId && !project ? ['计划所属项目不存在'] : []
  if (
    input.projectId &&
    project?.location.kind === 'local' &&
    input.cwd !== project.location.path &&
    input.cwd !== project.location.realPath
  ) {
    errors.push('计划工作目录与所属本地项目不一致')
  }
  const location = project?.location ?? {
    kind: 'local' as const,
    path: input.cwd,
    realPath: input.cwd
  }
  const wantsRemote =
    input.explicitTarget !== 'local' &&
    (location.kind === 'ssh' ||
      input.explicitTarget === 'remote' ||
      Boolean(project?.defaultRemoteConnectionId || project?.remoteWorkspaceRoot))
  const remote =
    wantsRemote && project
      ? resolveProjectRemoteTarget(project, input.connectionId, agentDir)
      : undefined
  if (remote && 'reason' in remote) errors.push(remote.reason)
  const hostProfileId =
    remote && 'target' in remote
      ? location.kind === 'ssh'
        ? location.hostProfileId
        : project?.remoteConnections?.find((connection) => connection.id === remote.connectionId)
            ?.hostProfileId
      : undefined
  const decision = chooseWrapperTarget({
    projectLocation: location,
    explicitTarget: wantsRemote ? 'remote' : input.explicitTarget,
    selectedProfileId: input.selectedProfileId,
    resourceClass: manifest.resourceClass,
    profiles: manifest.engine.profiles,
    ...(remote && 'target' in remote && hostProfileId
      ? {
          remote: {
            hostProfileId,
            hostAlias: remote.target.connection.host,
            connectionId: remote.connectionId,
            workspaceRoot: remote.target.workspaceRoot,
            hpc: remote.target.hpc ?? { scheduler: 'local' as const }
          }
        }
      : {}),
    heavyLocalAcknowledged: true,
    deferDoctorToExecution: true
  })
  if (decision.kind === 'blocked') errors.push(decision.reason)
  return {
    project,
    remote: remote && 'target' in remote ? remote : undefined,
    requestedRemote: wantsRemote,
    decision,
    errors
  }
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
  isLocalExecution: boolean,
  project?: Project,
  connectionId?: string
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
    if (!isLocalExecution) {
      const mapping = project?.remoteConnections?.find(
        (connection) => connection.id === connectionId
      )?.inputPathMapping
      const resolved = resolveRemoteInputPath(declaration.id, rawValue, {
        projectLocation: project?.location,
        mapping
      })
      errors.push(...resolved.errors)
      if (resolved.resolution) {
        inputs.push(resolved.resolution)
        resolvedParams[declaration.id] = resolved.resolution.remotePaths?.[0]
      }
      continue
    }

    const parsed = parseWrapperInputReference(declaration.id, rawValue, 'local')
    errors.push(...parsed.errors)
    if (!parsed.reference) continue
    if (parsed.reference.source !== 'local') {
      errors.push(`本机运行的输入 "${declaration.id}" 不能引用服务器文件`)
      continue
    }
    const localValue = parsed.reference.path
    const resolved = resolveLocalInputPath(declaration.id, localValue, cwd)
    errors.push(...resolved.errors)
    if (!resolved.resolution) continue
    inputs.push(resolved.resolution)
    resolvedParams[declaration.id] = isAbsolute(localValue) ? localValue : join(cwd, localValue)

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

  if (!isEngineExecutable(manifest)) {
    errors.push(
      `wrapper ${manifest.id} 使用的 engine.type "${manifest.engine.type}" 暂不支持执行，目前仅支持 nextflow`
    )
  }

  const selection = resolvePlanTarget(manifest, input, agentDir)
  errors.push(...selection.errors)
  const { decision } = selection
  const executor: WrapperExecutor =
    decision.kind === 'selected'
      ? decision.executor
      : selection.requestedRemote || selection.project?.location.kind === 'ssh'
        ? 'remote-background'
        : 'local'
  const profileId = decision.kind === 'selected' ? decision.profileId : undefined
  const planCwd =
    selection.project?.location.kind === 'ssh'
      ? selection.project.location.canonicalRoot
      : input.cwd

  const {
    inputs,
    errors: inputErrors,
    resolvedParams
  } = resolveManifestInputs(
    manifest,
    input.params,
    planCwd,
    planId,
    agentDir,
    executor === 'local',
    selection.project,
    selection.remote?.connectionId
  )
  errors.push(...inputErrors)
  const paramsValidation = validateWrapperParams(manifest.parameters.schema, resolvedParams)
  errors.push(...paramsValidation.errors)

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
    // wrong once target selection has routed the plan to a remote executor; see
    // policy.ts's requiresHeavyWorkloadAcknowledgement doc comment.
    ...(selection.project && decision.kind === 'selected'
      ? {
          targetSelection: {
            projectId: selection.project.id,
            projectLocation: selection.project.location,
            target: decision.target,
            reason: decision.reason,
            ...(decision.target === 'remote'
              ? {
                  hostProfileId: decision.hostProfileId,
                  hostAlias: decision.hostAlias,
                  connectionId: decision.connectionId,
                  remoteRoot: decision.remoteRoot,
                  scheduler: selection.remote?.target.hpc?.scheduler ?? 'local',
                  controller: selection.remote?.target.hpc?.controller ?? 'login',
                  runtime: selection.remote?.target.hpc?.runtime ?? DEFAULT_REMOTE_RUNTIME,
                  environmentCheckPending: decision.environmentCheckPending ?? false
                }
              : {})
          }
        }
      : {}),
    requiresHeavyWorkloadAcknowledgement:
      (executor === 'local' && requiresHeavyWorkloadAcknowledgement(manifest.resourceClass)) ||
      undefined,
    heavyWorkloadAcknowledged: false,
    params: resolvedParams,
    inputs,
    cwd: planCwd,
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
 * Creates and persists a new wrapper run plan. The project identity and chosen
 * host are snapshotted here; submit revalidates them before starting anything.
 * Invalid plans are also persisted so callers can show precise errors.
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
  const saved = existing.targetSelection
  if (
    saved &&
    ((input.projectId && input.projectId !== saved.projectId) ||
      (input.explicitTarget && input.explicitTarget !== saved.target) ||
      (input.selectedProfileId && input.selectedProfileId !== existing.profile) ||
      (input.connectionId && input.connectionId !== saved.connectionId))
  ) {
    throw new Error('修改执行项目、主机或 Profile 需要创建新计划。')
  }
  let plan = buildPlan(
    planId,
    existing.revision + 1,
    {
      ...input,
      params,
      ...(saved
        ? {
            projectId: saved.projectId,
            explicitTarget: saved.target,
            connectionId: saved.connectionId,
            selectedProfileId: existing.profile
          }
        : {})
    },
    agentDir
  )
  if (saved) {
    const next = plan.targetSelection
    if (
      !next ||
      plan.executor !== existing.executor ||
      next.projectId !== saved.projectId ||
      next.target !== saved.target ||
      next.hostProfileId !== saved.hostProfileId ||
      next.hostAlias !== saved.hostAlias ||
      next.connectionId !== saved.connectionId ||
      next.remoteRoot !== saved.remoteRoot
    ) {
      throw new Error('项目或服务器配置已变化，请重新创建 Wrapper 计划。')
    }
    if (existing.targetChangeConfirmation) {
      plan = { ...plan, targetChangeConfirmation: existing.targetChangeConfirmation }
    }
  }
  writeWrapperPlan(plan, agentDir)
  auditPlanRequest(plan, agentDir)
  return plan
}

/** A target change is a revalidated plan revision, never a mutable submit-time override. */
export function retargetWrapperRunPlan(
  request: WrapperRetargetRequest,
  agentDir = getPhiAgentDir()
): WrapperRunPlan {
  const existing = readWrapperPlan(request.planId, agentDir)
  if (!existing) throw new Error(`计划不存在: ${request.planId}`)
  if (!['draft', 'valid', 'invalid'].includes(existing.state) || isWrapperPlanExpired(existing)) {
    throw new Error('计划已提交、取消或过期，请创建新计划。')
  }
  if (existing.revision !== request.expectedRevision) {
    throw new Error('计划已更新，请重新查看后再选择执行目标。')
  }
  const saved = existing.targetSelection
  if (!saved || saved.projectLocation.kind !== 'local') {
    throw new Error('只有本地项目的计划可以调整执行目标。')
  }
  const project = getProject(saved.projectId)
  if (
    project?.location.kind !== 'local' ||
    project.location.path !== saved.projectLocation.path ||
    project.location.realPath !== saved.projectLocation.realPath
  ) {
    throw new Error('项目目录已变化，请重新创建计划。')
  }
  if (saved.target === request.target) return existing
  if (saved.target === 'remote' && !request.confirmedLocalFallback) {
    throw new Error('改为本机运行需要明确确认本机资源与输入数据。')
  }
  if (saved.target === 'local' && existing.inputs.some((input) => input.localPaths.length > 0)) {
    throw new Error('改为远程运行需重新创建计划并填写服务器上的输入路径。')
  }
  const wrapper = findWrapperCatalogEntry(
    existing.wrapper.canonicalId,
    existing.wrapper.version,
    agentDir
  )
  if (!wrapper) throw new Error('计划对应的 Wrapper 已不可用，请重新创建计划。')
  const retargetParams: Record<string, unknown> = { ...existing.params }
  if (request.target === 'local') {
    for (const input of existing.inputs) {
      retargetParams[input.id] = { source: 'local', path: input.userValue }
    }
  }
  const candidate = buildPlan(
    existing.planId,
    existing.revision + 1,
    {
      actor: existing.actor,
      wrapper,
      params: retargetParams,
      cwd: saved.projectLocation.path,
      projectId: saved.projectId,
      explicitTarget: request.target,
      outputDir: existing.outputDir,
      agentDir
    },
    agentDir
  )
  if (!candidate.validation.valid || candidate.targetSelection?.target !== request.target) {
    throw new Error(`目标变更未通过校验：${candidate.validation.errors.join('；')}`)
  }
  const confirmedAt = new Date().toISOString()
  const revised: WrapperRunPlan =
    saved.target === 'remote'
      ? {
          ...candidate,
          targetSelection: {
            ...candidate.targetSelection,
            reason: `用户确认改在本机运行；${candidate.targetSelection.reason}`
          },
          targetChangeConfirmation: {
            from: 'remote',
            to: 'local',
            fromRevision: existing.revision,
            confirmedAt
          }
        }
      : candidate
  writeWrapperPlan(revised, agentDir)
  appendWrapperAuditEvent(
    {
      type: 'plan_confirmation_decision',
      timestamp: confirmedAt,
      actor: 'user',
      planId: existing.planId,
      wrapperId: existing.wrapper.canonicalId,
      wrapperVersion: existing.wrapper.version,
      detail: {
        decision: 'target_changed',
        from: saved.target,
        to: request.target,
        confirmedLocalFallback: request.confirmedLocalFallback === true,
        fromRevision: existing.revision,
        revision: revised.revision
      }
    },
    agentDir
  )
  return revised
}

export function isWrapperPlanExpired(plan: WrapperRunPlan, now: Date = new Date()): boolean {
  if (!plan.expiresAt) return false
  return Date.parse(plan.expiresAt) < now.getTime()
}
