import { createHmac, timingSafeEqual } from 'node:crypto'
import { posix } from 'node:path'
import { childConfigDigest, type RpcChildRuntimeConfig } from './rpc-child-config'
import {
  sameRpcChildRoot,
  validateRpcChildRoot,
  type RpcChildRootScope
} from './rpc-child-protocol'

export const RPC_CHILD_HOST_START_COMMAND = 'phi-rpc-child-host-start'
export const RPC_CHILD_HOST_START_DESCRIPTION = 'Start one authenticated Phi plan child while idle.'
export const RPC_CHILD_HOST_CANCEL_COMMAND = 'phi-rpc-child-host-cancel'
export const RPC_CHILD_HOST_CANCEL_DESCRIPTION = 'Cancel and reconcile one Phi host child request.'
const MAX_REQUEST_BYTES = 70 * 1024
const MAX_RECEIPT_BYTES = 16 * 1024

interface Binding {
  readonly schema: 1
  readonly nonce: string
  readonly configHash: string
  readonly id: string
  readonly root: RpcChildRootScope
  readonly agent: string
}

export interface RpcChildHostStartRequest extends Binding {
  readonly type: 'phi_rpc_child_host_start'
  readonly task: string
  readonly proof: string
}

export interface RpcChildHostStartReceipt extends Binding {
  readonly type: 'phi_rpc_child_host_start_receipt'
  readonly nativeId: string
  readonly parentToolCallId: string
  readonly childSessionFile: string
  readonly detached: true
  readonly proof: string
}

export interface RpcChildHostCancelReceipt extends Binding {
  readonly type: 'phi_rpc_child_host_cancel_receipt'
  readonly state: 'quiescent' | 'unknown'
  readonly nativeIds: readonly string[]
  readonly proof: string
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Phi child host start payload')
  return value as Record<string, unknown>
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
}
function requestId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value)
}

function sign(value: object, config: Readonly<RpcChildRuntimeConfig>): string {
  return createHmac('sha256', Buffer.from(config.capability, 'hex'))
    .update(JSON.stringify(value))
    .digest('hex')
}

function verify(value: object, proof: unknown, config: Readonly<RpcChildRuntimeConfig>): boolean {
  return (
    typeof proof === 'string' &&
    /^[a-f0-9]{64}$/u.test(proof) &&
    timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(sign(value, config), 'hex'))
  )
}

function binding(
  value: Record<string, unknown>,
  config: Readonly<RpcChildRuntimeConfig>,
  expectedRoot: Readonly<RpcChildRootScope>
): Binding {
  const root = validateRpcChildRoot(value.root)
  if (
    value.schema !== 1 ||
    value.nonce !== config.nonce ||
    value.configHash !== childConfigDigest(config) ||
    !requestId(value.id) ||
    !identifier(value.agent) ||
    !sameRpcChildRoot(root, expectedRoot) ||
    root.phiSessionId !== config.phiSessionId ||
    root.projectId !== config.projectId ||
    root.cwd !== config.projectRoot ||
    root.generation !== config.generation ||
    !config.profiles.some(
      (profile) => profile.definition.nativeName === value.agent && !profile.definition.blocking
    )
  )
    throw new Error('Phi child host start binding changed')
  return {
    schema: 1,
    nonce: config.nonce,
    configHash: childConfigDigest(config),
    id: value.id,
    root,
    agent: value.agent
  }
}

export function createRpcChildHostStartRequest(
  config: Readonly<RpcChildRuntimeConfig>,
  root: Readonly<RpcChildRootScope>,
  id: string,
  agent: string,
  task: string
): Readonly<RpcChildHostStartRequest> {
  if (typeof task !== 'string' || !task.trim() || Buffer.byteLength(task) > 65536)
    throw new Error('Invalid Phi child host task')
  const base = binding(
    {
      schema: 1,
      nonce: config.nonce,
      configHash: childConfigDigest(config),
      id,
      root,
      agent
    },
    config,
    root
  )
  const body = { ...base, type: 'phi_rpc_child_host_start' as const, task }
  const request = Object.freeze({ ...body, proof: sign(body, config) })
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES)
    throw new Error('Phi child host request is too large')
  return request
}

export function parseRpcChildHostStartRequest(
  raw: string,
  config: Readonly<RpcChildRuntimeConfig>,
  root: Readonly<RpcChildRootScope>
): Readonly<RpcChildHostStartRequest> {
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES)
    throw new Error('Phi child host request is too large')
  const value = object(JSON.parse(raw))
  const base = binding(value, config, root)
  if (
    Object.keys(value).length !== 9 ||
    value.type !== 'phi_rpc_child_host_start' ||
    typeof value.task !== 'string' ||
    !value.task.trim() ||
    Buffer.byteLength(value.task) > 65536
  )
    throw new Error('Invalid Phi child host request')
  const body = { ...base, type: 'phi_rpc_child_host_start' as const, task: value.task }
  if (!verify(body, value.proof, config))
    throw new Error('Phi child host request authentication failed')
  return Object.freeze({ ...body, proof: value.proof as string })
}

