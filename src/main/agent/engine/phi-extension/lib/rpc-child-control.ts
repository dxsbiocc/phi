import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { childConfigDigest, type RpcChildRuntimeConfig } from './rpc-child-config'
import {
  MAX_RPC_CHILD_CALLS,
  rpcChildRequestId,
  sameRpcChildScope,
  validateRpcChildScope,
  type RpcChildScope
} from './rpc-child-protocol'

export const RPC_CHILD_CONTROL_COMMAND = 'phi-rpc-child-control'
export const RPC_CHILD_CONTROL_DESCRIPTION =
  'Apply one authenticated Phi child control without invoking the parent model.'
const MAX_MESSAGE_BYTES = 20000
function plainMessage(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !!value.trim() &&
    Buffer.byteLength(value) <= MAX_MESSAGE_BYTES &&
    !/^[/!]/u.test(value.trimStart())
  )
}
interface Binding {
  readonly schema: 1
  readonly id: string
  readonly nonce: string
  readonly configHash: string
  readonly sequence: number
  readonly scope: RpcChildScope
  readonly messageDigest: string
}
export interface RpcChildSteerRequest extends Binding {
  readonly type: 'phi_rpc_child_control'
  readonly action: 'steer'
  readonly message: string
  readonly proof: string
}
export interface RpcChildControlAck extends Binding {
  readonly type: 'phi_rpc_child_control_ack'
  readonly action: 'steer'
  readonly accepted: boolean
  readonly proof: string
}
function signature(value: object, config: Readonly<RpcChildRuntimeConfig>): string {
  return createHmac('sha256', Buffer.from(config.capability, 'hex'))
    .update(JSON.stringify(value))
    .digest('hex')
}
function binding(value: Record<string, unknown>, config: Readonly<RpcChildRuntimeConfig>): Binding {
  const scope = validateRpcChildScope(value.scope)
  if (
    value.schema !== 1 ||
    !rpcChildRequestId(value.id) ||
    value.nonce !== config.nonce ||
    value.configHash !== childConfigDigest(config) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    Number(value.sequence) > MAX_RPC_CHILD_CALLS ||
    typeof value.messageDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.messageDigest) ||
    scope.phiSessionId !== config.phiSessionId ||
    scope.projectId !== config.projectId ||
    scope.cwd !== config.projectRoot ||
    scope.generation !== config.generation ||
    !config.profiles.some(
      (profile) =>
        profile.definition.nativeName === scope.nativeName &&
        profile.definition.definitionHash === scope.definitionHash
    )
  ) {
    throw new Error('Invalid Phi child control binding')
  }
  return {
    schema: 1,
    id: value.id,
    nonce: config.nonce,
    configHash: childConfigDigest(config),
    sequence: Number(value.sequence),
    scope,
    messageDigest: value.messageDigest
  }
}
function validProof(
  value: object,
  proof: unknown,
  config: Readonly<RpcChildRuntimeConfig>
): boolean {
  if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/u.test(proof)) return false
  return timingSafeEqual(Buffer.from(signature(value, config), 'hex'), Buffer.from(proof, 'hex'))
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Phi child control')
  return value as Record<string, unknown>
}
export function createRpcChildSteerRequest(
  config: Readonly<RpcChildRuntimeConfig>,
  scope: RpcChildScope,
  sequence: number,
  message: string
): Readonly<RpcChildSteerRequest> {
  if (!plainMessage(message))
    throw new Error('Phi child steering requires a plain-text instruction')
  const input = binding(
    {
      schema: 1,
      id: randomUUID(),
      nonce: config.nonce,
      configHash: childConfigDigest(config),
      sequence,
      scope,
      messageDigest: createHash('sha256').update(message).digest('hex')
    },
    config
  )
  const body = {
    ...input,
    type: 'phi_rpc_child_control' as const,
    action: 'steer' as const,
    message
  }
  const request = Object.freeze({ ...body, proof: signature(body, config) })
  if (Buffer.byteLength(JSON.stringify(request)) > 32768)
    throw new Error('Phi child control exceeds its bound')
  return request
}
export function parseRpcChildSteerRequest(
  args: string,
  config: Readonly<RpcChildRuntimeConfig>
): Readonly<RpcChildSteerRequest> {
  if (Buffer.byteLength(args) > 32768) throw new Error('Phi child control exceeds its bound')
  const value = record(JSON.parse(args))
  const input = binding(value, config)
  if (
    Object.keys(value).length !== 11 ||
    value.type !== 'phi_rpc_child_control' ||
    value.action !== 'steer' ||
    !plainMessage(value.message) ||
    createHash('sha256').update(value.message).digest('hex') !== input.messageDigest
  )
    throw new Error('Invalid Phi child steer control')
  const body = {
    ...input,
    type: 'phi_rpc_child_control' as const,
    action: 'steer' as const,
    message: value.message
  }
  if (!validProof(body, value.proof, config))
    throw new Error('Phi child control authentication failed')
  return Object.freeze({ ...body, proof: value.proof as string })
}
export function createRpcChildControlAck(
  request: Readonly<RpcChildSteerRequest>,
  config: Readonly<RpcChildRuntimeConfig>,
  accepted = true
): Readonly<RpcChildControlAck> {
  const input = binding(request as unknown as Record<string, unknown>, config)
  const body = {
    ...input,
    type: 'phi_rpc_child_control_ack' as const,
    action: 'steer' as const,
    accepted
  }
  return Object.freeze({ ...body, proof: signature(body, config) })
}
export function parseRpcChildControlAck(
  content: unknown,
  request: Readonly<RpcChildSteerRequest>,
  config: Readonly<RpcChildRuntimeConfig>
): Readonly<RpcChildControlAck> | undefined {
  try {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 16384) return undefined
    const value = record(JSON.parse(content))
    const input = binding(value, config)
    const body = {
      ...input,
      type: 'phi_rpc_child_control_ack' as const,
      action: 'steer' as const,
      accepted: value.accepted === true
    }
    const valid =
      Object.keys(value).length === 11 &&
      value.type === body.type &&
      value.action === 'steer' &&
      typeof value.accepted === 'boolean' &&
      input.id === request.id &&
      input.sequence === request.sequence &&
      input.messageDigest === request.messageDigest &&
      sameRpcChildScope(input.scope, request.scope) &&
      validProof(body, value.proof, config)
    return valid ? Object.freeze({ ...body, proof: value.proof as string }) : undefined
  } catch {
    return undefined
  }
}
export function verifyRpcChildControlAck(
  content: unknown,
  request: Readonly<RpcChildSteerRequest>,
  config: Readonly<RpcChildRuntimeConfig>
): boolean {
  return parseRpcChildControlAck(content, request, config)?.accepted === true
}
