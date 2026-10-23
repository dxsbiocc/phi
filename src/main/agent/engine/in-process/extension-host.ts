import type { PhiAgentDefinition } from '../../agents/definition'
import type { AgentRunRegistry } from '../../agents/registry'
import type { BrowserTextVault } from '../../browser/browser-text-vault'
import type {
  PhiExtensionAgentConfig,
  PhiExtensionEnvironmentBinding,
  PhiExtensionHost
} from '../phi-extension'
import type { PlanStepsToolResult } from '../../plan/plan-review-mode'
import { requestToolApproval } from './tool-support'

export interface InProcessExtensionHostOptions {
  cwd: string
  nextActionSuggestionsEnabled?: () => Promise<boolean>
  planModeActive?: () => boolean
  planExecuteModeActive?: () => boolean
  proposePlanSteps?: (input: unknown) => Promise<PlanStepsToolResult>
  browserTextVault?: BrowserTextVault
  agentRuns?: AgentRunRegistry
  environmentBinding?: () => PhiExtensionEnvironmentBinding | undefined
  hostEnvironment?: () => Readonly<Record<string, string | undefined>>
}

/** Adapts worker-owned live state to the uploadable extension package contract. */
export function createInProcessExtensionHost(
  options: InProcessExtensionHostOptions
): PhiExtensionHost {
  return {
    nextActionSuggestionsEnabled: options.nextActionSuggestionsEnabled ?? (async () => false),
    planModeActive: options.planModeActive ?? (() => false),
    planExecuteModeActive: options.planExecuteModeActive ?? (() => false),
    proposePlanSteps:
      options.proposePlanSteps ??
      (async () => {
        throw new Error('Plan execution mode is not active')
      }),
    requestToolApproval: (request) =>
      requestToolApproval(
        request.sessionId,
        {
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          input: request.input
        },
        request.agentRunId,
        options.browserTextVault
      ),
    browserApprovalInput: (toolCallId, input) =>
      options.browserTextVault?.approvalInput(toolCallId, input) ?? input,
    markBrowserTextDenied: (toolCallId) => {
      options.browserTextVault?.markDenied(toolCallId)
    },
    fallbackReadiness: (agent, afterFailures) => {
      if (!options.agentRuns) {
        return { allowed: false, failures: 0, reason: `${agent} must be delegated first.` }
      }
      return options.agentRuns.fallbackReadiness(agent, afterFailures)
    },
    environmentBinding: options.environmentBinding ?? (() => undefined),
    hostEnvironment: options.hostEnvironment ?? (() => process.env)
  }
}

export function phiExtensionAgents(
  definitions: readonly PhiAgentDefinition[]
): PhiExtensionAgentConfig[] {
  return definitions.map((agent) => ({
    name: agent.name,
    ...(agent.delegationMode ? { delegationMode: agent.delegationMode } : {}),
    ...(agent.fallback
      ? {
          fallback: {
            afterFailures: agent.fallback.afterFailures,
            tools: [...agent.fallback.tools],
            match: [...agent.fallback.match]
          }
        }
      : {})
  }))
}
