import { Settings, type CreateAgentSessionResult } from '@oh-my-pi/pi-coding-agent'
import {
  estimateToolSchemaTokens,
  listPlanFiles,
  readPlanFile,
  resolveApprovedPlan
} from '../omp-internals'
import {
  applyAutoCompactionOverrides,
  createPhiSettings,
  assertRpcCompactionPolicySupported
} from './settings'
import type { ResolvedRuntimeCompactionPolicy } from '../types'
import { enterPlanReviewMode, type PlanReviewChoice } from '../../plan/plan-review-mode'
import { planReviewContent } from '../../plan/plan-review-content'
import { validatePlanSpec } from '../../plan/model/plan-spec'
import type { PlanSpec } from '../../../../shared/planRunTypes'
import {
  AutoCompactionDefaults,
  AutoCompactionOverrides,
  ContextCompactionSummary,
  ContextUsageSnapshot
} from '../../../../shared/contextUsageTypes'
import { contextUsageSnapshot, partitionMcpTools } from '../context-usage-snapshot'
import { withBrowserTextVaultCleanup } from '../../browser/browser-text-vault'
import { compactedTokensAfter } from '../events'
import { WorkerPromptOptions, isRecord, stringValue } from './common'
import { requestHost } from './ipc'
import { disconnectLeasedMcpManager } from './mcp-profile'
import { getContext, modelBySelector, runtimeThinkingLevel } from './runtime-context'
import { WorkerAgentSession, mcpUsageCache, sessions } from './state'
import { serializeSessionState } from './tool-support'

export function getSession(sessionId: unknown): CreateAgentSessionResult {
  const id = stringValue(sessionId)
  const entry = sessions.get(id)
  if (!entry) throw new Error(`Unknown session: ${id}`)
  return entry.result
}

export function promptOptions(value: unknown): WorkerPromptOptions | undefined {
  if (!isRecord(value)) return undefined
  const options: WorkerPromptOptions = {}
  if (Array.isArray(value.images)) {
    options.images = value.images as WorkerPromptOptions['images']
  }
  if (typeof value.expandPromptTemplates === 'boolean') {
    options.expandPromptTemplates = value.expandPromptTemplates
  }
  if (typeof value.synthetic === 'boolean') {
    options.synthetic = value.synthetic
  }
  if (typeof value.userInitiated === 'boolean') {
    options.userInitiated = value.userInitiated
  }
  if (typeof value.skipCompactionCheck === 'boolean') {
    options.skipCompactionCheck = value.skipCompactionCheck
  }
  return Object.keys(options).length > 0 ? options : undefined
}

export async function promptSession(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const sessionId = stringValue(record.sessionId)
  const entry = sessions.get(sessionId)
  if (!entry) throw new Error(`Unknown session: ${sessionId}`)
  const rawHostRunId = isRecord(record.options) ? stringValue(record.options.hostRunId) : ''
  const hostRunId = rawHostRunId && rawHostRunId.length <= 200 ? rawHostRunId : undefined
  entry.activeHostRunId = hostRunId
  try {
    if (entry.browserTextVault) {
      await withBrowserTextVaultCleanup(entry.browserTextVault, () =>
        entry.result.session.prompt(stringValue(record.text), promptOptions(record.options))
      )
    } else {
      await entry.result.session.prompt(stringValue(record.text), promptOptions(record.options))
    }
  } finally {
    if (entry.activeHostRunId === hostRunId) entry.activeHostRunId = undefined
  }
  return serializeSessionState(entry.result)
}

export function sessionContextUsage(params: unknown): ContextUsageSnapshot | null {
  const record = isRecord(params) ? params : {}
  const session = getSession(record.sessionId).session
  const usage = session.getContextUsage()
  try {
    const firstPrompt = session.systemPrompt[0]
    const firstSystemPromptTokens = firstPrompt?.startsWith('§ Phi Role')
      ? session.agent.tokenizer.countTokens(firstPrompt)
      : undefined
    return contextUsageSnapshot(
      usage,
      session.getContextBreakdown(),
      firstSystemPromptTokens,
      sessionMcpUsage(session)
    )
  } catch {
    return contextUsageSnapshot(usage)
  }
}

