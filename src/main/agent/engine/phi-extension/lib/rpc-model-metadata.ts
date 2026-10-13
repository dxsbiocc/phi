import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from 'node:fs'
import { isAbsolute, join, posix, resolve } from 'node:path'
import type { RpcBootstrapConfig } from './rpc-config'

export const RPC_MODEL_METADATA_FILENAME = 'phi-model-metadata.json'
export const RPC_MODEL_SELECTION_COMMAND = 'phi-rpc-select-model'
export const RPC_MODEL_SELECTION_DESCRIPTION = 'Phi RPC model selection v1'
export const RPC_MODEL_METADATA_MAX_BYTES = 4 * 1024 * 1024

/** Explicit metadata only: gateway routing and credentials never belong in this document. */
export interface RpcSafeModelDescriptor {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly reasoning: boolean
  readonly input: readonly ('text' | 'image')[]
  readonly contextWindow: number | null
  readonly maxTokens: number | null
  readonly cost?: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
}

export interface RpcModelMetadata {
  readonly schema: 1
  readonly nonce: string
  readonly sessionId: string
  readonly projectRoot: string
  readonly gatewayGeneration: number
  readonly models: readonly RpcSafeModelDescriptor[]
}

export interface RpcModelSelectionRequest {
  readonly nonce: string
  readonly sessionId: string
  readonly projectRoot: string
  readonly gatewayGeneration: number
  readonly selectionId: string
  readonly provider: string
  readonly modelId: string
}

export interface RpcModelSelectionNotification extends RpcModelSelectionRequest {
  readonly type: 'phi_rpc_model_selection'
  readonly protocolVersion: 1
  readonly contextWindow: number | null
  readonly maxTokens: number | null
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Phi RPC model metadata must contain plain objects')
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error('Phi RPC model metadata has unexpected or missing fields')
}

function text(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
}

function limit(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
}

