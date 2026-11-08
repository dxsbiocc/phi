import { createHash } from 'node:crypto'
import type { PlanRunFinishedEvent } from '../../../shared/planRunTypes'
import { isAbsolute, relative, sep } from 'node:path'

import type {
  JsonValue,
  KernelEventFrame,
  KernelHelloResult,
  KernelV1Method,
  ProtocolErrorCode
} from '../../../shared/kernel-protocol'
import type {
  PhiHostRequestHandler,
  PhiSessionCreateParams,
  RuntimeModel,
  ThinkingLevel,
  ToolApprovalRequest,
  WorkerSessionState
} from './types'
import type { RoutedSessionSink } from './session-routing-engine'
import {
  KernelClientError,
  type KernelHostRequestContext,
  type KernelProtocolClient
} from './kernel-client'
import { phiOnlySessionPath } from '../session/sessions'
import type { KernelHistoryPlan } from './kernel-history'

/** Normalize the trusted JSON boundary once, dropping optional `undefined` fields recursively. */
export function jsonSafeResourceSnapshot<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

export interface KernelSessionClient {
  request(
    method: Exclude<KernelV1Method, 'kernel.hello'> | string,
    params: JsonValue,
    context?: { sessionId?: string; runId?: string }
  ): Promise<JsonValue>
  subscribe(afterSeq?: number): Promise<JsonValue>
  onEvent(listener: (event: KernelEventFrame) => void): () => void
  onClose(listener: () => void): () => void
  registerHostHandler(
    capability: string,
    handler: (params: JsonValue, context: KernelHostRequestContext) => unknown | Promise<unknown>
  ): () => void
}

export interface KernelSessionConnection {
  readonly client: KernelSessionClient
  readonly greeting: KernelHelloResult
  readonly configuredBeforeHello?: boolean
  readonly runtimeRoot?: string
  planHistory?(params: PhiSessionCreateParams): Promise<KernelHistoryPlan>
  close(): Promise<void>
}

export interface KernelSessionLaunchContext {
  readonly hostCapabilities: readonly string[]
  readonly afterSeq: number
  configureClient(client: KernelSessionClient): void
}

export type KernelSessionLauncher = (
  params: PhiSessionCreateParams,
  context: KernelSessionLaunchContext,
  signal: AbortSignal
) => Promise<KernelSessionConnection>

export interface KernelSessionFactoryOptions {
  readonly launchLocal?: KernelSessionLauncher
  readonly launchRemote?: KernelSessionLauncher
  readonly onDiagnostic?: (error: Error) => void
  /** A kernel plan finished; the desktop persists its card and wakes the conversation. */
  readonly onPlanRunFinished?: (phiSessionId: string, event: PlanRunFinishedEvent) => void
  readonly hostCapabilities?: readonly string[]
  readonly configureClient?: (
    client: KernelSessionClient,
    context: {
      readonly hostKey: string
      resolveSession(kernelSessionId: string):
        | {
            readonly logicalSessionId: string
            readonly kernelSessionId: string
            readonly params: PhiSessionCreateParams
          }
        | undefined
      snapshotSession(kernelSessionId: string): WorkerSessionState | undefined
    }
  ) => void | (() => void)
}

export type RunCompletion = {
  readonly status: 'completed' | 'failed' | 'cancelled' | 'unknown'
  readonly detail?: string
}

export type SessionBinding = {
  readonly logicalSessionId: string
  readonly kernelSessionId: string
  readonly hostKey: string
  readonly params: PhiSessionCreateParams
  readonly resources: JsonValue
  readonly sessionFile?: string
  readonly sink: RoutedSessionSink
  model?: RuntimeModel
  state: WorkerSessionState
  disposed: boolean
  activeAgentRuns: number
}

export type PendingRun = {
  readonly promise: Promise<RunCompletion>
  resolve(value: RunCompletion): void
}

export function pendingRun(): PendingRun {
  let resolve!: (value: RunCompletion) => void
  const promise = new Promise<RunCompletion>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

export function record(value: unknown): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export class KernelEngineError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
    readonly detail?: JsonValue
  ) {
    super(`[PHI_KERNEL:${code}] ${message}`)
    this.name = 'KernelEngineError'
  }
}

export function engineError(error: unknown): Error {
  if (error instanceof KernelEngineError) return error
  if (error instanceof KernelClientError) {
    return new KernelEngineError(error.code, error.message, error.detail)
  }
  return errorFrom(error)
}

export function promptWireOptions(raw: Record<string, unknown> | undefined): JsonValue {
  const options: Record<string, JsonValue> = { version: 1 }
  if (Array.isArray(raw?.images)) options.images = jsonSafeResourceSnapshot(raw.images) as JsonValue
  if (typeof raw?.expandPromptTemplates === 'boolean') {
    options.expandPromptTemplates = raw.expandPromptTemplates
  }
  if (typeof raw?.skipCompactionCheck === 'boolean') {
    options.skipCompactionCheck = raw.skipCompactionCheck
  }
  return options
}

