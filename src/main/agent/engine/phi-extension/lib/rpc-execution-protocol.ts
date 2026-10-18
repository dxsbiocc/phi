import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  approvalIdentifier,
  createApprovalEnvelope,
  validApprovalIdentity,
  type RpcApprovalIdentity
} from './rpc-approval-protocol'

export const RPC_EXECUTION_COMMAND = 'phi-rpc-execution-authority'
export const RPC_EXECUTION_DESCRIPTION = 'Phi main execution authority v1'
export const MAX_EXECUTION_CALLS = 4096
/**
 * The roster is derived from the set_host_tools payload, so it shares that 1 MiB wire budget
 * (MAX_RPC_FRAME_BYTES); approvals keep their own smaller 128 KiB cap.
 */
export const MAX_EXECUTION_ROSTER_ENVELOPE_BYTES = 1024 * 1024
/** Real MCP schemas nest deeply ($defs, anyOf, items); the roster wraps them in five levels. */
export const MAX_EXECUTION_ROSTER_DEPTH = 128
export type RpcExecutionIdentity = Omit<RpcApprovalIdentity, 'runId'>
export type RpcExecutionLaunchIdentity = Omit<RpcExecutionIdentity, 'ompSessionId'>
export interface RpcExecutionTool {
  name: string
  site: 'native' | 'host'
  parameters?: Record<string, unknown>
}
interface ExecutionBinding extends RpcApprovalIdentity {
  protocolVersion: 1
  rosterHash: string
  sequence: number
}
export interface RpcExecutionControl extends ExecutionBinding {
  type: 'phi_rpc_execution_control'
  action: 'activate' | 'begin' | 'end'
  requestId: string
}
export interface RpcExecutionAck extends Omit<RpcExecutionControl, 'type'> {
  type: 'phi_rpc_execution_ack'
}
export interface RpcExecutionOrigin extends ExecutionBinding {
  type: 'phi_rpc_execution_origin'
  originSequence: number
  toolCallId: string
  toolName: string
  inputDigest: string
}
export interface RpcExecutionRetired extends ExecutionBinding {
  type: 'phi_rpc_execution_retired'
  reason: 'finished' | 'session-change' | 'shutdown'
}
export type RpcExecutionMessage =
  RpcExecutionControl | RpcExecutionAck | RpcExecutionOrigin | RpcExecutionRetired
export type SignedExecutionMessage<T extends RpcExecutionMessage = RpcExecutionMessage> = T & {
  proof: string
}
const digestPattern = /^[a-f0-9]{64}$/u
const canonicalIdentity: RpcApprovalIdentity = {
  nonce: '0123456789abcdef',
  phiSessionId: 'execution',
  ompSessionId: 'execution',
  projectId: 'execution',
  cwd: '/',
  generation: 1,
  runId: 'execution'
}

