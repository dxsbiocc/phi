import { type CreateAgentSessionResult } from '@oh-my-pi/pi-coding-agent'
import type { discoverCustomMcpOAuthEndpoints } from '../mcp/featured-mcp-auth'
import type { MCPManager } from '../mcp/omp-mcp'
import type { OwnedStdioTransportScope } from '../mcp/owned-stdio-transports'
import { type EnvironmentLease } from '../../envs/leases'
import { type RemoteMcpGuardState, type RemoteMcpProfilePolicy } from '../../mcp/remote-mcp-policy'
import type { readCustomRemoteMcpConnector } from '../../mcp-connectors'
import type { BrowserTextVault } from '../../browser/browser-text-vault'
import type { AgentRunFn, AgentRunRegistry } from '../../agents/registry'
import type { PlanStepsToolResult } from '../../plan/plan-review-mode'
import type { RuntimeContext } from './common'
import type { DefaultResourceLoader } from './session-factory'
import type { SessionResourceSnapshot } from './session-resource-input'
import type { PhiAgentDefinition } from '../../agents/definition'
import type { KernelPlanRuntime } from './kernel-services'

export type RemoteMcpAccess = {
  localProjectAnchor: string
  projectPolicy?: RemoteMcpProfilePolicy
  state?: RemoteMcpGuardState
}

export type SessionEntry = {
  result: CreateAgentSessionResult
  agentDir: string
  context?: RuntimeContext
  /** The runs of this session's specialist agents; stopped with the session. */
  agentRuns?: AgentRunRegistry
  /** Every configured specialist, including host-only orchestration agents. */
  agentRunners?: ReadonlyMap<string, AgentRunFn>
  /** Present only while structured plan review is active. */
  planStepsProposal?: (input: unknown) => Promise<PlanStepsToolResult>
  /** Stops telling the main process about those runs (used when the session goes away). */
  stopAgentRunNotices?: () => void
  /** Kernel fact publisher; the legacy desktop worker does not install it. */
  stopKernelAgentRunNotices?: () => void
  /** Kernel-owned plan service used after the host supplies only the review decision. */
  kernelPlanRuntime?: KernelPlanRuntime
  browserTextVault?: BrowserTextVault
  activeHostRunId?: string
  mcpLeases?: Map<string, EnvironmentLease>
  ownedMcpManager?: MCPManager
  ownedStdioTransports?: Map<string, OwnedStdioTransportScope>
  closeDesktopMcp?: () => Promise<void>
  resourceLoader?: DefaultResourceLoader
  resourceSnapshot?: SessionResourceSnapshot
  applyResourceReload?: (params: unknown) => void
  reloadAgents?: (
    definitions: PhiAgentDefinition[]
  ) => Promise<
    | { applied: true; added: string[] }
    | { applied: false; reason: 'requires_session_refresh'; changed: string[] }
  >
  remoteMcpAccess?: RemoteMcpAccess
  disposing?: boolean
}

export const contexts = new Map<string, Promise<RuntimeContext>>()

export const sessions = new Map<string, SessionEntry>()

export type WorkerAgentSession = CreateAgentSessionResult['session']

export type RuntimeThinkingLevel = Parameters<WorkerAgentSession['setThinkingLevel']>[0]

export type ToolSchema = WorkerAgentSession['agent']['state']['tools'][number]

export const mcpUsageCache = new WeakMap<
  WorkerAgentSession,
  {
    tokenizer: WorkerAgentSession['agent']['tokenizer']
    directTools: ToolSchema[]
    deferredTools: ToolSchema[]
    directTokens: number
    deferredTokens: number
  }
>()

export const pendingHostRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }
>()

export const pendingToolApprovals = new Map<string, (result: unknown) => void>()

export const pendingAuthPrompts = new Map<
  string,
  {
    resolve: (value: string) => void
    reject: (error: Error) => void
  }
>()

export const featuredAuthAbort = new Map<string, AbortController>()

export const pendingCustomMcpAuth = new Map<
  string,
  {
    attemptId: string
    connector: ReturnType<typeof readCustomRemoteMcpConnector>
    cancel: AbortController
    endpoints?: Awaited<ReturnType<typeof discoverCustomMcpOAuthEndpoints>>
  }
>()
