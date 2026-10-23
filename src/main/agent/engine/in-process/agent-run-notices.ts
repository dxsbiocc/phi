import { AGENT_RUN_HOST_METHODS } from '../../agents/run-host'
import type { AgentRunRegistry, AgentRunSnapshot } from '../../agents/registry'

type HostRequester = (method: string, params: unknown) => Promise<unknown>

function isHostRun(run: AgentRunSnapshot): boolean {
  return run.origin === 'host'
}

export function subscribeToAgentRunNotices(options: {
  registry: AgentRunRegistry
  sessionId: string
  requestHost: HostRequester
}): () => void {
  return options.registry.subscribe({
    onFinish: (run) => {
      if (!run.background) return
      void options
        .requestHost(AGENT_RUN_HOST_METHODS.finished, {
          originSessionId: options.sessionId,
          run
        })
        .catch(() => undefined)
    },
    onStep: (run, step) => {
      if (!run.background || isHostRun(run)) return
      void options
        .requestHost(AGENT_RUN_HOST_METHODS.step, {
          originSessionId: options.sessionId,
          run: { id: run.id, agent: run.agent, toolCallId: run.toolCallId },
          step
        })
        .catch(() => undefined)
    },
    onReported: (run) => {
      if (!run.background || isHostRun(run)) return
      void options
        .requestHost(AGENT_RUN_HOST_METHODS.reported, {
          originSessionId: options.sessionId,
          runId: run.id
        })
        .catch(() => undefined)
    }
  })
}
