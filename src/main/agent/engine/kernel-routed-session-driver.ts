import { randomUUID } from 'node:crypto'

import type { JsonValue } from '../../../shared/kernel-protocol'
import type { PlanRunReplanRequest, PlanRunState } from '../../../shared/planRunTypes'
import type { RoutedPlanRunOperations, RoutedSessionDriver } from './session-routing-engine'
import type {
  RuntimeModel,
  RuntimeSelectionControl,
  ThinkingLevel,
  WorkerSessionState
} from './types'
import { KernelClientError } from './kernel-client'
import type { KernelSessionFactory } from './kernel-session-factory'
import type { KernelExecutionHost } from './kernel-execution-host'
import {
  KernelEngineError,
  engineError,
  jsonSafeResourceSnapshot,
  promptWireOptions,
  record,
  stateFromKernel,
  stringValue,
  type KernelSessionClient,
  type RunCompletion,
  type SessionBinding
} from './kernel-session-support'

export class KernelRoutedSessionDriver implements RoutedSessionDriver {
  private interrupted?: Error

  constructor(
    private readonly factory: KernelSessionFactory,
    private readonly host: KernelExecutionHost,
    private readonly binding: SessionBinding
  ) {}

  get isLive(): boolean {
    return !this.binding.disposed && !this.interrupted
  }

  interruption(): Error | undefined {
    return this.interrupted
  }

  interrupt(error: Error): void {
    this.interrupted = error
  }

  state(): WorkerSessionState {
    return structuredClone(this.binding.state)
  }

  hasActiveAgentRuns(): boolean {
    return this.binding.activeAgentRuns > 0
  }

  async prompt(text: string, raw?: Record<string, unknown>): Promise<WorkerSessionState> {
    const clientRunKey = stringValue(raw?.hostRunId) ?? randomUUID()
    const payload: Record<string, JsonValue> = {
      text,
      options: promptWireOptions(raw),
      clientRunKey,
      ...(typeof raw?.synthetic === 'boolean' ? { synthetic: raw.synthetic } : {}),
      ...(typeof raw?.userInitiated === 'boolean' ? { userInitiated: raw.userInitiated } : {})
    }
    const { runId, knownStatus } = await this.acceptPrompt(payload)
    const completion = knownStatus ? { status: knownStatus } : await this.host.waitForRun(runId)
    if (completion.status === 'failed' || completion.status === 'unknown') {
      throw new KernelEngineError(
        'INTERNAL',
        completion.detail ?? `Kernel run ended with ${completion.status}.`
      )
    }
    return this.refreshState()
  }