export function sessionMcpUsage(session: WorkerAgentSession): {
  directTokens: number
  deferredTokens: number
} {
  const { directTools, deferredTools } = partitionMcpTools(
    session.agent.state.tools,
    session.getSelectedMCPToolNames(),
    (name) => session.getToolByName(name)
  )
  const cached = mcpUsageCache.get(session)
  const tokenizer = session.agent.tokenizer
  if (
    cached &&
    cached.tokenizer === tokenizer &&
    cached.directTools.length === directTools.length &&
    cached.deferredTools.length === deferredTools.length &&
    directTools.every((tool, index) => tool === cached.directTools[index]) &&
    deferredTools.every((tool, index) => tool === cached.deferredTools[index])
  ) {
    return cached
  }
  const result = {
    tokenizer,
    directTools,
    deferredTools,
    directTokens: directTools.length ? estimateToolSchemaTokens(directTools, tokenizer) : 0,
    deferredTokens: deferredTools.length ? estimateToolSchemaTokens(deferredTools, tokenizer) : 0
  }
  mcpUsageCache.set(session, result)
  return result
}

export function autoCompactionOverrides(value: unknown): AutoCompactionOverrides {
  if (!isRecord(value)) return {}
  return {
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(value.thresholdPercent === 70 ||
    value.thresholdPercent === 80 ||
    value.thresholdPercent === 90
      ? { thresholdPercent: value.thresholdPercent }
      : {})
  }
}

export async function readAutoCompactionDefaults(
  params: unknown
): Promise<AutoCompactionDefaults | ResolvedRuntimeCompactionPolicy> {
  const record = isRecord(params) ? params : {}
  const settings = await Settings.loadReadOnly({
    cwd: stringValue(record.cwd, process.cwd()),
    agentDir: stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
  })
  if (record.includePolicy === true) {
    const baseline = createPhiSettings(settings).compaction.read()
    applyAutoCompactionOverrides(settings, autoCompactionOverrides(record.overrides))
    assertRpcCompactionPolicySupported(settings)
    return {
      policy: createPhiSettings(settings).compaction.read(),
      defaults: {
        enabled: baseline.enabled && baseline.methodOrder.length > 0,
        thresholdPercent: baseline.thresholdPercent,
        thresholdTokens: baseline.thresholdTokens
      }
    }
  }
  const compaction = createPhiSettings(settings).compaction.read()
  return {
    enabled: compaction.enabled && compaction.methodOrder.length > 0,
    thresholdPercent: compaction.thresholdPercent,
    thresholdTokens: compaction.thresholdTokens
  }
}

export function setSessionAutoCompactionSettings(params: unknown): AutoCompactionDefaults {
  const record = isRecord(params) ? params : {}
  const session = getSession(record.sessionId).session
  applyAutoCompactionOverrides(session.settings, autoCompactionOverrides(record.overrides))
  const compaction = createPhiSettings(session.settings).compaction.read()
  return {
    enabled: session.autoCompactionEnabled,
    thresholdPercent: compaction.thresholdPercent,
    thresholdTokens: compaction.thresholdTokens
  }
}

export async function compactSession(params: unknown): Promise<{
  summary: ContextCompactionSummary
  state: ReturnType<typeof serializeSessionState>
}> {
  const record = isRecord(params) ? params : {}
  const entry = getSession(record.sessionId)
  if (entry.session.isCompacting) throw new Error('上下文压缩正在进行')
  const result = await entry.session.compact()
  const tokensAfter = compactedTokensAfter(entry.session)
  return {
    summary: {
      summary: result.summary,
      ...(result.shortSummary ? { shortSummary: result.shortSummary } : {}),
      tokensBefore: result.tokensBefore,
      ...(tokensAfter === undefined ? {} : { tokensAfter })
    },
    state: serializeSessionState(entry)
  }
}

function unavailablePlanAgents(
  spec: PlanSpec,
  available: ReadonlyMap<string, unknown> | undefined
): string[] {
  const names = new Set(available?.keys() ?? [])
  return spec.steps.flatMap((step) => {
    const agent = step.agent ?? 'PlanStep'
    return names.has(agent) ? [] : [`step "${step.id}".agent "${agent}" is not available.`]
  })
}

function reviewTitle(goal: string): string {
  return Array.from(goal).slice(0, 120).join('')
}

async function reviewStructuredPlan(
  runtimeSessionId: string,
  input: unknown
): Promise<
  { ok: false; errors: string[] } | { ok: true; spec: PlanSpec; choice: PlanReviewChoice }
> {
  const validated = validatePlanSpec(input)
  if (!validated.ok) return validated
  const entry = sessions.get(runtimeSessionId)
  const agentErrors = unavailablePlanAgents(validated.spec, entry?.agentRunners)
  if (agentErrors.length > 0) return { ok: false, errors: agentErrors }
  const choice = (await requestHost('planReview.request', {
    runtimeSessionId,
    title: reviewTitle(validated.spec.goal),
    planContent: planReviewContent(validated.spec),
    planFilePath: 'local://PLAN.md',
    steps: validated.spec
  })) as PlanReviewChoice
  return { ok: true, spec: validated.spec, choice }
}

