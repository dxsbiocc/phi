import { createHmac, timingSafeEqual } from 'node:crypto'
import { sameRpcChildScope, validateRpcChildScope, type RpcChildScope } from './rpc-child-protocol'
import { executionCapability } from './rpc-execution-protocol'

export const RPC_CHILD_MODEL_HEADER = 'x-phi-child-model'
const DOMAIN = 'phi-rpc-child-model-v1'
const MAX_HEADER_BYTES = 8 * 1024

function canonicalScope(value: unknown): RpcChildScope {
  const scope = validateRpcChildScope(value)
  return Object.freeze({
    phiSessionId: scope.phiSessionId,
    projectId: scope.projectId,
    cwd: scope.cwd,
    generation: scope.generation,
    rootAgentId: scope.rootAgentId,
    rootOmpSessionId: scope.rootOmpSessionId,
    rootSessionFile: scope.rootSessionFile,
    nativeAgentId: scope.nativeAgentId,
    childOmpSessionId: scope.childOmpSessionId,
    childSessionFile: scope.childSessionFile,
    parentSession: scope.parentSession,
    nativeName: scope.nativeName,
    definitionHash: scope.definitionHash
  })
}

function signature(scope: RpcChildScope, capability: string): string {
  return createHmac('sha256', Buffer.from(capability, 'hex'))
    .update(`${DOMAIN}\0${JSON.stringify({ version: 1, scope })}`)
    .digest('hex')
}

/** Authenticates a child binding; the receiving gateway must still verify its live ownership. */
export function createRpcChildModelHeader(scope: RpcChildScope, capability: string): string {
  if (!executionCapability(capability)) throw new Error('Invalid RPC child model authority')
  const snapshot = canonicalScope(scope)
  const header = Buffer.from(
    JSON.stringify({ version: 1, scope: snapshot, hmac: signature(snapshot, capability) })
  ).toString('base64url')
  if (header.length > MAX_HEADER_BYTES) throw new Error('Invalid RPC child model authority')
  return header
}

export function verifyRpcChildModelHeader(
  header: unknown,
  capability: string
): RpcChildScope | undefined {
  try {
    if (
      !executionCapability(capability) ||
      typeof header !== 'string' ||
      header.length === 0 ||
      header.length > MAX_HEADER_BYTES ||
      !/^[A-Za-z0-9_-]+$/u.test(header)
    )
      return undefined
    const bytes = Buffer.from(header, 'base64url')
    if (bytes.toString('base64url') !== header) return undefined
    const json = bytes.toString('utf8')
    if (!Buffer.from(json).equals(bytes)) return undefined
    const value = JSON.parse(json)
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 3 ||
      value.version !== 1 ||
      !executionCapability(value.hmac)
    )
      return undefined
    const scope = canonicalScope(value.scope)
    if (
      !sameRpcChildScope(scope, value.scope) ||
      JSON.stringify({ version: 1, scope, hmac: value.hmac }) !== json ||
      !timingSafeEqual(
        Buffer.from(value.hmac, 'hex'),
        Buffer.from(signature(scope, capability), 'hex')
      )
    )
      return undefined
    return scope
  } catch {
    return undefined
  }
}