export function sessionResources(params: PhiSessionCreateParams): JsonValue {
  const resources: Record<string, JsonValue> = {}
  const rawResourceOptions = params.resourceOptions
  const resourceOptions = rawResourceOptions
    ? {
        noExtensions: rawResourceOptions.noExtensions === true,
        noSkills: rawResourceOptions.noSkills === true,
        noContextFiles: rawResourceOptions.noContextFiles === true,
        noPromptTemplates: rawResourceOptions.noPromptTemplates === true,
        noThemes: rawResourceOptions.noThemes === true
      }
    : undefined
  const memory = params.memory
    ? { enabled: params.memory.enabled === true, learn: params.memory.learn === true }
    : undefined
  const entries: Array<[string, unknown]> = [
    ['workMode', params.workMode],
    ['enableToolApproval', params.enableToolApproval],
    ['autoCompaction', params.autoCompaction && { enabled: params.autoCompaction.enabled ?? true }],
    ['resourceOptions', resourceOptions],
    ['phiAgents', params.phiAgents],
    ['personaMarkdown', params.personaMarkdown],
    ['projectBound', params.projectBound],
    ['memory', memory],
    ['contextFiles', params.contextFiles ?? params.remoteProject?.contextFiles],
    ['mcpServers', params.mcpServers],
    ['desktopMcp', params.desktopMcp],
    ['environment', params.environment],
    ['noTools', params.noTools]
  ]
  for (const [key, value] of entries) {
    if (value !== undefined) resources[key] = jsonSafeResourceSnapshot(value) as JsonValue
  }
  resources.resourceVersion = createHash('sha256').update(JSON.stringify(resources)).digest('hex')
  return resources
}

export function sessionCreateParams(
  params: PhiSessionCreateParams,
  resources: JsonValue
): JsonValue {
  const resourceRecord = record(resources) ?? {}
  const cwd = params.remoteProject?.location.canonicalRoot ?? params.cwd
  return {
    cwd,
    model: { provider: params.model!.provider, id: params.model!.id },
    ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
    sessionManager: { kind: params.sessionManager.kind === 'memory' ? 'memory' : 'persistent' },
    ...resourceRecord
  }
}

export function kernelSessionIdFromJournalPath(
  path: string | undefined,
  agentDir: string
): string | undefined {
  if (!path || !isAbsolute(path)) return undefined
  const child = relative(`${agentDir}${sep}phi-kernel${sep}sessions`, path)
  const parts = child.split(sep)
  if (
    parts.length !== 2 ||
    parts[1] !== 'journal.jsonl' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(parts[0])
  ) {
    return undefined
  }
  return parts[0]
}

function runtimeModel(
  value: unknown,
  fallback: RuntimeModel | undefined
): RuntimeModel | undefined {
  const item = record(value)
  const provider = stringValue(item?.provider)
  const id = stringValue(item?.id)
  if (!provider || !id) return fallback
  if (fallback?.provider === provider && fallback.id === id) return structuredClone(fallback)
  return { provider, id, name: id, reasoning: false }
}

export function stateFromKernel(
  value: unknown,
  binding: Pick<SessionBinding, 'model' | 'params' | 'sessionFile'>
): WorkerSessionState {
  const item = record(value)
  if (!item) throw new TypeError('Kernel returned an invalid session snapshot.')
  const thinking = stringValue(item.thinkingLevel)
  const model = runtimeModel(item.model, binding.model)
  return {
    ...(Array.isArray(item.messages) ? { messages: structuredClone(item.messages) } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
    ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
    ...(binding.params.phiSessionId
      ? { sessionFile: phiOnlySessionPath(binding.params.phiSessionId) }
      : binding.sessionFile
        ? { sessionFile: binding.sessionFile }
        : binding.params.sessionManager.path
          ? { sessionFile: binding.params.sessionManager.path }
          : {})
  }
}

export function approvalFromEvent(
  payload: Record<string, JsonValue>
): ToolApprovalRequest | undefined {
  const requestId = stringValue(payload.approvalId)
  if (!requestId) return undefined
  const input = record(payload.input)
  return {
    requestId,
    ...(stringValue(payload.toolCallId) ? { toolCallId: String(payload.toolCallId) } : {}),
    ...(stringValue(payload.toolName) ? { toolName: String(payload.toolName) } : {}),
    ...(input ? { input: structuredClone(input) } : {}),
    ...(stringValue(payload.agentRunId) ? { agentRunId: String(payload.agentRunId) } : {}),
    ...(stringValue(payload.outsideProject)
      ? { outsideProject: String(payload.outsideProject) }
      : {})
  }
}

// Compile-time structural proof for the production protocol client.
const _kernelClientCompatibility: KernelSessionClient | undefined = undefined as
  KernelProtocolClient | undefined
void _kernelClientCompatibility

export type KernelHostHandlerEntry = {
  readonly method: string
  readonly handler: PhiHostRequestHandler
}
