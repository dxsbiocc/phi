import { createHmac, timingSafeEqual } from 'node:crypto'
import { approvalIdentifier, createApprovalEnvelope } from './rpc-approval-protocol'
import { executionCapability } from './rpc-execution-protocol'
import { childConfigDigest, type RpcChildRuntimeConfig } from './rpc-child-config'
import {
  sameRpcChildRoot,
  validateRpcChildRoot,
  type RpcChildRootScope
} from './rpc-child-protocol'
export const RPC_TASK_LAUNCH_TYPE = 'phi_rpc_task_launch'
export const MAX_RPC_TASK_LAUNCH_BYTES = 16 * 1024
const DOMAIN = 'phi-task-launch-v1\0'
export interface RpcTaskLaunchReceipt {
  readonly type: typeof RPC_TASK_LAUNCH_TYPE
  readonly schema: 1
  readonly nonce: string
  readonly configHash: string
  readonly manifestHash: string
  readonly root: RpcChildRootScope
  readonly parentRunId: string
  readonly controlSequence: number
  readonly toolCallId: string
  readonly inputDigest: string
  readonly declaredTaskCount: number
  readonly expectedTaskCount: number
  readonly dispatchSealed: boolean
  readonly hmac: string
}
export type RpcTaskLaunchCall = Pick<
  RpcTaskLaunchReceipt,
  | 'parentRunId'
  | 'controlSequence'
  | 'toolCallId'
  | 'inputDigest'
  | 'declaredTaskCount'
  | 'expectedTaskCount'
  | 'dispatchSealed'
>
function canonical(value: unknown): Record<string, unknown> {
  const body = createApprovalEnvelope(
    {
      nonce: 'phi-rpc-task-launch-v1',
      phiSessionId: 'launch',
      projectId: 'launch',
      cwd: '/',
      generation: 1,
      ompSessionId: 'launch',
      runId: 'launch'
    },
    'launch',
    'task',
    value
  ).input
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_RPC_TASK_LAUNCH_BYTES)
    throw new Error('Task launch receipt exceeded its bound')
  return body
}
function body(value: unknown): Omit<RpcTaskLaunchReceipt, 'hmac'> {
  const raw = canonical(value)
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
    'declaredTaskCount',
    'expectedTaskCount',
    'dispatchSealed'
  ]
  if (
    Object.keys(raw).sort().join(',') !== keys.sort().join(',') ||
    raw.type !== RPC_TASK_LAUNCH_TYPE ||
    raw.schema !== 1 ||
    !approvalIdentifier(raw.nonce) ||
    !executionCapability(raw.configHash) ||
    !executionCapability(raw.manifestHash) ||
    !approvalIdentifier(raw.parentRunId) ||
    !approvalIdentifier(raw.toolCallId) ||
    !executionCapability(raw.inputDigest) ||
    !Number.isSafeInteger(raw.controlSequence) ||
    Number(raw.controlSequence) < 1 ||
    !Number.isSafeInteger(raw.declaredTaskCount) ||
    Number(raw.declaredTaskCount) < 1 ||
    Number(raw.declaredTaskCount) > 32 ||
    !Number.isSafeInteger(raw.expectedTaskCount) ||
    Number(raw.expectedTaskCount) < 0 ||
    Number(raw.expectedTaskCount) > Number(raw.declaredTaskCount) ||
    typeof raw.dispatchSealed !== 'boolean' ||
    (!raw.dispatchSealed && raw.expectedTaskCount !== raw.declaredTaskCount)
  )
    throw new Error('Invalid authenticated task launch receipt')
  return Object.freeze({ ...raw, root: validateRpcChildRoot(raw.root) }) as unknown as Omit<
    RpcTaskLaunchReceipt,
    'hmac'
  >
}
function sign(value: unknown, capability: string): Buffer {
  if (!executionCapability(capability))
    throw new Error('Task launch receipt lacks private authority')
  return createHmac('sha256', Buffer.from(capability, 'hex'))
    .update(DOMAIN)
    .update(JSON.stringify(canonical(value)))
    .digest()
}
export function makeRpcTaskLaunchReceipt(
  config: Readonly<RpcChildRuntimeConfig>,
  root: Readonly<RpcChildRootScope>,
  call: RpcTaskLaunchCall
): Readonly<RpcTaskLaunchReceipt> {
  const scope = validateRpcChildRoot(root)
  if (
    scope.phiSessionId !== config.phiSessionId ||
    scope.projectId !== config.projectId ||
    scope.cwd !== config.projectRoot ||
    scope.generation !== config.generation
  )
    throw new Error('Task launch root differs from its compiler policy')
  const value = body({
    type: RPC_TASK_LAUNCH_TYPE,
    schema: 1,
    nonce: config.nonce,
    configHash: childConfigDigest(config),
    manifestHash: config.manifestHash,
    root: scope,
    ...call
  })
  const result = Object.freeze({ ...value, hmac: sign(value, config.capability).toString('hex') })
  if (JSON.stringify(result).includes(config.capability))
    throw new Error('Private task launch capability cannot enter its receipt')
  return result
}
export function parseRpcTaskLaunchReceipt(
  content: unknown,
  config: Readonly<RpcChildRuntimeConfig>,
  root: Readonly<RpcChildRootScope>
): Readonly<RpcTaskLaunchReceipt> | undefined {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_RPC_TASK_LAUNCH_BYTES)
    return undefined
  try {
    const raw = canonical(JSON.parse(content))
    if (!executionCapability(raw.hmac)) return undefined
    const { hmac, ...values } = raw,
      value = body(values)
    if (
      value.nonce !== config.nonce ||
      value.configHash !== childConfigDigest(config) ||
      value.manifestHash !== config.manifestHash ||
      !sameRpcChildRoot(value.root, validateRpcChildRoot(root)) ||
      !timingSafeEqual(Buffer.from(hmac, 'hex'), sign(value, config.capability))
    )
      return undefined
    return Object.freeze({ ...value, hmac })
  } catch {
    return undefined
  }
}
