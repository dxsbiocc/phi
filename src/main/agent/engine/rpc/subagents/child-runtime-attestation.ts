import type { RpcConnection } from '../connection'
import { withRemoteSignal } from '../history-pager'
import type { RpcFrame } from '../types'
import {
  CHILD_ATTEST_COMMAND,
  CHILD_ATTEST_DESCRIPTION,
  verifyRpcChildAttestation,
  type RpcChildRuntimeConfig
} from '../../phi-extension/lib/rpc-child-config'
import {
  validateRpcChildRoot,
  type RpcChildRootScope
} from '../../phi-extension/lib/rpc-child-protocol'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export type ProductionChildRootAttachment = Pick<
  RpcChildRootScope,
  'rootOmpSessionId' | 'rootSessionFile'
>

function attestationCommandError(frame: RpcFrame): Error | undefined {
  if (
    frame.type !== 'extension_error' ||
    frame.extensionPath !== `command:${CHILD_ATTEST_COMMAND}` ||
    frame.event !== 'command'
  )
    return undefined
  return new Error(
    typeof frame.error === 'string' && frame.error.length > 0
      ? frame.error
      : 'Child runtime attestation command failed'
  )
}

function observeAttestationFrame(
  frame: RpcFrame,
  config: RpcChildRuntimeConfig,
  root: ProductionChildRootAttachment,
  resolve: (identity: Readonly<RpcChildRootScope>) => void,
  reject: (error: Error) => void
): void {
  if (frame.type === 'agent_start') reject(new Error('Child runtime attestation invoked a model'))
  const commandError = attestationCommandError(frame)
  if (commandError) {
    reject(commandError)
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
  if (!record(value) || value.type !== 'phi_rpc_child_attestation') return
  let identity: Readonly<RpcChildRootScope>
  try {
    identity = validateRpcChildRoot(value.identity)
  } catch {
    reject(new Error('Child runtime attestation has an invalid root identity'))
    return
  }
  if (
    frame.notifyType !== 'info' ||
    Buffer.byteLength(frame.message) > 16384 ||
    identity.rootOmpSessionId !== root.rootOmpSessionId ||
    identity.rootSessionFile !== root.rootSessionFile ||
    !verifyRpcChildAttestation(value, config, identity)
  )
    reject(new Error('Child runtime attestation differs from its trusted publication'))
  else resolve(identity)
}

/** Discovered local command + independent HMAC + actual get_state identity, without invoking a model. */
export async function attestProductionChildRuntime(
  connection: RpcConnection,
  config: RpcChildRuntimeConfig,
  root: ProductionChildRootAttachment,
  signal: AbortSignal
): Promise<Readonly<RpcChildRootScope>> {
  const channel = connection.bindControl()
  const joined = AbortSignal.any([signal, channel.signal, AbortSignal.timeout(10000)])
  const stateMatches = async (): Promise<void> => {
    const state = await withRemoteSignal(connection.request<unknown>({ type: 'get_state' }), joined)
    if (
      !record(state) ||
      state.sessionId !== root.rootOmpSessionId ||
      state.sessionFile !== root.rootSessionFile
    )
      throw new Error('Child runtime differs from the actual attached root session')
  }
  if (channel.generation !== config.generation)
    throw new Error('Child runtime attestation generation differs')
  await stateMatches()
  const list = await withRemoteSignal(
    connection.request<unknown>({ type: 'get_available_commands' }),
    joined
  )
  const matches =
    record(list) && Array.isArray(list.commands)
      ? list.commands.filter((command) => record(command) && command.name === CHILD_ATTEST_COMMAND)
      : []
  if (
    matches.length !== 1 ||
    !record(matches[0]) ||
    matches[0].source !== 'extension' ||
    matches[0].description !== CHILD_ATTEST_DESCRIPTION
  )
    throw new Error('Child runtime attestation command is unavailable')
  let resolve!: (identity: Readonly<RpcChildRootScope>) => void, reject!: (error: Error) => void
  const proof = new Promise<Readonly<RpcChildRootScope>>((yes, no) => {
    resolve = yes
    reject = no
  })
  void proof.catch(() => undefined)
  const detach = channel.onFrame((frame) =>
    observeAttestationFrame(frame, config, root, resolve, reject)
  )
  try {
    const [result, identity] = await withRemoteSignal(
      Promise.all([connection.prompt(`/${CHILD_ATTEST_COMMAND} ${config.nonce}`), proof]),
      joined
    )
    if (result.agentInvoked || result.status !== 'completed' || !result.sessionSettled)
      throw new Error('Child runtime attestation did not settle locally')
    await stateMatches()
    return identity
  } finally {
    detach()
  }
}
