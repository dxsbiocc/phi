import type { PlanSpec } from '../../../../shared/planRunTypes'
import type { WorkMode } from '../../../../shared/sessionMode'
import { validatePlanSpec } from '../../plan/model/plan-spec'
import { planReviewContent } from '../../plan/plan-review-content'
import type { SessionRun, SessionRunnerRegistry } from '../../session/session-runner-registry'
import type { HostServiceRegistry } from '../host-service-registry'
import type { PhiTool, PhiToolResult } from '../types'
import { RPC_PLAN_DRAFT_MAX_BYTES, RPC_PLAN_DRAFT_URL } from '../phi-extension/lib/rpc-plan-draft'

interface PlanReviewToolOptions {
  readonly runtimeSessionId: string
  readonly phiSessionId: string
  readonly host: Pick<HostServiceRegistry, 'invoke'>
  currentRun(): SessionRun | undefined
  assertCurrent(): void
}

export function remotePlanModeAllowed(
  mode: WorkMode,
  planExecutionEnabled?: boolean,
  planDraftEnabled?: boolean
): boolean {
  return mode === 'plan'
    ? planDraftEnabled === true
    : mode !== 'plan_execute' || planExecutionEnabled === true
}

export function createFacadePlanReviewTools(
  mode: WorkMode,
  options: Omit<PlanReviewToolOptions, 'currentRun'> & {
    readonly runners: Pick<SessionRunnerRegistry, 'getActiveRun'>
    readonly autoPlanEnabled?: boolean
    readonly planExecutionEnabled?: boolean
    readonly planDraftEnabled?: boolean
    readonly suppressPlanTools?: boolean
    onAutoSelected?(run: SessionRun, mode: 'plan' | 'plan_execute'): void
    submittedRun(): SessionRun | undefined
  }
): PhiTool[] {
  if (options.suppressPlanTools) return []
  if (mode === 'direct' || (mode === 'auto' && !options.autoPlanEnabled)) return []
  const scoped: PlanReviewToolOptions = {
    ...options,
    currentRun: () => {
      const run = options.submittedRun()
      return run && options.runners.getActiveRun(options.phiSessionId) === run ? run : undefined
    }
  }
  if (mode === 'auto') {
    let phase: { run: SessionRun; mode: 'plan' | 'plan_execute' } | undefined
    const inPhase = (expected: 'plan' | 'plan_execute'): SessionRun | undefined => {
      const run = scoped.currentRun()
      return phase && phase.run === run && phase.mode === expected ? run : undefined
    }
    return [
      createFacadeEnterPlanModeTool(scoped, {
        planExecutionEnabled: options.planExecutionEnabled === true,
        planDraftEnabled: options.planDraftEnabled === true,
        selected: (run, selectedMode) => {
          options.onAutoSelected?.(run, selectedMode)
          phase = { run, mode: selectedMode }
        }
      }),
      createFacadePlanReviewTool({ ...scoped, currentRun: () => inPhase('plan_execute') }),
      createFacadePlanMarkdownTool({ ...scoped, currentRun: () => inPhase('plan') })
    ]
  }
  return [
    mode === 'plan_execute'
      ? createFacadePlanReviewTool(scoped)
      : createFacadePlanMarkdownTool(scoped)
  ]
}

const autoParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['execute', 'reason'],
  properties: {
    execute: { type: 'boolean' },
    reason: { type: 'string', minLength: 1, maxLength: 200 },
    soleCall: { type: 'boolean', const: true }
  }
}

