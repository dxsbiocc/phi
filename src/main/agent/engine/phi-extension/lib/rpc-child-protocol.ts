import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { approvalIdentifier, createApprovalEnvelope } from './rpc-approval-protocol'
import { executionCapability } from './rpc-execution-protocol'

export const RPC_CHILD_SCHEME = 'phi-child'
export const MAX_RPC_CHILD_REQUEST_BYTES = 128 * 1024
export const MAX_RPC_CHILD_REPLY_BYTES = 4096
export const MAX_RPC_CHILD_CALLS = 4096
export type RpcChildOperation = 'register' | 'activate' | 'approve'
export const RPC_CHILD_NATIVE_TOOLS = Object.freeze(['read', 'write', 'bash', 'powershell'])
/** Package-local trusted DTO. Node maps validated compiler output without importing compiler modules into the server bundle. */
export interface RpcChildDefinition {
  readonly definitionHash: string
  readonly phiName: string
  readonly nativeName: string
  readonly blocking: boolean
  readonly tools: readonly { readonly name: string; readonly site: 'native' | 'host' }[]
  readonly skills: readonly string[]
  readonly model: { readonly provider: string; readonly id: string }
  readonly thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}
export interface RpcChildModelDescriptor {
  readonly provider: string
  readonly id: string
  readonly reasoning: boolean
  readonly input: readonly ('text' | 'image')[]
  readonly contextWindow: number
  readonly maxTokens: number
}
export interface RpcChildRoute {
  readonly api: 'openai-completions'
  readonly baseUrl: string
  readonly transport: 'pi-native' | 'sse'
}
export interface RpcChildTrustedProfile {
  readonly definition: RpcChildDefinition
  readonly systemPrompt: readonly string[]
  readonly expectedAgentSource: 'user'
  readonly model: RpcChildModelDescriptor
  readonly route: RpcChildRoute
}
export interface RpcChildRootScope {
  readonly phiSessionId: string
  readonly projectId: string
  readonly cwd: string
  readonly generation: number
  readonly rootAgentId: string
  readonly rootOmpSessionId: string
  readonly rootSessionFile: string
}
export interface RpcChildScope extends RpcChildRootScope {
  readonly nativeAgentId: string
  readonly childOmpSessionId: string
  readonly childSessionFile: string
  readonly parentSession: string
  readonly nativeName: string
  readonly definitionHash: string
}
export interface RpcChildActualProfile {
  readonly tools: readonly string[]
  readonly model: RpcChildModelDescriptor
  readonly route: RpcChildRoute
  readonly systemPromptDigest: string
  readonly thinkingLevel?: string
}
export interface RpcChildCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly inputDigest: string
}
interface RpcChildRequestBase {
  readonly schema: 1
  readonly id: string
  readonly capability: string
  readonly sequence: number
  readonly scope: RpcChildScope
}
export type RpcChildRequest = RpcChildRequestBase &
  (
    | { readonly operation: 'register' }
    | { readonly operation: 'activate'; readonly actual: RpcChildActualProfile }
    | { readonly operation: 'approve'; readonly call: RpcChildCall }
    | { readonly operation: 'cancel'; readonly targetId: string }
  )
