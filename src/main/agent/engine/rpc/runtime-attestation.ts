import type { RpcConnection } from './connection'
import { executionRoster } from '../phi-extension/lib/rpc-execution-protocol'
import {
  RPC_RUNTIME_COMMAND,
  RPC_RUNTIME_DESCRIPTION,
  rpcRuntimeConfigDigest,
  type RpcRuntimeConfig
} from '../phi-extension/lib/rpc-runtime-config'
import { withRemoteSignal } from './history-pager'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
/** Proves a known local command and the real public stream installer, never an unknown slash prompt. */
export async function attestRpcRuntime(
  connection: RpcConnection,
  expected: RpcRuntimeConfig,
  ompSessionId: string,
  signal: AbortSignal
): Promise<void> {
  const control = connection.bindControl()
  if (control.generation !== expected.generation) throw new Error('RPC runtime generation mismatch')
  const commandList = await withRemoteSignal(
    connection.request<unknown>({ type: 'get_available_commands' }),
    signal
  )
  const matches =
    record(commandList) && Array.isArray(commandList.commands)
      ? commandList.commands.filter((value) => record(value) && value.name === RPC_RUNTIME_COMMAND)
      : []
  if (
    matches.length !== 1 ||
    !record(matches[0]) ||
    matches[0].source !== 'extension' ||
    matches[0].description !== RPC_RUNTIME_DESCRIPTION
  )
    throw new Error('Composed RPC runtime command is not installed')
  let resolve!: () => void
  let reject!: (error: Error) => void
  const proof = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  void proof.catch(() => undefined)
  const timer = setTimeout(
    () => reject(new Error('Composed RPC runtime attestation timed out')),
    10_000
  )
  const off = control.onFrame((frame) => {
    if (frame.type === 'agent_start') {
      reject(new Error('RPC runtime attestation invoked a model'))
      return
    }
    if (
      frame.type !== 'extension_ui_request' ||
      frame.method !== 'notify' ||
      typeof frame.message !== 'string'
    )
      return
    let value: unknown
    try {
      value = JSON.parse(frame.message)
    } catch {
      return
    }
    if (!record(value) || value.type !== 'phi_rpc_runtime_attestation') return
    if (
      frame.notifyType !== 'info' ||
      Buffer.byteLength(frame.message) > 16 * 1024 ||
      Object.keys(value).sort().join(',') !==
        'components,configHash,generation,nonce,ompSessionId,phiSessionId,projectId,projectRoot,rosterHash,type' ||
      value.nonce !== expected.nonce ||
      value.phiSessionId !== expected.phiSessionId ||
      value.projectId !== expected.projectId ||
      value.projectRoot !== expected.projectRoot ||
      value.generation !== control.generation ||
      value.ompSessionId !== ompSessionId ||
      value.rosterHash !== executionRoster(expected.execution.tools).hash ||
      value.configHash !== rpcRuntimeConfigDigest(expected) ||
      JSON.stringify(value.components) !==
        JSON.stringify(['execution', 'approval', 'host-result', 'verification', 'native-stream'])
    )
      reject(new Error('Composed RPC runtime attestation mismatch'))
    else resolve()
  })
  try {
    const [result] = await withRemoteSignal(
      Promise.all([connection.prompt(`/${RPC_RUNTIME_COMMAND} ${expected.nonce}`), proof]),
      AbortSignal.any([signal, control.signal])
    )
    if (result.agentInvoked || result.status !== 'completed' || !result.sessionSettled)
      throw new Error('RPC runtime attestation did not settle locally')
  } finally {
    off()
    clearTimeout(timer)
  }
}
