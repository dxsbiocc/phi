import { createHmac, timingSafeEqual } from 'node:crypto'
import { posix } from 'node:path'

// Leave ample room below the 64 MiB server->desktop logical event ceiling.
export const MAX_HOST_RESULT_BYTES = 32 * 1024 * 1024
export const MAX_HOST_RESULT_FILE_BYTES = MAX_HOST_RESULT_BYTES + 16 * 1024
export const HOST_RESULT_FAILURE =
  'Phi host result delivery failed; complete result was not admitted'
export interface HostResultIdentity {
  leaseId: string
  generation: number
  phiSessionId: string
  projectId: string
  cwd: string
  runId: string
  invocationId: string
  toolCallId: string
  toolName: string
  /** Present only for a private progress snapshot, monotonically increasing per invocation. */
  progressSequence?: number
}
export interface HostResultReceipt extends HostResultIdentity {
  type: 'phi_host_result_receipt'
  version: 1
  receiptId: string
  bytes: number
  sha256: string
  mac: string
}
export interface HostResultPayload {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  details?: unknown
  isError?: boolean
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
}
export function validHostResultIdentity(value: HostResultIdentity): boolean {
  return (
    [
      value.leaseId,
      value.phiSessionId,
      value.projectId,
      value.runId,
      value.invocationId,
      value.toolCallId,
      value.toolName
    ].every(identifier) &&
    (value.progressSequence === undefined ||
      (Number.isSafeInteger(value.progressSequence) && value.progressSequence > 0)) &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    typeof value.cwd === 'string' &&
    value.cwd.startsWith('/') &&
    value.cwd.length < 4096 &&
    posix.normalize(value.cwd) === value.cwd &&
    ![...value.cwd].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
}
export function validHostResultPayload(value: unknown): value is HostResultPayload {
  return (
    record(value) &&
    Object.keys(value).every((key) => ['content', 'details', 'isError'].includes(key)) &&
    (value.isError === undefined || typeof value.isError === 'boolean') &&
    Array.isArray(value.content) &&
    value.content.every(
      (part) =>
        record(part) &&
        ((part.type === 'text' &&
          typeof part.text === 'string' &&
          Object.keys(part).every((key) => ['type', 'text'].includes(key))) ||
          (part.type === 'image' &&
            typeof part.data === 'string' &&
            typeof part.mimeType === 'string' &&
            Object.keys(part).every((key) => ['type', 'data', 'mimeType'].includes(key))))
    )
  )
}
/** Reject executable/coercible values instead of silently dropping fields through JSON.stringify. */
export function encodeHostResult(value: unknown): Buffer {
  let nodes = 0
  const ancestors = new Set<object>()
  function inspect(item: unknown, depth: number): void {
    if (++nodes > 1_000_000 || depth > 64) throw new Error('Host result JSON is too complex')
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'string') {
      if (item.length > MAX_HOST_RESULT_BYTES) throw new Error('Host result exceeds logical limit')
      return
    }
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (
      !item ||
      typeof item !== 'object' ||
      ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item)) ||
      ancestors.has(item)
    )
      throw new Error('Host result must contain plain JSON')
    ancestors.add(item)
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (Object.getOwnPropertySymbols(item).length)
      throw new Error('Host result cannot contain symbols')
    if (Array.isArray(item) && Object.keys(descriptors).length !== item.length + 1)
      throw new Error('Host result arrays must be dense')
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue
      if (
        !('value' in descriptor) ||
        !descriptor.enumerable ||
        ['__proto__', 'constructor', 'prototype'].includes(key)
      )
        throw new Error('Invalid host result JSON field')
      // Optional top-level fields follow the existing PhiToolResult contract.
      if (depth === 0 && ['details', 'isError'].includes(key) && descriptor.value === undefined)
        continue
      inspect(descriptor.value, depth + 1)
    }
    ancestors.delete(item)
  }
  inspect(value, 0)
  if (!validHostResultPayload(value)) throw new Error('Invalid host result schema')
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length > MAX_HOST_RESULT_BYTES)
    throw new Error('Host result exceeds 32 MiB logical limit')
  return bytes
}
function unsigned(receipt: Omit<HostResultReceipt, 'mac'>): string {
  return JSON.stringify([
    receipt.type,
    receipt.version,
    receipt.leaseId,
    receipt.generation,
    receipt.phiSessionId,
    receipt.projectId,
    receipt.cwd,
    receipt.runId,
    receipt.invocationId,
    receipt.toolCallId,
    receipt.toolName,
    receipt.receiptId,
    receipt.bytes,
    receipt.sha256,
    ...(receipt.progressSequence === undefined ? [] : ['progress', receipt.progressSequence])
  ])
}
export function signHostResultReceipt(
  receipt: Omit<HostResultReceipt, 'mac'>,
  capability: string
): HostResultReceipt {
  if (!/^[a-f0-9]{64}$/.test(capability) || !validHostResultIdentity(receipt))
    throw new Error('Invalid private host result binding')
  return {
    ...receipt,
    mac: createHmac('sha256', Buffer.from(capability, 'hex'))
      .update(unsigned(receipt))
      .digest('hex')
  }
}
export function parseHostResultReceipt(
  value: unknown,
  capability: string
): HostResultReceipt | undefined {
  if (
    !record(value) ||
    Object.keys(value).length !== (value.progressSequence === undefined ? 15 : 16) ||
    Object.keys(value).some(
      (key) =>
        ![
          'type',
          'version',
          'leaseId',
          'generation',
          'phiSessionId',
          'projectId',
          'cwd',
          'runId',
          'invocationId',
          'toolCallId',
          'toolName',
          'receiptId',
          'bytes',
          'sha256',
          'mac',
          'progressSequence'
        ].includes(key)
    ) ||
    value.type !== 'phi_host_result_receipt' ||
    value.version !== 1 ||
    !validHostResultIdentity(value as unknown as HostResultIdentity) ||
    typeof value.receiptId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.receiptId) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 2 ||
    (value.bytes as number) > MAX_HOST_RESULT_BYTES ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.mac !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.mac)
  )
    return undefined
  try {
    const receipt = value as unknown as HostResultReceipt
    const expected = signHostResultReceipt(receipt, capability).mac
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(receipt.mac, 'hex'))
      ? receipt
      : undefined
  } catch {
    return undefined
  }
}
export type HostResultLookupIdentity = Omit<HostResultIdentity, 'invocationId'>
/** Opaque lookup is known only to the private uploader and the trusted live server call. */
export function hostResultLookupId(identity: HostResultLookupIdentity, capability: string): string {
  if (
    !/^[a-f0-9]{64}$/.test(capability) ||
    !validHostResultIdentity({ ...identity, invocationId: 'lookup' })
  )
    throw new Error('Invalid private host result lookup binding')
  return createHmac('sha256', Buffer.from(capability, 'hex'))
    .update(
      JSON.stringify([
        'phi-host-result-file-v1',
        identity.leaseId,
        identity.generation,
        identity.phiSessionId,
        identity.projectId,
        identity.cwd,
        identity.runId,
        identity.toolCallId,
        identity.toolName,
        ...(identity.progressSequence === undefined ? [] : ['progress', identity.progressSequence])
      ])
    )
    .digest('hex')
}
export function encodeHostResultEnvelope(receipt: HostResultReceipt, payload: Buffer): Buffer {
  const bytes = Buffer.concat([
    Buffer.from(`{"receipt":${JSON.stringify(receipt)},"result":`),
    payload,
    Buffer.from('}')
  ])
  if (bytes.length > MAX_HOST_RESULT_FILE_BYTES)
    throw new Error('Host result envelope exceeds its supported file limit')
  return bytes
}
export function hostResultPlaceholder(nullDetails = false): HostResultPayload {
  return {
    content: [{ type: 'text', text: HOST_RESULT_FAILURE }],
    ...(nullDetails ? { details: null } : {}),
    isError: true
  }
}
export function isHostResultPlaceholder(content: HostResultPayload['content']): boolean {
  return (
    content.length === 1 && content[0].type === 'text' && content[0].text === HOST_RESULT_FAILURE
  )
}

const HOST_PROGRESS_PREFIX = 'Phi private host progress snapshot v1:'
export function hostProgressPlaceholder(sequence: number): HostResultPayload {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid progress sequence')
  return { content: [{ type: 'text', text: HOST_PROGRESS_PREFIX + sequence }] }
}
export function hostProgressSequence(content: HostResultPayload['content']): number | undefined {
  if (content.length !== 1 || content[0].type !== 'text') return undefined
  const text = content[0].text
  if (!text.startsWith(HOST_PROGRESS_PREFIX)) return undefined
  const sequence = Number(text.slice(HOST_PROGRESS_PREFIX.length))
  if (!Number.isSafeInteger(sequence) || sequence < 1 || text !== HOST_PROGRESS_PREFIX + sequence)
    throw new Error('Invalid progress sequence')
  return sequence
}
