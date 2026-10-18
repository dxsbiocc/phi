import { createHmac, timingSafeEqual } from 'node:crypto'
import { approvalIdentifier, createApprovalEnvelope } from './rpc-approval-protocol'
import { toolCallIdentifier } from './rpc-tool-call-id'
import { childConfigDigest, type RpcChildRuntimeConfig } from './rpc-child-config'
import {
  sameRpcChildRoot,
  validateRpcChildRoot,
  type RpcChildRootScope
} from './rpc-child-protocol'
import { executionCapability } from './rpc-execution-protocol'

export const RPC_TASK_SETTLEMENT_TYPE = 'phi_rpc_task_settlement'
export const RPC_TASK_SETTLEMENT_DOMAIN = 'phi-task-settlement-v1\0'
export const MAX_RPC_TASK_SETTLEMENT_BYTES = 16 * 1024
export interface RpcTaskSettlement {
  readonly type: typeof RPC_TASK_SETTLEMENT_TYPE
  readonly schema: 1
  readonly nonce: string
  readonly configHash: string
  readonly manifestHash: string
  readonly root: RpcChildRootScope
  readonly parentRunId: string
  readonly controlSequence: number
  readonly toolCallId: string
  readonly inputDigest: string
  readonly outcome: 'no-spawn'
  readonly hmac: string
}
type SettlementBody = Omit<RpcTaskSettlement, 'hmac'>
type SettlementCall = Pick<
  RpcTaskSettlement,
  'parentRunId' | 'controlSequence' | 'toolCallId' | 'inputDigest'
>
const keys = [
  'type',
  'schema',
  'nonce',
  'configHash',
  'manifestHash',
  'root',
  'parentRunId',
  'controlSequence',
  'toolCallId',
  'inputDigest',
  'outcome'
]
const canonicalIdentity = {
  nonce: 'task-settlement-v1',
  phiSessionId: 'settlement',
  ompSessionId: 'settlement',
  projectId: 'settlement',
  cwd: '/',
  generation: 1,
  runId: 'settlement'
}
function canonical(value: unknown): Record<string, unknown> {
  const snapshot = createApprovalEnvelope(canonicalIdentity, 'settlement', 'task', value).input
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_RPC_TASK_SETTLEMENT_BYTES)
    throw new Error('Task settlement exceeds its wire budget')
  return snapshot
}
function body(value: unknown): SettlementBody {
  const item = canonical(value)
  if (
    Object.keys(item).length !== keys.length ||
    Object.keys(item).some((key) => !keys.includes(key)) ||
    item.type !== RPC_TASK_SETTLEMENT_TYPE ||
    item.schema !== 1 ||
    !approvalIdentifier(item.nonce) ||
    item.nonce.length < 16 ||
    !executionCapability(item.configHash) ||
    !executionCapability(item.manifestHash) ||
    !approvalIdentifier(item.parentRunId) ||
    !toolCallIdentifier(item.toolCallId) ||
    !executionCapability(item.inputDigest) ||
    !Number.isSafeInteger(item.controlSequence) ||
    Number(item.controlSequence) < 1 ||
    item.outcome !== 'no-spawn'
  )
    throw new Error('Invalid task settlement')
  const root = validateRpcChildRoot(item.root)
  return Object.freeze({ ...item, root }) as unknown as SettlementBody
}
function proof(value: SettlementBody, capability: string): Buffer {
  return createHmac('sha256', Buffer.from(capability, 'hex'))
    .update(RPC_TASK_SETTLEMENT_DOMAIN)
    .update(JSON.stringify(canonical(value)))
    .digest()
}
function configRoot(config: Readonly<RpcChildRuntimeConfig>, root: RpcChildRootScope): void {
  if (
    !executionCapability(config.capability) ||
    root.phiSessionId !== config.phiSessionId ||
    root.projectId !== config.projectId ||
    root.cwd !== config.projectRoot ||
    root.generation !== config.generation
  )
    throw new Error('Task settlement config differs from its root')
}
export function makeRpcTaskSettlement(
  config: Readonly<RpcChildRuntimeConfig>,
  root: Readonly<RpcChildRootScope>,
  call: SettlementCall
): Readonly<RpcTaskSettlement> {
  const scope = validateRpcChildRoot(root)
  configRoot(config, scope)
  const args = canonical(call)
  const callKeys = ['parentRunId', 'controlSequence', 'toolCallId', 'inputDigest']
  if (
    Object.keys(args).length !== callKeys.length ||
    Object.keys(args).some((key) => !callKeys.includes(key))
  )
    throw new Error('Invalid task settlement call')
  const message = body({
    type: RPC_TASK_SETTLEMENT_TYPE,
    schema: 1,
    nonce: config.nonce,
    configHash: childConfigDigest(config),
    manifestHash: config.manifestHash,
    root: scope,
    ...args,
    outcome: 'no-spawn'
  })
  const signed = Object.freeze({
    ...message,
    hmac: proof(message, config.capability).toString('hex')
  })
  const wire = JSON.stringify(signed)
  if (Buffer.byteLength(wire) > MAX_RPC_TASK_SETTLEMENT_BYTES || wire.includes(config.capability))
    throw new Error('Invalid private task settlement wire')
  return signed
}
export function parseRpcTaskSettlement(
  value: unknown,
  capability: string
): Readonly<RpcTaskSettlement> | undefined {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > MAX_RPC_TASK_SETTLEMENT_BYTES ||
    !executionCapability(capability)
  )
    return undefined
  try {
    const signed = canonical(JSON.parse(value))
    if (!executionCapability(signed.hmac)) return undefined
    const { hmac, ...raw } = signed
    const message = body(raw)
    if (!timingSafeEqual(proof(message, capability), Buffer.from(hmac, 'hex'))) return undefined
    return Object.freeze({ ...message, hmac })
  } catch {
    return undefined
  }
}
export function verifyRpcTaskSettlement(
  value: unknown,
  config: Readonly<RpcChildRuntimeConfig>,
  root: Readonly<RpcChildRootScope>
): Readonly<RpcTaskSettlement> | undefined {
  try {
    const scope = validateRpcChildRoot(root)
    configRoot(config, scope)
    const message = parseRpcTaskSettlement(value, config.capability)
    return message &&
      message.nonce === config.nonce &&
      message.configHash === childConfigDigest(config) &&
      message.manifestHash === config.manifestHash &&
      sameRpcChildRoot(message.root, scope)
      ? message
      : undefined
  } catch {
    return undefined
  }
}