function digest(value: Record<string, unknown>): string {
  return createApprovalEnvelope(canonicalIdentity, 'execution', 'execution', value).inputDigest
}
export function executionCapability(value: unknown): value is string {
  return typeof value === 'string' && digestPattern.test(value)
}
export function executionLaunchIdentity(
  value: RpcExecutionLaunchIdentity
): Readonly<RpcExecutionLaunchIdentity> {
  const keys = ['nonce', 'phiSessionId', 'projectId', 'cwd', 'generation']
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    !validApprovalIdentity({ ...value, ompSessionId: 'validate', runId: 'validate' })
  )
    throw new Error('Invalid execution launch identity')
  return Object.freeze({ ...value })
}
export function executionBinding(control: RpcExecutionControl): ExecutionBinding {
  const {
    nonce,
    phiSessionId,
    ompSessionId,
    projectId,
    cwd,
    generation,
    runId,
    protocolVersion,
    rosterHash,
    sequence
  } = control
  return {
    nonce,
    phiSessionId,
    ompSessionId,
    projectId,
    cwd,
    generation,
    runId,
    protocolVersion,
    rosterHash,
    sequence
  }
}
export function executionRoster(
  tools: readonly RpcExecutionTool[],
  options: { readonly allowNativeTask?: boolean } = {}
): {
  tools: readonly RpcExecutionTool[]
  hash: string
} {
  if (!Array.isArray(tools) || !tools.length || tools.length > 256)
    throw new Error('Invalid execution roster')
  const names = new Set<string>()
  const native = new Set(['read', 'write', 'edit', 'bash', 'powershell', 'glob', 'grep'])
  if (options.allowNativeTask === true) native.add('task')
  const copy = tools
    .map((tool) => {
      if (
        !approvalIdentifier(tool.name) ||
        names.has(tool.name) ||
        !['native', 'host'].includes(tool.site) ||
        (tool.site === 'native' && !native.has(tool.name)) ||
        (tool.site === 'host' && tool.name === 'task') ||
        (tool.site === 'host' && native.has(tool.name)) ||
        (tool.site === 'host' &&
          (!tool.parameters ||
            Array.isArray(tool.parameters) ||
            typeof tool.parameters !== 'object'))
      )
        throw new Error('Invalid execution roster')
      names.add(tool.name)
      return {
        name: tool.name,
        site: tool.site,
        ...(tool.site === 'host' ? { parameters: tool.parameters } : {})
      }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  let envelope: ReturnType<typeof createApprovalEnvelope>
  try {
    envelope = createApprovalEnvelope(
      canonicalIdentity,
      'roster',
      'roster',
      { tools: copy },
      MAX_EXECUTION_ROSTER_ENVELOPE_BYTES,
      MAX_EXECUTION_ROSTER_DEPTH
    )
  } catch (error) {
    throw new Error(
      `Execution roster exceeds its supported ${MAX_EXECUTION_ROSTER_ENVELOPE_BYTES}-byte canonical JSON envelope or is not valid JSON (${error instanceof Error ? error.message : 'unknown'})`
    )
  }
  return { tools: envelope.input.tools as readonly RpcExecutionTool[], hash: envelope.inputDigest }
}
/** Same top-level union projection as Phi pickDeclaredToolInput; no nested-data rewriting. */
export function executionInput(tool: RpcExecutionTool, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid execution input')
  if (tool.site === 'native')
    return createApprovalEnvelope(canonicalIdentity, 'input', 'input', input).input
  const fields = new Set<string>()
  const seen = new Set<object>()
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) return
    seen.add(value)
    const schema = value as Record<string, unknown>
    if (
      schema.properties &&
      typeof schema.properties === 'object' &&
      !Array.isArray(schema.properties)
    )
      for (const key of Object.keys(schema.properties)) fields.add(key)
    for (const key of ['oneOf', 'anyOf', 'allOf'])
      if (Array.isArray(schema[key])) for (const branch of schema[key]) collect(branch)
  }
  collect(tool.parameters)
  return createApprovalEnvelope(
    canonicalIdentity,
    'input',
    'input',
    Object.fromEntries(Object.entries(input).filter(([key]) => fields.has(key)))
  ).input
}
export function signExecutionMessage<T extends RpcExecutionMessage>(
  message: T,
  capability: string
): SignedExecutionMessage<T> {
  if (!executionCapability(capability)) throw new Error('Invalid execution capability')
  const proof = createHmac('sha256', Buffer.from(capability, 'hex'))
    .update(digest({ ...message }))
    .digest('hex')
  const signed: SignedExecutionMessage<T> = { ...message, proof }
  Object.freeze(signed)
  const wire = JSON.stringify(signed)
  if (wire.includes(capability) || !parseExecutionMessage(wire, capability))
    throw new Error('Invalid execution message')
  return signed
}
export function parseExecutionMessage(
  value: unknown,
  capability: string
): SignedExecutionMessage | undefined {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > 16384 ||
    !executionCapability(capability)
  )
    return undefined
  try {
    const m = JSON.parse(value)
    if (
      !m ||
      typeof m !== 'object' ||
      Array.isArray(m) ||
      m.protocolVersion !== 1 ||
      !validApprovalIdentity(m) ||
      typeof m.rosterHash !== 'string' ||
      !digestPattern.test(m.rosterHash) ||
      !Number.isSafeInteger(m.sequence) ||
      m.sequence < 1 ||
      typeof m.proof !== 'string' ||
      !digestPattern.test(m.proof)
    )
      return undefined
    const common = [
      'type',
      'protocolVersion',
      'nonce',
      'phiSessionId',
      'ompSessionId',
      'projectId',
      'cwd',
      'generation',
      'runId',
      'rosterHash',
      'sequence',
      'proof'
    ]
    let fields: string[]
    if (m.type === 'phi_rpc_execution_control' || m.type === 'phi_rpc_execution_ack') {
      if (!['activate', 'begin', 'end'].includes(m.action) || !approvalIdentifier(m.requestId))
        return undefined
      fields = ['action', 'requestId']
    } else if (m.type === 'phi_rpc_execution_origin') {
      if (
        !approvalIdentifier(m.toolCallId) ||
        !approvalIdentifier(m.toolName) ||
        typeof m.inputDigest !== 'string' ||
        !digestPattern.test(m.inputDigest) ||
        !Number.isSafeInteger(m.originSequence) ||
        m.originSequence < 1
      )
        return undefined
      fields = ['originSequence', 'toolCallId', 'toolName', 'inputDigest']
    } else if (m.type === 'phi_rpc_execution_retired') {
      if (!['finished', 'session-change', 'shutdown'].includes(m.reason)) return undefined
      fields = ['reason']
    } else return undefined
    const keys = [...common, ...fields]
    if (Object.keys(m).length !== keys.length || Object.keys(m).some((key) => !keys.includes(key)))
      return undefined
    const { proof, ...body } = m
    const expected = createHmac('sha256', Buffer.from(capability, 'hex'))
      .update(digest(body))
      .digest()
    if (!timingSafeEqual(expected, Buffer.from(proof, 'hex'))) return undefined
    return Object.freeze(m)
  } catch {
    return undefined
  }
}
