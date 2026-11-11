import {
  KERNEL_EVENT_AGENT_RUN_FINISHED,
  KERNEL_EVENT_AGENT_RUN_REPORTED,
  KERNEL_EVENT_AGENT_RUN_STARTED,
  KERNEL_EVENT_AGENT_RUN_STEP,
  type AgentRunSnapshotDto,
  type JsonValue
} from '../../shared/kernel-protocol'
import type {
  AgentRunAdmission,
  AgentRunListener,
  AgentRunSnapshot
} from '../../main/agent/agents/registry'
import type { KernelAgentRunRuntime } from '../../main/agent/engine/in-process/kernel-services'
import { agentRunCompletions } from '../../main/agent/plan/execution/agent-run-completions'
import type { KernelProtocolCore } from '../protocol'
import { KernelAgentRunReceiptStore } from './receipt-store'

type WorkerCall = (method: string, params: unknown) => Promise<unknown>

function snapshots(value: unknown): AgentRunSnapshot[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is AgentRunSnapshot =>
          entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      )
    : []
}

export class KernelAgentRunCoordinator implements KernelAgentRunRuntime {
  private readonly receipts: KernelAgentRunReceiptStore
  private core?: KernelProtocolCore

  constructor(
    agentDir: string,
    private readonly callWorker: WorkerCall,
    private readonly diagnostic: (message: string) => void
  ) {
    this.receipts = new KernelAgentRunReceiptStore(agentDir)
  }

  bind(core: KernelProtocolCore): void {
    this.core = core
  }

  async openSession(sessionId: string, directory?: string): Promise<void> {
    await this.receipts.openSession(sessionId, directory)
  }

  admission(sessionId: string): AgentRunAdmission {
    return {
      nextRunId: () => this.receipts.nextRunId(sessionId),
      accept: (runId, input) => this.receipts.accept(sessionId, runId, input),
      started: async (runId, snapshot) => {
        await this.receipts.started(sessionId, runId, snapshot)
        const state = this.receipts.getByRun(sessionId, runId, snapshot)
        if (state) this.emit(KERNEL_EVENT_AGENT_RUN_STARTED, state, sessionId)
      },
      unknown: (runId, error) => this.receipts.unknown(sessionId, runId, error)
    }
  }

  listener(sessionId: string): AgentRunListener {
    return {
      onFinish: (run) => void this.finish(sessionId, run),
      onStep: (run, step) => {
        const state = this.receipts.getByRun(sessionId, run.id, run)
        if (state) {
          this.emit(
            KERNEL_EVENT_AGENT_RUN_STEP,
            { run: state, step: step as unknown as JsonValue },
            sessionId
          )
        }
      },
      onReported: (run) => void this.reported(sessionId, run.id)
    }
  }

  private async finish(sessionId: string, run: AgentRunSnapshot): Promise<void> {
    try {
      const state = await this.receipts.finish(sessionId, run)
      if (!state) return
      agentRunCompletions.deliver(sessionId, run)
      this.core?.cancelAgentRunInteractions(sessionId, run.id, 'agent run ended')
      this.emit(KERNEL_EVENT_AGENT_RUN_FINISHED, state, sessionId)
    } catch (error) {
      this.diagnostic(`Failed to persist agent run ${run.id}: ${String(error)}`)
    }
  }

  private async reported(sessionId: string, runId: string): Promise<void> {
    try {
      const state = await this.receipts.reported(sessionId, runId)
      if (state?.runId) {
        this.emit(
          KERNEL_EVENT_AGENT_RUN_REPORTED,
          { requestId: state.requestId, runId: state.runId },
          sessionId
        )
      }
    } catch (error) {
      this.diagnostic(`Failed to persist reported agent run ${runId}: ${String(error)}`)
    }
  }

  private emit(type: string, payload: JsonValue, sessionId: string): void {
    this.core?.emitEvent(type, payload, { sessionId })
  }

  async start(
    sessionId: string,
    input: { requestId: string; agent?: string; task: string }
  ): Promise<AgentRunSnapshotDto> {
    const started = (await this.callWorker('agentRun.start', { sessionId, ...input })) as {
      runId?: unknown
    }
    if (typeof started?.runId !== 'string') throw new Error('Agent runtime omitted runId')
    const state = this.receipts.getByRun(sessionId, started.runId)
    if (!state) throw new Error('Agent run started without a durable receipt')
    return state
  }

  async list(sessionId: string): Promise<AgentRunSnapshotDto[]> {
    const live = snapshots(await this.callWorker('agentRuns.list', { sessionId }))
    return this.receipts.list(sessionId, live)
  }

  async wait(
    sessionId: string,
    runId: string,
    timeoutMs = 120_000
  ): Promise<{ run: AgentRunSnapshotDto; timedOut: boolean }> {
    const result = (await this.callWorker('agentRuns.wait', {
      sessionId,
      runId,
      timeoutMs
    })) as { run?: AgentRunSnapshot; timedOut?: boolean }
    if (result.run && ['done', 'error', 'cancelled'].includes(result.run.state)) {
      await this.receipts.finish(sessionId, result.run)
    }
    const state = this.receipts.getByRun(sessionId, runId, result.run)
    if (!state) throw new Error(`Unknown agent run: ${runId}`)
    return { run: state, timedOut: result.timedOut === true }
  }

  async steer(sessionId: string, runId: string, message: string): Promise<{ ok: true }> {
    await this.callWorker('agentRun.steer', { sessionId, runId, message })
    return { ok: true }
  }

  async stop(sessionId: string, runId: string): Promise<{ ok: boolean }> {
    const result = (await this.callWorker('agentRun.stop', { sessionId, runId })) as {
      ok?: unknown
    }
    return { ok: result?.ok === true }
  }

  async stopAll(sessionId: string): Promise<void> {
    if (!this.receipts.hasUnfinished(sessionId)) return
    const runs = await this.list(sessionId)
    const active = runs.filter(
      (run) => run.runId && ['started', 'queued', 'running'].includes(run.state)
    )
    await Promise.all(active.map((run) => this.stop(sessionId, run.runId!)))
    const settled = await Promise.all(active.map((run) => this.wait(sessionId, run.runId!, 30_000)))
    if (settled.some((result) => result.timedOut)) {
      throw new Error('An agent run did not reach a proven terminal state after cancellation.')
    }
  }

  launchSettled(sessionId: string, requestId: string): boolean {
    return this.receipts.requestSettled(sessionId, requestId)
  }

  async hasActive(sessionId: string): Promise<boolean> {
    if (!this.receipts.hasUnfinished(sessionId)) return false
    return (await this.list(sessionId)).some((run) =>
      ['accepted', 'started', 'queued', 'running'].includes(run.state)
    )
  }

  async closeSession(sessionId: string): Promise<void> {
    agentRunCompletions.abandonSession(sessionId, 'Kernel session closed.')
    await this.receipts.closeSession(sessionId)
  }

  flush(): Promise<void> {
    return this.receipts.flush()
  }
}
