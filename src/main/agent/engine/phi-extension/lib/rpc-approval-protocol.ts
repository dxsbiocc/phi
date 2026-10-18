import { createHash } from 'node:crypto'
import { posix } from 'node:path'

export const RPC_APPROVAL_TITLE = 'Phi main tool approval v1'
export const MAX_RPC_APPROVAL_BYTES = 128 * 1024
export interface RpcApprovalIdentity {
  nonce: string
  phiSessionId: string
  ompSessionId: string
  projectId: string
  cwd: string
  generation: number
  runId: string
}
export interface RpcApprovalEnvelope extends RpcApprovalIdentity {
  type: 'phi_rpc_tool_approval'
  protocolVersion: 1
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  inputDigest: string
}
export function approvalIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
    )
  )
}
export function validApprovalIdentity(value: RpcApprovalIdentity): boolean {
  return (
    [value.nonce, value.phiSessionId, value.ompSessionId, value.projectId, value.runId].every(
      approvalIdentifier
    ) &&
    value.nonce.length >= 16 &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    typeof value.cwd === 'string' &&
    value.cwd.startsWith('/') &&
    value.cwd.length < 4096 &&
    ![...value.cwd].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) &&
    posix.normalize(value.cwd) === value.cwd
  )
}
/** JSON-only, bounded and deterministic; rejects getters, unsafe keys and non-finite numbers. */
function canonical(value: unknown, depth = 0, limit = MAX_RPC_APPROVAL_BYTES): string {
  if (depth > 32) throw new Error('Approval input is too deeply nested')
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > limit)
      throw new Error('Invalid approval array')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.getOwnPropertyNames(value).length !== value.length + 1)
      throw new Error('Approval arrays must be dense JSON')
    const items: string[] = []
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !('value' in descriptor))
        throw new Error('Approval arrays cannot have accessors')
      items.push(canonical(descriptor.value, depth + 1, limit))
    }
    return `[${items.join(',')}]`
  }
  if (
    typeof value !== 'object' ||
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('Approval input must be plain JSON')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  // The real native edit tool attaches a memoized inspection Symbol to args.
  // It is not JSON input; include every string field, retaining no SDK cache metadata.
  return `{${Object.keys(descriptors)
    .sort()
    .map((key) => {
      const descriptor = descriptors[key]
      if (
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        !('value' in descriptor) ||
        !descriptor.enumerable
      )
        throw new Error('Invalid approval input field')
      return `${JSON.stringify(key)}:${canonical(descriptor.value, depth + 1, limit)}`
    })
    .join(',')}}`
}
function boundedJson(value: unknown, limit: number): string {
  const json = canonical(value, 0, limit)
  const bytes = Buffer.byteLength(json)
  if (bytes > limit)
    throw new Error(
      limit === MAX_RPC_APPROVAL_BYTES
        ? 'Approval input exceeds 128 KiB'
        : `Canonical JSON envelope is ${bytes} bytes, over its ${limit}-byte budget`
    )
  return json
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
export function createApprovalEnvelope(
  identity: RpcApprovalIdentity,
  toolCallId: string,
  toolName: string,
  input: unknown,
  /** Canonical JSON byte budget; approvals keep the 128 KiB default. */
  maxBytes: number = MAX_RPC_APPROVAL_BYTES
): RpcApprovalEnvelope {
  if (
    !validApprovalIdentity(identity) ||
    !approvalIdentifier(toolCallId) ||
    !approvalIdentifier(toolName) ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  )
    throw new Error('Invalid approval identity')
  const body = {
    type: 'phi_rpc_tool_approval' as const,
    protocolVersion: 1 as const,
    nonce: identity.nonce,
    phiSessionId: identity.phiSessionId,
    ompSessionId: identity.ompSessionId,
    projectId: identity.projectId,
    cwd: identity.cwd,
    generation: identity.generation,
    runId: identity.runId,
    toolCallId,
    toolName,
    input
  }
  const json = boundedJson(body, maxBytes)
  return freeze({
    ...JSON.parse(json),
    inputDigest: createHash('sha256').update(json).digest('hex')
  })
}
export function parseApprovalEnvelope(message: unknown): RpcApprovalEnvelope | undefined {
  if (typeof message !== 'string' || Buffer.byteLength(message) > MAX_RPC_APPROVAL_BYTES + 128)
    return undefined
  try {
    const parsed = JSON.parse(message)
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      parsed.type !== 'phi_rpc_tool_approval' ||
      parsed.protocolVersion !== 1
    )
      return undefined
    const keys = [
      'type',
      'protocolVersion',
      'nonce',
      'phiSessionId',
      'ompSessionId',
      'projectId',
      'cwd',
      'generation',
      'runId',
      'toolCallId',
      'toolName',
      'input',
      'inputDigest'
    ]
    if (
      Object.keys(parsed).length !== keys.length ||
      Object.keys(parsed).some((key) => !keys.includes(key))
    )
      return undefined
    const { nonce, phiSessionId, ompSessionId, projectId, cwd, generation, runId } = parsed
    const normalized = createApprovalEnvelope(
      { nonce, phiSessionId, ompSessionId, projectId, cwd, generation, runId },
      parsed.toolCallId,
      parsed.toolName,
      parsed.input
    )
    return normalized.inputDigest === parsed.inputDigest ? normalized : undefined
  } catch {
    return undefined
  }
}
export function sameApprovalIdentity(a: RpcApprovalIdentity, b: RpcApprovalIdentity): boolean {
  return (
    ['nonce', 'phiSessionId', 'ompSessionId', 'projectId', 'cwd', 'generation', 'runId'] as const
  ).every((key) => a[key] === b[key])
}
