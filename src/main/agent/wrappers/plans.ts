import { randomUUID } from 'node:crypto'

import { getPhiAgentDir } from '../runtime-paths'
import type { WrapperCatalogEntry } from './catalog'
import { isEngineExecutable } from './manifest'
import type { WrapperManifest } from './manifest-types'
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

interface ResolvedInputsResult {
  inputs: WrapperInputResolution[]
  errors: string[]
}

function resolveManifestInputs(
  manifest: WrapperManifest,
  params: Record<string, unknown>,
  cwd: string,
  planId: string,
  agentDir: string
): ResolvedInputsResult {
  const inputs: WrapperInputResolution[] = []
  const errors: string[] = []

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

    const resolved = resolveLocalInputPath(declaration.id, rawValue, cwd)
    errors.push(...resolved.errors)
    if (!resolved.resolution) continue
    inputs.push(resolved.resolution)

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

  return { inputs, errors }
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

  const { profileId, errors: profileErrors } = resolveLocalProfileId(manifest)
  errors.push(...profileErrors)

  const { inputs, errors: inputErrors } = resolveManifestInputs(
    manifest,
    input.params,
    input.cwd,
    planId,
    agentDir
  )
  errors.push(...inputErrors)

  const resources: WrapperResourceRequest = { ...manifest.resources.defaults }
  const resourceSanity = checkLocalResourceRequestSanity(resources)
  errors.push(...resourceSanity.errors)

  const now = new Date().toISOString()
  const valid = errors.length === 0
  const profile = profileId ?? 'local'

  return {
    planId,
    revision,
    state: valid ? 'valid' : 'invalid',
    actor: input.actor,
    wrapper: wrapperIdentityFromManifest(manifest),
    wrapperName: manifest.name,
    steps: manifest.steps,
    trustTier,
    executor: 'local',
    profile,
    resourceClass: manifest.resourceClass,
    requiresHeavyWorkloadAcknowledgement:
      requiresHeavyWorkloadAcknowledgement(manifest.resourceClass) || undefined,
    heavyWorkloadAcknowledged: false,
    params: input.params,
    inputs,
    cwd: input.cwd,
    outputDir: input.outputDir ?? defaultOutputDir(manifest),
    resources,
    commandPlan: {
      command: `nextflow run ${manifest.engine.entrypoint} -params-file params.json -profile ${profile}`,
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
