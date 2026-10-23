import { parseAgentReport, type AgentReport } from '../../agents/report'
import type { AgentRunCompletion, AgentRunCompletions } from './agent-run-completions'
import type { StepOutcome, StepRunHandle, StepRunner, StepRunnerStartInput } from './step-runner'

interface EngineAgentRuns {
  start(params: { sessionId: string; agent?: string; task: string }): Promise<{ runId: string }>
  stop(params: { sessionId: string; runId: string }): Promise<unknown>
}

export interface EngineStepRunnerDependencies {
  engine: { agentRuns: EngineAgentRuns }
  completions: Pick<AgentRunCompletions, 'expect'>
  resolveRuntimeSessionId(phiSessionId: string): string | null
}

function completionReport(run: AgentRunCompletion): AgentReport {
  const parsed = parseAgentReport(run.report ?? '')
  return {
    ...parsed,
    ...(run.reportStatus ? { status: run.reportStatus } : {}),
    ...(run.missingInputs ? { missingInputs: [...run.missingInputs] } : {})
  }
}

function completionOutcome(run: AgentRunCompletion): StepOutcome {
  if (run.state === 'done') return { ok: true, report: completionReport(run) }
  return {
    ok: false,
    error: run.error ?? `Agent run ${run.id} ended with state ${run.state}.`
  }
}

function isFinishedStopError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /already finished|no longer running|Unknown run/i.test(message)
}

class EngineStepRunner implements StepRunner {
  constructor(private readonly deps: EngineStepRunnerDependencies) {}

  private runtimeSessionId(phiSessionId: string): string {
    const runtimeSessionId = this.deps.resolveRuntimeSessionId(phiSessionId)
    if (!runtimeSessionId)
      throw new Error(`No runtime session found for Phi session ${phiSessionId}.`)
    return runtimeSessionId
  }

  private async stopRuntimeRun(runtimeSessionId: string, runId: string): Promise<void> {
    try {
      await this.deps.engine.agentRuns.stop({ sessionId: runtimeSessionId, runId })
    } catch (error) {
      if (!isFinishedStopError(error)) throw error
    }
  }

  async start(input: StepRunnerStartInput): Promise<StepRunHandle> {
    const runtimeSessionId = this.runtimeSessionId(input.sessionId)
    const { runId } = await this.deps.engine.agentRuns.start({
      sessionId: runtimeSessionId,
      ...(input.agent ? { agent: input.agent } : {}),
      task: input.task
    })
    const stop = (): void => {
      void this.stopRuntimeRun(runtimeSessionId, runId).catch(() => undefined)
    }
    if (input.signal.aborted) stop()
    else input.signal.addEventListener('abort', stop, { once: true })
    const done = this.deps.completions
      .expect(runtimeSessionId, runId)
      .then(completionOutcome)
      .finally(() => input.signal.removeEventListener('abort', stop))
    return { runId, done }
  }

  async stop(phiSessionId: string, runId: string): Promise<void> {
    await this.stopRuntimeRun(this.runtimeSessionId(phiSessionId), runId)
  }
}

export function createEngineStepRunner(deps: EngineStepRunnerDependencies): StepRunner {
  return new EngineStepRunner(deps)
}
