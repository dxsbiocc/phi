import type { PhiTool } from '../types'

export const DESKTOP_SEARCH_CONFIGURATION_LIMITS = Object.freeze({
  commandBackedCredentials: 'unsupported',
  commandBackedModelHeaders: 'unsupported',
  previouslyCachedDiscoveredModels: 'unsupported'
} as const)

export interface DesktopWebSearchIdentity {
  readonly runtimeSessionId: string
  readonly sessionId: string
  readonly projectId: string
  /** Canonical server cwd; never used for desktop filesystem access. */
  readonly cwd: string
}
export interface DesktopWebSearchModel {
  readonly provider: string
  readonly id: string
}
export interface DesktopWebSearchOptions {
  readonly identity: DesktopWebSearchIdentity
  readonly agentDir: string
  /** Trusted desktop resource/configuration anchor, independent of remote cwd. */
  readonly resourceCwd: string
  /** Trusted session/window lifetime, including asynchronous adapter creation. */
  readonly signal?: AbortSignal
  readonly currentModel: () => DesktopWebSearchModel | undefined
  /** Trusted process launcher environment; never accepted from tool input. */
  readonly env?: NodeJS.ProcessEnv
  readonly workerPath?: string
}
export interface DesktopWebSearchAdapter {
  readonly identity: Readonly<DesktopWebSearchIdentity>
  readonly configurationLimits: {
    readonly commandBackedCredentials: 'unsupported'
    readonly commandBackedModelHeaders: 'unsupported'
    readonly previouslyCachedDiscoveredModels: 'unsupported'
  }
  readonly tool: PhiTool
  retire(reason?: unknown): void
  close(): Promise<void>
}
export interface DesktopWebSearchMetadata {
  name: 'web_search'
  label: string
  description: string
  parameters: Record<string, unknown>
}