export function createFacadeEnterPlanModeTool(
  options: PlanReviewToolOptions,
  phase: {
    readonly planExecutionEnabled: boolean
    readonly planDraftEnabled: boolean
    selected(run: SessionRun, mode: 'plan' | 'plan_execute'): void
  }
): PhiTool {
  return {
    name: 'enter_plan_mode',
    label: 'Enter plan mode',
    description: 'Choose a read-only planning phase. Call this tool alone.',
    parameters: autoParameters,
    site: 'host',
    approval: 'read',
    strict: true,
    loadMode: 'essential',
    async execute(toolCallId, input, _onUpdate, _context, signal) {
      const run = options.currentRun()
      const live = (): void => {
        signal?.throwIfAborted()
        options.assertCurrent()
        if (
          !run ||
          run.signal.aborted ||
          options.currentRun() !== run ||
          run.sessionId !== options.phiSessionId
        )
          throw new Error('Automatic plan mode requires the active Phi prompt run')
      }
      live()
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'execute,reason,soleCall' ||
        input.soleCall !== true ||
        typeof input.execute !== 'boolean' ||
        typeof input.reason !== 'string' ||
        !input.reason ||
        input.reason !== input.reason.trim() ||
        Array.from(input.reason).length > 200
      )
        return result('Automatic plan mode requires one signed standalone tool call.', true)
      const selectedMode = input.execute ? 'plan_execute' : 'plan'
      if (
        (input.execute && !phase.planExecutionEnabled) ||
        (!input.execute && !phase.planDraftEnabled)
      )
        return result('Remote planning capability is unavailable.', true)
      const joined = signal ? AbortSignal.any([signal, run!.signal]) : run!.signal
      const response = (await options.host.invoke(
        'workMode.selected',
        { execute: input.execute, reason: input.reason },
        {
          originSessionId: options.runtimeSessionId,
          agentRunId: run!.runId,
          toolCallId,
          signal: joined,
          remoteOriginAuthenticated: true
        }
      )) as { ok?: unknown; mode?: unknown; reason?: unknown }
      if (
        response?.ok !== true ||
        response.mode !== selectedMode ||
        response.reason !== input.reason
      )
        return result('Automatic plan mode was not confirmed.', true)
      phase.selected(run!, selectedMode)
      live()
      return result(
        selectedMode === 'plan_execute'
          ? 'Planning and execution mode is active. Investigate read-only, then submit structured steps for review.'
          : 'Plan review mode is active. Investigate read-only, then submit local://PLAN.md for review.',
        false,
        { decision: selectedMode, reason: input.reason }
      )
    }
  }
}

const markdownParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    content: { type: 'string', minLength: 1, maxLength: RPC_PLAN_DRAFT_MAX_BYTES },
    planFilePath: { type: 'string', const: RPC_PLAN_DRAFT_URL }
  }
}

/** The remote extension injects the draft bytes into the signed call before host execution. */
export function createFacadePlanMarkdownTool(options: PlanReviewToolOptions): PhiTool {
  return {
    name: 'propose_plan_markdown',
    label: 'Propose plan draft',
    description: 'Submit the session-local PLAN.md draft for user review by its title.',
    parameters: markdownParameters,
    site: 'host',
    approval: 'read',
    strict: true,
    loadMode: 'essential',
    async execute(toolCallId, input, _onUpdate, _context, signal) {
      const run = options.currentRun()
      const live = (): void => {
        signal?.throwIfAborted()
        options.assertCurrent()
        if (
          !run ||
          run.signal.aborted ||
          options.currentRun() !== run ||
          run.sessionId !== options.phiSessionId
        )
          throw new Error('Plan review requires the active Phi prompt run')
      }
      live()
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'content,planFilePath,title'
      )
        return result('Signed plan draft fields are unavailable.', true)
      const { title, content, planFilePath } = input
      if (
        typeof title !== 'string' ||
        !title ||
        title !== title.trim() ||
        Array.from(title).length > 120 ||
        [...title].some((character) => {
          const code = character.charCodeAt(0)
          return code < 32 || code === 127
        }) ||
        typeof content !== 'string' ||
        !content.trim() ||
        content.includes('\0') ||
        Buffer.byteLength(content, 'utf8') > RPC_PLAN_DRAFT_MAX_BYTES ||
        planFilePath !== RPC_PLAN_DRAFT_URL
      )
        return result('Signed plan draft is invalid.', true)
      const joined = signal ? AbortSignal.any([signal, run!.signal]) : run!.signal
      const response = (await options.host.invoke(
        'planReview.request',
        { runtimeSessionId: options.runtimeSessionId, title, planContent: content, planFilePath },
        {
          originSessionId: options.runtimeSessionId,
          agentRunId: run!.runId,
          toolCallId,
          signal: joined,
          remoteOriginAuthenticated: true,
          remotePlanPhase: 'plan'
        }
      )) as { decision: 'approve' | 'revise' | 'cancel'; note?: string }
      live()
      if (!['approve', 'revise', 'cancel'].includes(response.decision))
        return result('Plan review returned an invalid decision.', true)
      if (response.decision === 'revise')
        return result(
          `Plan refinement requested.${response.note ? ` User feedback: ${response.note}` : ''} Update local://PLAN.md and submit again.`,
          false,
          { decision: 'revise', title, planFilePath }
        )
      return result(
        response.decision === 'approve'
          ? 'Plan approved. Wait for Phi to leave plan mode before implementing.'
          : 'Plan review cancelled. Do not implement; wait for a new user request.',
        false,
        { decision: response.decision, title, planFilePath }
      )
    }
  }
}

