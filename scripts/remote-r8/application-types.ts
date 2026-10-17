import type { createRuntimeAgentSession } from '../../src/main/agent/runtime/runtime-adapter'
import type { RemoteSessionRuntimeOptions } from '../../src/main/agent/engine/rpc/remote-session-runtime'
import type { RemoteStartupDiagnostic } from '../../src/main/agent/engine/rpc/remote-startup-diagnostics'
import type { SessionRunnerRegistry } from '../../src/main/agent/session/session-runner-registry'
import type { ModelReply, ModelRequest } from '../../tests/helpers/rpcHostResultModel'

export type AgentProxy = Awaited<ReturnType<typeof createRuntimeAgentSession>>['session']
export type ApprovalPolicy = RemoteSessionRuntimeOptions['approval']

export interface R8Provider {
  readonly requests: ModelRequest[]
  enqueue(...replies: ModelReply[]): void
}

export interface RequestPurposes {
  root: number
  child: number
  summary: number
}

/** The application side of one R8 run: real composition, or the local-shell test composition. */
export interface R8Application {
  readonly runners: SessionRunnerRegistry
  readonly provider: R8Provider
  readonly projectId: string
  /** Local project anchor; its sentinel files must stay unchanged by remote effects. */
  readonly anchor: string
  readonly purposes: RequestPurposes
  /** One production startup profile per session creation or explicit resume, in order. */
  readonly startupReports: RemoteStartupDiagnostic[]
  readonly ompVersion: string
  /**
   * One real production startup, disposed again, so that anything missing on the server (OMP
   * binary, extension, helper, ready markers) is installed through the normal path.
   */
  prepare(): Promise<void>
  create(): { sessionId: string }
  attach(phiSessionId: string, resume: boolean): Promise<{ session: AgentProxy }>
  approval(value: ApprovalPolicy): void
  close(): Promise<void>
}