export function makeRpcChildHostStartReceipt(
  request: Readonly<RpcChildHostStartRequest>,
  config: Readonly<RpcChildRuntimeConfig>,
  child: {
    readonly nativeId: string
    readonly parentToolCallId: string
    readonly childSessionFile: string
  }
): Readonly<RpcChildHostStartReceipt> {
  const base = binding(request as unknown as Record<string, unknown>, config, request.root)
  if (
    !identifier(child.nativeId) ||
    !identifier(child.parentToolCallId) ||
    typeof child.childSessionFile !== 'string' ||
    posix.dirname(child.childSessionFile) !== request.root.rootSessionFile.slice(0, -6) ||
    !child.childSessionFile.endsWith('.jsonl')
  )
    throw new Error('Invalid Phi child host start result')
  const body = {
    ...base,
    type: 'phi_rpc_child_host_start_receipt' as const,
    ...child,
    detached: true as const
  }
  return Object.freeze({ ...body, proof: sign(body, config) })
}

export function parseRpcChildHostStartReceipt(
  raw: string,
  request: Readonly<RpcChildHostStartRequest>,
  config: Readonly<RpcChildRuntimeConfig>
): Readonly<RpcChildHostStartReceipt> {
  if (Buffer.byteLength(raw) > MAX_RECEIPT_BYTES)
    throw new Error('Phi child host receipt is too large')
  const value = object(JSON.parse(raw))
  const base = binding(value, config, request.root)
  if (
    Object.keys(value).length !== 12 ||
    value.type !== 'phi_rpc_child_host_start_receipt' ||
    value.id !== request.id ||
    value.agent !== request.agent ||
    !identifier(value.nativeId) ||
    value.parentToolCallId !== request.id ||
    typeof value.childSessionFile !== 'string' ||
    posix.dirname(value.childSessionFile) !== request.root.rootSessionFile.slice(0, -6) ||
    !value.childSessionFile.endsWith('.jsonl') ||
    value.detached !== true
  )
    throw new Error('Invalid Phi child host receipt')
  const body = {
    ...base,
    type: 'phi_rpc_child_host_start_receipt' as const,
    nativeId: value.nativeId,
    parentToolCallId: value.parentToolCallId,
    childSessionFile: value.childSessionFile,
    detached: true as const
  }
  if (!verify(body, value.proof, config))
    throw new Error('Phi child host receipt authentication failed')
  return Object.freeze({ ...body, proof: value.proof as string })
}

export function makeRpcChildHostCancelReceipt(
  request: Readonly<RpcChildHostStartRequest>,
  config: Readonly<RpcChildRuntimeConfig>,
  state: 'quiescent' | 'unknown',
  nativeIds: readonly string[]
): Readonly<RpcChildHostCancelReceipt> {
  const base = binding(request as unknown as Record<string, unknown>, config, request.root)
  if (nativeIds.length > 32 || nativeIds.some((id) => !identifier(id)))
    throw new Error('Invalid Phi host child cancellation targets')
  const body = {
    ...base,
    type: 'phi_rpc_child_host_cancel_receipt' as const,
    state,
    nativeIds: [...nativeIds]
  }
  return Object.freeze({ ...body, proof: sign(body, config) })
}

export function parseRpcChildHostCancelReceipt(
  raw: string,
  request: Readonly<RpcChildHostStartRequest>,
  config: Readonly<RpcChildRuntimeConfig>
): Readonly<RpcChildHostCancelReceipt> {
  if (Buffer.byteLength(raw) > MAX_RECEIPT_BYTES)
    throw new Error('Phi child host cancellation receipt is too large')
  const value = object(JSON.parse(raw))
  const base = binding(value, config, request.root)
  if (
    Object.keys(value).length !== 10 ||
    value.type !== 'phi_rpc_child_host_cancel_receipt' ||
    value.id !== request.id ||
    value.agent !== request.agent ||
    (value.state !== 'quiescent' && value.state !== 'unknown') ||
    !Array.isArray(value.nativeIds) ||
    value.nativeIds.length > 32 ||
    value.nativeIds.some((id: unknown) => !identifier(id))
  )
    throw new Error('Invalid Phi child host cancellation receipt')
  const body = {
    ...base,
    type: 'phi_rpc_child_host_cancel_receipt' as const,
    state: value.state as 'quiescent' | 'unknown',
    nativeIds: value.nativeIds as string[]
  }
  if (!verify(body, value.proof, config))
    throw new Error('Phi child host cancellation receipt authentication failed')
  return Object.freeze({ ...body, proof: value.proof as string })
}