const parameters = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'goal', 'steps'],
  properties: {
    version: { type: 'integer', const: 1 },
    goal: { type: 'string', minLength: 1 },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'instructions', 'acceptance', 'dependsOn', 'access'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z0-9-]+$' },
          title: { type: 'string', minLength: 1, maxLength: 80 },
          instructions: { type: 'string', minLength: 1, maxLength: 4000 },
          acceptance: { type: 'string', minLength: 1, maxLength: 1000 },
          dependsOn: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          access: { type: 'string', enum: ['read', 'write'] },
          writes: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          agent: { type: 'string', minLength: 1 }
        }
      }
    }
  }
} as const

function result(text: string, isError = false, details?: Record<string, unknown>): PhiToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
    ...(details ? { details } : {})
  }
}

/** Only the signed main-run host tool path can issue a remote structured review. */
export function createFacadePlanReviewTool(options: PlanReviewToolOptions): PhiTool {
  return {
    name: 'propose_plan_steps',
    label: 'Propose plan steps',
    description:
      'Submit a complete structured execution plan for user review after read-only investigation.',
    parameters,
    site: 'host',
    approval: 'read',
    strict: true,
    loadMode: 'essential',
    async execute(toolCallId, input, _onUpdate, _context, signal) {
      const run = options.currentRun()
      const live = (): void => {
        signal?.throwIfAborted()
        options.assertCurrent()
        if (
          !run ||
          run.signal.aborted ||
          options.currentRun() !== run ||
          run.sessionId !== options.phiSessionId
        )
          throw new Error('Plan review requires the active Phi prompt run')
      }
      live()
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !['version', 'goal', 'steps'].includes(key))
      )
        return result('Plan proposal contains undeclared fields.', true)
      const validated = validatePlanSpec(input)
      if (!validated.ok)
        return result(validated.errors.join('\n'), true, { validationErrors: validated.errors })
      const spec: PlanSpec = validated.spec
      const joined = signal ? AbortSignal.any([signal, run!.signal]) : run!.signal
      const response = (await options.host.invoke(
        'planReview.request',
        {
          runtimeSessionId: options.runtimeSessionId,
          title: Array.from(spec.goal).slice(0, 120).join(''),
          planContent: planReviewContent(spec),
          planFilePath: 'local://PLAN.md',
          steps: spec
        },
        {
          originSessionId: options.runtimeSessionId,
          agentRunId: run!.runId,
          toolCallId,
          signal: joined,
          remoteOriginAuthenticated: true,
          remotePlanPhase: 'plan_execute'
        }
      )) as { decision: 'approve' | 'revise' | 'cancel'; note?: string; planRunId?: string }
      live()
      if (!['approve', 'revise', 'cancel'].includes(response.decision))
        return result('Plan review returned an invalid decision.', true)
      if (
        response.decision === 'approve' &&
        (typeof response.planRunId !== 'string' ||
          !response.planRunId.trim() ||
          response.planRunId.length > 256)
      )
        return result('Approved plan has no confirmed run.', true)
      if (response.decision === 'revise')
        return result(
          `Plan refinement requested.${response.note ? ` User feedback: ${response.note}` : ''} Submit a corrected structured plan through propose_plan_steps.`,
          false,
          { decision: 'revise', plan: spec }
        )
      return result(
        response.decision === 'approve'
          ? 'Plan approved. Execution has been handed to Phi. End this turn now and do not implement any plan step yourself.'
          : 'Plan execution cancelled. Do not implement; wait for a new user request.',
        false,
        {
          decision: response.decision,
          plan: spec,
          ...(response.decision === 'approve' ? { planRunId: response.planRunId } : {})
        }
      )
    }
  }
}