/** Shared with the private writer; reconstructs and freezes the only accepted safe fields. */
export function validateRpcModelMetadata(value: unknown): RpcModelMetadata {
  const raw = record(value)
  exactKeys(raw, ['schema', 'nonce', 'sessionId', 'projectRoot', 'gatewayGeneration', 'models'])
  if (
    raw.schema !== 1 ||
    typeof raw.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(raw.nonce) ||
    !text(raw.sessionId, 256) ||
    !text(raw.projectRoot, 4096) ||
    !posix.isAbsolute(raw.projectRoot) ||
    posix.resolve(raw.projectRoot) !== raw.projectRoot ||
    !Number.isSafeInteger(raw.gatewayGeneration) ||
    (raw.gatewayGeneration as number) < 1 ||
    !Array.isArray(raw.models) ||
    !raw.models.length ||
    raw.models.length > 4096
  )
    throw new Error('Phi RPC model metadata identity is invalid')
  const identities = new Set<string>()
  const models = raw.models.map((value): RpcSafeModelDescriptor => {
    const model = record(value)
    exactKeys(
      model,
      ['provider', 'id', 'name', 'reasoning', 'input', 'contextWindow', 'maxTokens'],
      ['cost']
    )
    if (
      !text(model.provider, 256) ||
      !text(model.id, 256) ||
      !text(model.name, 512) ||
      typeof model.reasoning !== 'boolean' ||
      !Array.isArray(model.input) ||
      !model.input.length ||
      model.input.length > 2 ||
      new Set(model.input).size !== model.input.length ||
      model.input.some((kind) => kind !== 'text' && kind !== 'image') ||
      !limit(model.contextWindow) ||
      !limit(model.maxTokens)
    )
      throw new Error('Phi RPC model metadata capabilities are invalid')
    const identity = JSON.stringify([model.provider, model.id])
    if (identities.has(identity))
      throw new Error('Phi RPC model metadata contains duplicate models')
    identities.add(identity)
    let cost: RpcSafeModelDescriptor['cost']
    if (model.cost !== undefined) {
      const rawCost = record(model.cost)
      exactKeys(rawCost, ['input', 'output', 'cacheRead', 'cacheWrite'])
      if (
        Object.values(rawCost).some(
          (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0
        )
      )
        throw new Error('Phi RPC model metadata costs are invalid')
      cost = Object.freeze({
        input: rawCost.input as number,
        output: rawCost.output as number,
        cacheRead: rawCost.cacheRead as number,
        cacheWrite: rawCost.cacheWrite as number
      })
    }
    return Object.freeze({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: Object.freeze(model.input.slice()) as RpcSafeModelDescriptor['input'],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...(cost ? { cost } : {})
    })
  })
  return Object.freeze({
    schema: 1,
    nonce: raw.nonce,
    sessionId: raw.sessionId,
    projectRoot: raw.projectRoot,
    gatewayGeneration: raw.gatewayGeneration as number,
    models: Object.freeze(models)
  })
}

/** Absence is supported for T10; any present but invalid sidecar prevents bootstrap attestation. */
export function loadRpcModelMetadata(
  agentDir: string | undefined,
  config: RpcBootstrapConfig
): RpcModelMetadata | undefined {
  if (!agentDir) return undefined
  if (
    !isAbsolute(agentDir) ||
    resolve(agentDir) !== agentDir ||
    realpathSync(agentDir) !== agentDir
  )
    throw new Error('Phi RPC model metadata requires a canonical agent directory')
  const path = join(agentDir, RPC_MODEL_METADATA_FILENAME)
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Phi RPC model metadata could not be opened safely')
  }
  try {
    const directory = statSync(agentDir)
    const metadata = fstatSync(descriptor)
    if (
      !agentDir.endsWith(`/rpc-sessions/${config.nonce}/home/agent`) ||
      !directory.isDirectory() ||
      (directory.mode & 0o077) !== 0 ||
      (process.getuid && directory.uid !== process.getuid()) ||
      !metadata.isFile() ||
      metadata.size > RPC_MODEL_METADATA_MAX_BYTES ||
      (metadata.mode & 0o777) !== 0o600 ||
      (process.getuid && metadata.uid !== process.getuid())
    )
      throw new Error('Phi RPC model metadata must be a private owned generation file')
    const bytes = Buffer.alloc(RPC_MODEL_METADATA_MAX_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, null)
      if (!count) break
      size += count
    }
    if (size === bytes.length) throw new Error('Phi RPC model metadata exceeds 4 MiB')
    const parsed = validateRpcModelMetadata(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
    )
    if (
      parsed.nonce !== config.nonce ||
      parsed.sessionId !== config.sessionId ||
      parsed.projectRoot !== config.projectRoot
    )
      throw new Error('Phi RPC model metadata does not match bootstrap identity')
    return parsed
  } finally {
    closeSync(descriptor)
  }
}

export function parseRpcModelSelectionRequest(
  args: string,
  metadata: RpcModelMetadata
): RpcModelSelectionRequest {
  if (Buffer.byteLength(args) > 4096)
    throw new Error('Phi RPC model selection request exceeds its limit')
  let value: unknown
  try {
    value = JSON.parse(args)
  } catch {
    throw new Error('Phi RPC model selection requires valid JSON')
  }
  const request = record(value)
  exactKeys(request, [
    'nonce',
    'sessionId',
    'projectRoot',
    'gatewayGeneration',
    'selectionId',
    'provider',
    'modelId'
  ])
  if (
    request.nonce !== metadata.nonce ||
    request.sessionId !== metadata.sessionId ||
    request.projectRoot !== metadata.projectRoot ||
    request.gatewayGeneration !== metadata.gatewayGeneration ||
    typeof request.selectionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      request.selectionId
    ) ||
    !text(request.provider, 256) ||
    !text(request.modelId, 256)
  )
    throw new Error('Phi RPC model selection identity is invalid')
  return Object.freeze({
    nonce: metadata.nonce,
    sessionId: metadata.sessionId,
    projectRoot: metadata.projectRoot,
    gatewayGeneration: metadata.gatewayGeneration,
    selectionId: request.selectionId,
    provider: request.provider,
    modelId: request.modelId
  })
}
