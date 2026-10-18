import type { OmpBridge } from '../omp-bridge'
import type { PhiTool, PhiToolApproval } from '../types'
import type { RemoteProjectMcpRuntimeServer } from '../../../../shared/remoteProjectMcpTypes'
import type { SkippedMcpServerNotice } from '../../../../shared/mcpSkippedServers'
import type { RpcDesktopToolIdentity } from './desktop-tool-scope'

export interface DesktopMcpOptions {
  readonly identity: RpcDesktopToolIdentity
  readonly agentDir: string
  readonly resourceCwd: string
  /** Enabled server names from the trusted main-process resource catalog. */
  readonly serverNames: readonly string[]
  /** Explicit main-process opt-in; never inferred from a discovered tool annotation. */
  readonly allowStdio?: true
  readonly remoteProjectMcpServers?: readonly RemoteProjectMcpRuntimeServer[]
  readonly approvalFor: (
    name: string,
    input: Readonly<Record<string, unknown>>
  ) => PhiToolApproval | undefined
  readonly signal?: AbortSignal
  /** Main-process binding assertion; never serialized into worker requests. */
  readonly beforeDispatch?: () => void
  /** Genuine desktop engine bridge; useful for isolated SDK integration fixtures. */
  readonly bridge?: OmpBridge
}
export interface DesktopMcpAdapter {
  readonly identity: Readonly<RpcDesktopToolIdentity>
  readonly tools: readonly PhiTool[]
  /** Selected servers left out of this conversation (names and reason codes only). */
  readonly skipped: readonly SkippedMcpServerNotice[]
  approvalFor(name: string, input: Readonly<Record<string, unknown>>): PhiToolApproval | undefined
  retire(reason?: unknown): void
  close(): Promise<void>
}
export interface DesktopMcpToolMetadata {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  signature: string
}