export async function enterSessionPlanMode(params: unknown): Promise<{ enabled: true }> {
  const record = isRecord(params) ? params : {}
  const runtimeSessionId = stringValue(record.sessionId)
  const entry = sessions.get(runtimeSessionId)
  const { session } = getSession(runtimeSessionId)
  const sessionManager = session.sessionManager
  const localProtocolOptions = {
    getArtifactsDir: () => sessionManager.getArtifactsDir(),
    getSessionId: () => sessionManager.getSessionId()
  }
  await enterPlanReviewMode(
    session,
    async (title, planFilePath) => {
      const proposal = await resolveApprovedPlan({
        suppliedTitle: title,
        statePlanFilePath: planFilePath,
        readPlan: (path) =>
          readPlanFile(path, { localProtocolOptions, cwd: sessionManager.getCwd() }),
        listPlanFiles: () => listPlanFiles({ localProtocolOptions })
      })
      return {
        title: proposal.title,
        content: proposal.planContent,
        planFilePath: proposal.planFilePath
      }
    },
    async (proposal) =>
      (await requestHost('planReview.request', {
        runtimeSessionId,
        title: proposal.title,
        planContent: proposal.content,
        planFilePath: proposal.planFilePath
      })) as PlanReviewChoice,
    {
      execute: record.execute === true,
      reviewSteps: (input) => reviewStructuredPlan(runtimeSessionId, input),
      setProposalHandler: (handler) => {
        if (!entry) return
        if (handler) entry.planStepsProposal = handler
        else delete entry.planStepsProposal
      }
    }
  )
  return { enabled: true }
}

export function listSessionShellJobs(): unknown[] {
  return [...sessions.entries()].flatMap(([agentSessionId, entry]) => {
    const manager = entry.result.session.asyncJobManager
    if (!manager) return []
    return manager.getAllJobs().flatMap((job) => {
      if (job.type !== 'bash') return []
      const output = (job.errorText || job.resultText || '').trim()
      return [
        {
          agentSessionId,
          jobId: job.id,
          state: job.queued && job.status === 'running' ? 'queued' : job.status,
          command: job.label,
          startedAt: job.startTime,
          ...(output ? { output: output.slice(-400) } : {})
        }
      ]
    })
  })
}

export function cancelSessionShellJob(params: unknown): { ok: boolean } {
  const record = isRecord(params) ? params : {}
  const entry = sessions.get(stringValue(record.sessionId))
  const jobId = stringValue(record.jobId)
  const manager = entry?.result.session.asyncJobManager
  if (!entry || !jobId || !manager) return { ok: false }
  return { ok: manager.cancel(jobId) }
}

export async function abortSession(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const sessionId = stringValue(record.sessionId)
  const entry = sessions.get(sessionId)
  if (!entry) throw new Error(`Unknown session: ${sessionId}`)
  try {
    await entry.result.session.abort()
    return serializeSessionState(entry.result)
  } finally {
    entry.browserTextVault?.clear()
  }
}

export async function disposeSession(params: unknown): Promise<void> {
  const record = isRecord(params) ? params : {}
  const sessionId = stringValue(record.sessionId)
  const result = getSession(sessionId)
  // Background runs outlive their tool call, not their conversation. Stopping them is the
  // session going away, not news, so it is not announced.
  const entry = sessions.get(sessionId)
  if (entry) entry.disposing = true
  entry?.stopAgentRunNotices?.()
  entry?.agentRuns?.stopAll()
  entry?.browserTextVault?.clear()
  sessions.delete(sessionId)
  try {
    await result.session.dispose()
  } finally {
    await disconnectLeasedMcpManager(entry?.ownedMcpManager, entry?.ownedStdioTransports)
    for (const lease of entry?.mcpLeases?.values() ?? []) lease.release()
    entry?.mcpLeases?.clear()
  }
}

export async function setSessionModel(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const result = getSession(record.sessionId)
  const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
  const ctx = await getContext(agentDir)
  const model = await modelBySelector(ctx, record.model)
  if (!model) throw new Error('Unknown model')
  await result.session.setModel(model)
  return serializeSessionState(result)
}

export async function setSessionThinkingLevel(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const result = getSession(record.sessionId)
  const level = stringValue(record.level)
  result.session.setThinkingLevel(runtimeThinkingLevel(level))
  return serializeSessionState(result)
}

export async function renameLiveSession(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const result = getSession(record.sessionId)
  await result.session.sessionManager.setSessionName(stringValue(record.name), 'user')
  return serializeSessionState(result)
}