  private async acceptPrompt(
    payload: Record<string, JsonValue>
  ): Promise<{ runId: string; knownStatus?: RunCompletion['status'] }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = await this.client()
      try {
        const result = record(
          await client.request('session.prompt', payload, {
            sessionId: this.binding.kernelSessionId
          })
        )
        const runId = stringValue(result?.runId)
        if (runId) return { runId }
      } catch (error) {
        const duplicate = this.duplicateRun(error)
        if (duplicate) return duplicate
        if (attempt === 0 && !this.host.isCurrent(client)) continue
        throw engineError(error)
      }
    }
    throw new Error('Kernel prompt did not return a run identifier.')
  }

  private duplicateRun(
    error: unknown
  ): { runId: string; knownStatus?: RunCompletion['status'] } | undefined {
    if (!(error instanceof KernelClientError) || error.code !== 'DUPLICATE_REQUEST')
      return undefined
    const detail = record(error.detail)
    const runId = stringValue(detail?.runId)
    if (!runId) return undefined
    const status = stringValue(detail?.status)
    return status && status !== 'running'
      ? { runId, knownStatus: status as RunCompletion['status'] }
      : { runId }
  }

  async contextUsage(): Promise<
    import('../../../shared/contextUsageTypes').ContextUsageSnapshot | null
  > {
    return (await this.request('session.contextUsage', {})) as
      import('../../../shared/contextUsageTypes').ContextUsageSnapshot | null
  }

  async rename(_name: string, control?: RuntimeSelectionControl): Promise<WorkerSessionState> {
    control?.assertCurrent()
    return this.state()
  }

  async setModel(
    model: RuntimeModel,
    control?: RuntimeSelectionControl
  ): Promise<WorkerSessionState> {
    control?.assertCurrent()
    const result = await this.request('session.setModel', {
      model: { provider: model.provider, id: model.id }
    })
    control?.assertCurrent()
    this.binding.model = structuredClone(model)
    return this.applyState(result)
  }

  async setThinkingLevel(
    level: ThinkingLevel | undefined,
    control?: RuntimeSelectionControl
  ): Promise<WorkerSessionState> {
    control?.assertCurrent()
    if (!level) return this.state()
    const result = await this.request('session.setThinkingLevel', { level })
    control?.assertCurrent()
    return this.applyState(result)
  }

  async autoCompactionSettings(
    control?: RuntimeSelectionControl
  ): Promise<import('./types').RuntimeAutoCompactionReceipt> {
    control?.assertCurrent()
    return (await this.request(
      'session.getAutoCompaction',
      {}
    )) as unknown as import('./types').RuntimeAutoCompactionReceipt
  }

  async setAutoCompactionSettings(
    overrides: import('../../../shared/contextUsageTypes').AutoCompactionOverrides,
    control?: RuntimeSelectionControl
  ): Promise<import('../../../shared/contextUsageTypes').AutoCompactionDefaults> {
    control?.assertCurrent()
    return (await this.request(
      'session.setAutoCompaction',
      jsonSafeResourceSnapshot(overrides) as JsonValue
    )) as unknown as import('../../../shared/contextUsageTypes').AutoCompactionDefaults
  }

  async compact(control?: RuntimeSelectionControl): Promise<{
    summary: import('../../../shared/contextUsageTypes').ContextCompactionSummary
    state: WorkerSessionState
  }> {
    control?.assertCurrent()
    const result = record(await this.request('session.compact', {}))
    if (!result) throw new TypeError('Kernel returned an invalid compaction result.')
    return {
      summary:
        result.summary as unknown as import('../../../shared/contextUsageTypes').ContextCompactionSummary,
      state: this.applyState(result.state)
    }
  }

  async enterPlanMode(execute?: boolean): Promise<unknown> {
    return this.request('session.plan.enter', execute === undefined ? {} : { execute })
  }

  async cancelPlanMode(replanRequestId?: string): Promise<boolean> {
    const result = record(
      await this.request('session.plan.cancel', replanRequestId ? { replanRequestId } : {})
    )
    return result?.cancelled === true
  }

  readonly agentRuns = {
    start: async (params: { agent?: string; task: string; requestId: string }) => {
      const result = record(
        await this.request('agentRuns.start', {
          requestId: params.requestId,
          ...(params.agent ? { agent: params.agent } : {}),
          task: params.task
        })
      )
      const runId = stringValue(result?.runId)
      if (!runId) throw new TypeError('Kernel agent run omitted its runId.')
      return { runId }
    },
    list: async (): Promise<readonly Record<string, unknown>[]> => {
      const result = await this.request('agentRuns.list', {})
      return Array.isArray(result) ? (structuredClone(result) as Record<string, unknown>[]) : []
    },
    resourceOwner: (runId: string) => ({ toolOwner: runId, allowedSkills: [] as string[] }),
    steer: async (runId: string, message: string): Promise<void> => {
      await this.request('agentRuns.steer', { runId, message })
    },
    stop: (runId: string): Promise<unknown> => this.request('agentRuns.stop', { runId }),
    wait: async (options: {
      ids?: readonly string[]
      mode?: 'all' | 'any'
      timeoutMs?: number
      signal?: AbortSignal
    }): Promise<unknown> => {
      const ids = options.ids ?? []
      if (ids.length === 0) return []
      options.signal?.throwIfAborted()
      const wait = (runId: string): Promise<JsonValue> =>
        this.request('agentRuns.wait', {
          runId,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
        })
      return options.mode === 'any' ? Promise.race(ids.map(wait)) : Promise.all(ids.map(wait))
    }
  }

  readonly planRuns: RoutedPlanRunOperations = {
    list: async (): Promise<PlanRunState[]> =>
      (await this.request('planRuns.list', {})) as unknown as PlanRunState[],
    get: async (runId: string): Promise<PlanRunState | null> =>
      (await this.request('planRuns.get', { runId })) as unknown as PlanRunState | null,
    stop: async (runId: string): Promise<PlanRunState> =>
      (await this.request('planRuns.stop', { runId })) as unknown as PlanRunState,
    retryStep: async (runId: string, stepId: string): Promise<PlanRunState> =>
      (await this.request('planRuns.retryStep', { runId, stepId })) as unknown as PlanRunState,
    skipStep: async (runId: string, stepId: string): Promise<PlanRunState> =>
      (await this.request('planRuns.skipStep', { runId, stepId })) as unknown as PlanRunState,
    requestReplan: async (runId: string): Promise<PlanRunReplanRequest> =>
      (await this.request('planRuns.replan', { runId })) as unknown as PlanRunReplanRequest,
    cancelReplan: (requestId: string): Promise<boolean> => this.cancelPlanMode(requestId)
  }

  readonly shellJobs = {
    list: async (): Promise<readonly Record<string, unknown>[]> => {
      const result = await this.request('shellJobs.list', {})
      return Array.isArray(result) ? (structuredClone(result) as Record<string, unknown>[]) : []
    },
    cancel: async (jobId: string): Promise<{ ok?: boolean }> => {
      const result = record(await this.request('shellJobs.cancel', { jobId }))
      return { ok: result?.ok === true }
    }
  }

  async respondToolApproval(requestId: string, result: unknown): Promise<void> {
    const blocked =
      result && typeof result === 'object' && (result as { block?: unknown }).block === true
    const reason =
      blocked && typeof (result as { reason?: unknown }).reason === 'string'
        ? (result as { reason: string }).reason
        : undefined
    try {
      await this.request('approval.respond', {
        approvalId: requestId,
        decision: blocked ? 'denied' : 'approved',
        ...(reason ? { reason } : {})
      })
    } catch (error) {
      if (error instanceof KernelEngineError && error.code === 'CANCELLED') return
      throw error
    }
  }

  async abort(): Promise<WorkerSessionState> {
    await this.request('session.abort', {})
    return this.refreshState()
  }

  async dispose(): Promise<void> {
    if (this.binding.disposed) return
    this.binding.disposed = true
    try {
      await this.request('session.close', {})
    } finally {
      this.factory.removeBinding(this.binding)
    }
  }

  private async client(): Promise<KernelSessionClient> {
    if (this.interrupted) throw this.interrupted
    return this.host.client(this.binding.params, new AbortController().signal)
  }

  private async request(method: string, params: JsonValue): Promise<JsonValue> {
    try {
      return await (
        await this.client()
      ).request(method, params, {
        sessionId: this.binding.kernelSessionId
      })
    } catch (error) {
      throw engineError(error)
    }
  }

  private async refreshState(): Promise<WorkerSessionState> {
    return this.applyState(await this.request('session.snapshot', {}))
  }

  private applyState(value: unknown): WorkerSessionState {
    const state = stateFromKernel(value, this.binding)
    this.binding.state = state
    this.binding.sink.state(structuredClone(state))
    return structuredClone(state)
  }
}
