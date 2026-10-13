import { type CreateAgentSessionResult } from '@oh-my-pi/pi-coding-agent'
import { discoverCustomMcpOAuthEndpoints } from '../mcp/featured-mcp-auth'
import { MCPManager } from '../mcp/omp-mcp'
import { OwnedStdioTransportScope } from '../mcp/owned-stdio-transports'
import { type EnvironmentLease } from '../../envs/leases'
import { type RemoteMcpGuardState, type RemoteMcpProfilePolicy } from '../../mcp/remote-mcp-policy'
import { readCustomRemoteMcpConnector } from '../../mcp-connectors'
import { BrowserTextVault } from '../../browser/browser-text-vault'
import { AgentRunRegistry } from '../../agents/registry'
import { RuntimeContext } from './common'

export type RemoteMcpAccess = {
  localProjectAnchor: string
  projectPolicy?: RemoteMcpProfilePolicy
  state?: RemoteMcpGuardState
}

export type SessionEntry = {
  result: CreateAgentSessionResult
  agentDir: string
  /** The runs of this session's specialist agents; stopped with the session. */
  agentRuns?: AgentRunRegistry
  /** Stops telling the main process about those runs (used when the session goes away). */
  stopAgentRunNotices?: () => void
  browserTextVault?: BrowserTextVault
  activeHostRunId?: string
  mcpLeases?: Map<string, EnvironmentLease>
  ownedMcpManager?: MCPManager
  ownedStdioTransports?: Map<string, OwnedStdioTransportScope>
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