export interface RpcChildReply {
  readonly schema: 1
  readonly id: string
  readonly operation: RpcChildOperation
  readonly sequence: number
  readonly allowed: boolean
}
const rootKeys = [
  'phiSessionId',
  'projectId',
  'cwd',
  'generation',
  'rootAgentId',
  'rootOmpSessionId',
  'rootSessionFile'
] as const
const scopeKeys = [
  ...rootKeys,
  'nativeAgentId',
  'childOmpSessionId',
  'childSessionFile',
  'parentSession',
  'nativeName',
  'definitionHash'
] as const
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('Invalid RPC child protocol fields')
}
function path(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value.length <= 4096 &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) &&
    posix.normalize(value) === value
  )
}
export function rpcChildRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
  )
}
export function validateRpcChildRoot(value: unknown): RpcChildRootScope {
  exact(value, rootKeys)
  if (
    !['phiSessionId', 'projectId', 'rootAgentId', 'rootOmpSessionId'].every((key) =>
      approvalIdentifier(value[key])
    ) ||
    !path(value.cwd) ||
    !path(value.rootSessionFile) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1
  )
    throw new Error('Invalid RPC child root binding')
  return Object.freeze({ ...value }) as unknown as RpcChildRootScope
}
export function validateRpcChildScope(value: unknown): RpcChildScope {
  exact(value, scopeKeys)
  validateRpcChildRoot(Object.fromEntries(rootKeys.map((key) => [key, value[key]])))
  if (
    !['nativeAgentId', 'childOmpSessionId', 'nativeName'].every((key) =>
      approvalIdentifier(value[key])
    ) ||
    value.nativeAgentId === value.rootAgentId ||
    value.childOmpSessionId === value.rootOmpSessionId ||
    !path(value.childSessionFile) ||
    !path(value.parentSession) ||
    value.parentSession !== value.rootSessionFile ||
    !executionCapability(value.definitionHash)
  )
    throw new Error('Invalid RPC child session binding')
  return Object.freeze({ ...value }) as unknown as RpcChildScope
}
export function sameRpcChildRoot(a: RpcChildRootScope, b: RpcChildRootScope): boolean {
  return rootKeys.every((key) => a[key] === b[key])
}
export function sameRpcChildScope(a: RpcChildScope, b: RpcChildScope): boolean {
  return scopeKeys.every((key) => a[key] === b[key])
}
export function rpcChildPromptDigest(prompt: readonly string[]): string {
  if (
    !Array.isArray(prompt) ||
    !prompt.length ||
    prompt.some((item) => typeof item !== 'string') ||
    Buffer.byteLength(JSON.stringify(prompt)) > MAX_RPC_CHILD_REQUEST_BYTES
  )
    throw new Error('Invalid trusted RPC child prompt')
  return createHash('sha256').update(JSON.stringify(prompt)).digest('hex')
}
const modelKeys = ['provider', 'id', 'reasoning', 'input', 'contextWindow', 'maxTokens'] as const
export function validateRpcChildModel(value: unknown): RpcChildModelDescriptor {
  exact(value, modelKeys)
  if (
    !approvalIdentifier(value.provider) ||
    !approvalIdentifier(value.id) ||
    typeof value.reasoning !== 'boolean' ||
    !Array.isArray(value.input) ||
    value.input.length < 1 ||
    value.input.length > 2 ||
    value.input.some((item) => item !== 'text' && item !== 'image') ||
    new Set(value.input).size !== value.input.length ||
    !Number.isSafeInteger(value.contextWindow) ||
    Number(value.contextWindow) < 1 ||
    !Number.isSafeInteger(value.maxTokens) ||
    Number(value.maxTokens) < 1
  )
    throw new Error('RPC child model requires trusted known metadata')
  return Object.freeze({
    provider: value.provider,
    id: value.id,
    reasoning: value.reasoning,
    input: Object.freeze([...value.input].sort()),
    contextWindow: value.contextWindow,
    maxTokens: value.maxTokens
  }) as RpcChildModelDescriptor
}
export function validateRpcChildRoute(value: unknown): RpcChildRoute {
  exact(value, ['api', 'baseUrl', 'transport'])
  if (
    value.api !== 'openai-completions' ||
    (value.transport !== 'pi-native' && value.transport !== 'sse') ||
    typeof value.baseUrl !== 'string'
  )
    throw new Error('RPC child route is not owned')
  const url = new URL(value.baseUrl)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    value.baseUrl !== url.origin
  )
    throw new Error('RPC child route must be an exact owned loopback endpoint')
  return Object.freeze({
    api: value.api,
    baseUrl: value.baseUrl,
    transport: value.transport
  }) as RpcChildRoute
}
function ownFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('RPC child actual model is unavailable')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Object.fromEntries(
    keys.map((key) => {
      const descriptor = descriptors[key]
      if (!descriptor || !('value' in descriptor))
        throw new Error('RPC child actual model fields must be plain data')
      return [key, descriptor.value]
    })
  )
}
export function projectRpcChildModel(value: unknown): RpcChildModelDescriptor {
  return validateRpcChildModel(ownFields(value, modelKeys))
}
export function projectRpcChildRoute(value: unknown): RpcChildRoute {
  const projected = ownFields(value, ['api', 'baseUrl'])
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (descriptors.transport && !('value' in descriptors.transport))
    throw new Error('RPC child actual transport accessor refused')
  if (descriptors.headers) {
    if (!('value' in descriptors.headers))
      throw new Error('RPC child model header accessor refused')
    const headers = descriptors.headers.value
    if (
      headers !== undefined &&
      (!headers ||
        typeof headers !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(headers)) ||
        Reflect.ownKeys(headers).length !== 0)
    )
      throw new Error('RPC child unverified model headers refused')
  }
  if (
    descriptors.apiKey &&
    (!('value' in descriptors.apiKey) || descriptors.apiKey.value !== undefined)
  )
    throw new Error('RPC child unverified model API key override refused')
  return validateRpcChildRoute({ ...projected, transport: descriptors.transport?.value ?? 'sse' })
}
export function sameRpcChildModel(a: RpcChildModelDescriptor, b: RpcChildModelDescriptor): boolean {
  return JSON.stringify(validateRpcChildModel(a)) === JSON.stringify(validateRpcChildModel(b))
}
export function sameRpcChildRoute(a: RpcChildRoute, b: RpcChildRoute): boolean {
  return JSON.stringify(validateRpcChildRoute(a)) === JSON.stringify(validateRpcChildRoute(b))
}
export function validateRpcChildActual(value: unknown): RpcChildActualProfile {
  const raw = value as Record<string, unknown>
  exact(
    value,
    raw?.thinkingLevel === undefined
      ? ['tools', 'model', 'route', 'systemPromptDigest']
      : ['tools', 'model', 'route', 'systemPromptDigest', 'thinkingLevel']
  )
  const model = validateRpcChildModel(raw.model)
  const route = validateRpcChildRoute(raw.route)
  if (
    !Array.isArray(raw.tools) ||
    raw.tools.length > 64 ||
    !raw.tools.every(approvalIdentifier) ||
    new Set(raw.tools).size !== raw.tools.length ||
    !executionCapability(raw.systemPromptDigest) ||
    (raw.thinkingLevel !== undefined &&
      !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(raw.thinkingLevel)))
  )
    throw new Error('Invalid actual RPC child profile')
  return Object.freeze({
    tools: Object.freeze([...raw.tools].sort()),
    model,
    route,
    systemPromptDigest: raw.systemPromptDigest,
    ...(raw.thinkingLevel === undefined ? {} : { thinkingLevel: raw.thinkingLevel })
  }) as RpcChildActualProfile
}
/** Reuses the existing JSON-only/accessor-safe canonicalizer, then binds the digest to the complete child scope. */
export function createRpcChildCall(
  scope: RpcChildScope,
  toolCallId: string,
  toolName: string,
  input: unknown
): RpcChildCall {
  validateRpcChildScope(scope)
  const canonical = createApprovalEnvelope(
    {
      nonce: 'phi-rpc-child-input-v1',
      phiSessionId: scope.phiSessionId,
      ompSessionId: scope.childOmpSessionId,
      projectId: scope.projectId,
      cwd: scope.cwd,
      generation: scope.generation,
      runId: scope.nativeAgentId
    },
    toolCallId,
    toolName,
    input
  )
  const body = { toolCallId, toolName, input: canonical.input }
  const inputDigest = createHash('sha256')
    .update(JSON.stringify({ scope, ...body }))
    .digest('hex')
  return Object.freeze({ ...body, inputDigest })
}
export function parseRpcChildRequest(content: unknown): RpcChildRequest {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_RPC_CHILD_REQUEST_BYTES)
    throw new Error('RPC child request exceeds its bound')
  const raw: unknown = JSON.parse(content)
  const value = raw as Record<string, unknown>
  const operationKeys =
    value?.operation === 'activate'
      ? ['actual']
      : value?.operation === 'approve'
        ? ['call']
        : value?.operation === 'cancel'
          ? ['targetId']
          : []
  exact(raw, ['schema', 'id', 'capability', 'sequence', 'scope', 'operation', ...operationKeys])
  if (
    value.schema !== 1 ||
    !rpcChildRequestId(value.id) ||
    !executionCapability(value.capability) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    !['register', 'activate', 'approve', 'cancel'].includes(String(value.operation))
  )
    throw new Error('Invalid RPC child request')
  const scope = validateRpcChildScope(value.scope)
  if (value.operation === 'activate')
    return Object.freeze({
      ...value,
      scope,
      actual: validateRpcChildActual(value.actual)
    }) as unknown as RpcChildRequest
  if (value.operation === 'approve') {
    exact(value.call, ['toolCallId', 'toolName', 'input', 'inputDigest'])
    const call = createRpcChildCall(
      scope,
      value.call.toolCallId as string,
      value.call.toolName as string,
      value.call.input
    )
    if (call.inputDigest !== value.call.inputDigest)
      throw new Error('RPC child call digest mismatch')
    return Object.freeze({ ...value, scope, call }) as unknown as RpcChildRequest
  }
  if (
    value.operation === 'cancel' &&
    (!rpcChildRequestId(value.targetId) || value.targetId === value.id)
  )
    throw new Error('Invalid RPC child cancellation target')
  return Object.freeze({ ...value, scope }) as unknown as RpcChildRequest
}
export function encodeRpcChildRequest(value: RpcChildRequest): string {
  const content = JSON.stringify(value)
  parseRpcChildRequest(content)
  return content
}
export function parseRpcChildReply(
  content: unknown,
  request: Exclude<RpcChildRequest, { operation: 'cancel' }>
): RpcChildReply {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_RPC_CHILD_REPLY_BYTES)
    throw new Error('RPC child reply exceeds its bound')
  const reply: unknown = JSON.parse(content)
  exact(reply, ['schema', 'id', 'operation', 'sequence', 'allowed'])
  if (
    reply.schema !== 1 ||
    reply.id !== request.id ||
    reply.operation !== request.operation ||
    reply.sequence !== request.sequence ||
    typeof reply.allowed !== 'boolean'
  )
    throw new Error('RPC child reply binding mismatch')
  return Object.freeze({ ...reply }) as unknown as RpcChildReply
}
export function rpcChildUri(part: 'request' | 'reply' | 'cancel', id: string): string {
  if (!rpcChildRequestId(id)) throw new Error('Invalid private RPC child URI id')
  return `${RPC_CHILD_SCHEME}://${part}/${id}`
}
export function parseRpcChildUri(value: unknown): {
  part: 'request' | 'reply' | 'cancel'
  id: string
} {
  if (typeof value !== 'string' || value.length > 128)
    throw new Error('Invalid private RPC child URI')
  const parsed = new URL(value)
  if (
    parsed.protocol !== `${RPC_CHILD_SCHEME}:` ||
    !['request', 'reply', 'cancel'].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    !rpcChildRequestId(parsed.pathname.slice(1)) ||
    parsed.href !== value
  )
    throw new Error('Invalid private RPC child URI')
  return { part: parsed.hostname as 'request' | 'reply' | 'cancel', id: parsed.pathname.slice(1) }
}
/** An invalid/non-JSON input is denied as well; scanning never evaluates accessors or follows cycles. */
export function hasReservedRpcChildUri(input: unknown): boolean {
  try {
    const safe = createApprovalEnvelope(
      {
        nonce: 'phi-rpc-child-reserved',
        phiSessionId: 'reserved',
        ompSessionId: 'reserved',
        projectId: 'reserved',
        cwd: '/',
        generation: 1,
        runId: 'reserved'
      },
      'reserved',
      'reserved',
      { value: input }
    ).input.value
    const walk = (value: unknown): boolean => {
      if (typeof value === 'string') {
        let decoded = value
        for (let index = 0; index < 4; index++) {
          if (/phi-child\s*:/iu.test(decoded)) return true
          try {
            const next = decodeURIComponent(decoded)
            if (next === decoded) break
            decoded = next
          } catch {
            break
          }
        }
        return false
      }
      if (Array.isArray(value)) return value.some(walk)
      if (value && typeof value === 'object')
        return Object.entries(value).some(([key, item]) => walk(key) || walk(item))
      return false
    }
    return walk(safe)
  } catch {
    return true
  }
}
export function snapshotRpcChildProfile(value: RpcChildTrustedProfile): RpcChildTrustedProfile {
  const root = {
    nonce: 'phi-rpc-child-profile',
    phiSessionId: 'profile',
    ompSessionId: 'profile',
    projectId: 'profile',
    cwd: '/',
    generation: 1,
    runId: 'profile'
  }
  const safe = createApprovalEnvelope(root, 'profile', 'profile', value).input
  exact(safe, ['definition', 'systemPrompt', 'expectedAgentSource', 'model', 'route'])
  const definition = safe.definition as Record<string, unknown>
  exact(
    definition,
    definition?.thinkingLevel === undefined
      ? ['definitionHash', 'phiName', 'nativeName', 'blocking', 'tools', 'skills', 'model']
      : [
          'definitionHash',
          'phiName',
          'nativeName',
          'blocking',
          'tools',
          'skills',
          'model',
          'thinkingLevel'
        ]
  )
  exact(definition.model, ['provider', 'id'])
  if (
    safe.expectedAgentSource !== 'user' ||
    !executionCapability(definition.definitionHash) ||
    !approvalIdentifier(definition.phiName) ||
    !approvalIdentifier(definition.nativeName) ||
    definition.blocking !== true ||
    definition.thinkingLevel === undefined ||
    !Array.isArray(definition.skills) ||
    definition.skills.length !== 0 ||
    !Array.isArray(definition.tools) ||
    definition.tools.length < 1 ||
    definition.tools.length > 64 ||
    !approvalIdentifier(definition.model.provider) ||
    !approvalIdentifier(definition.model.id)
  )
    throw new Error('Unsupported RPC child profile')
  const names = new Set<string>()
  for (const tool of definition.tools) {
    exact(tool, ['name', 'site'])
    if (
      tool.site !== 'native' ||
      typeof tool.name !== 'string' ||
      !RPC_CHILD_NATIVE_TOOLS.includes(tool.name) ||
      names.has(tool.name)
    )
      throw new Error('Unsupported RPC child native tool')
    names.add(tool.name)
  }
  const model = validateRpcChildModel(safe.model)
  validateRpcChildRoute(safe.route)
  if (model.provider !== definition.model.provider || model.id !== definition.model.id)
    throw new Error('RPC child model descriptor does not match the definition')
  const systemPrompt = safe.systemPrompt as string[]
  rpcChildPromptDigest(systemPrompt)
  validateRpcChildActual({
    tools: [...names],
    model,
    route: safe.route,
    systemPromptDigest: rpcChildPromptDigest(systemPrompt),
    ...(definition.thinkingLevel === undefined ? {} : { thinkingLevel: definition.thinkingLevel })
  })
  return safe as unknown as RpcChildTrustedProfile
}
