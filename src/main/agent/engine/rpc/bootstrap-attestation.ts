import { posix } from 'node:path'
import {
  RPC_BOOTSTRAP_COMMAND,
  RPC_BOOTSTRAP_DESCRIPTION,
  RPC_BOOTSTRAP_OMP_VERSION,
  type RpcBootstrapConfig
} from '../phi-extension/lib/rpc-config'
import type { RpcConnection } from './connection'
import type { RpcSessionBackendOptions } from './rpc-session-backend'

export interface BootstrapAttestationOptions {
  timeoutMs?: number
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function error(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** The expected identity comes from the verified deployment, never from a remote claim. */
export async function attestBootstrap(
  connection: RpcConnection,
  expected: Readonly<RpcBootstrapConfig>,
  signal: AbortSignal,
  options: BootstrapAttestationOptions = {}
): Promise<void> {
  const identity = Object.freeze({ ...expected })
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Phi RPC attestation timeout must be positive and finite')
  }
  if (
    identity.schema !== 1 ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(identity.nonce) ||
    !identity.sessionId ||
    !identity.projectId ||
    !posix.isAbsolute(identity.projectRoot) ||
    posix.resolve(identity.projectRoot) !== identity.projectRoot ||
    identity.ompVersion !== RPC_BOOTSTRAP_OMP_VERSION ||
    !/^[a-f0-9]{64}$/u.test(identity.contentHash)
  ) {
    throw new Error('Phi RPC expected bootstrap identity is invalid')
  }
  if (signal.aborted) throw error(signal.reason)
  let stopped: Error | undefined
  let probeStarted = false
  let received!: () => void
  let rejectNotification!: (cause: Error) => void
  const notification = new Promise<void>((resolveNotification, reject) => {
    received = resolveNotification
    rejectNotification = reject
  })
  // A failure can arrive while get_available_commands is still outstanding.
  void notification.catch(() => undefined)
  let cancelled!: (cause: Error) => void
  const cancellation = new Promise<never>((_, reject) => {
    cancelled = reject
  })
  const stop = (cause: unknown): void => {
    stopped ??= error(cause)
    cancelled(stopped)
    rejectNotification(stopped)
  }
  const onAbort = (): void => stop(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(
    () => stop(new Error('Phi RPC bootstrap attestation timed out')),
    timeoutMs
  )
  const unsubscribeDisconnect = connection.onDisconnect(({ error: cause }) => stop(cause))
  const unsubscribeEvent = connection.onEvent((frame) => {
    if (frame.type === 'agent_start') {
      stop(new Error('Phi RPC bootstrap attestation attempted model execution'))
      return
    }
    if (
      !probeStarted ||
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
    if (!record(value) || value.type !== 'phi_rpc_bootstrap_attestation') return
    try {
      if (frame.notifyType !== 'info' || value.protocolVersion !== 1) {
        throw new Error('Phi RPC bootstrap attestation protocol does not match')
      }
      for (const key of [
        'nonce',
        'sessionId',
        'projectId',
        'projectRoot',
        'ompVersion',
        'contentHash'
      ] as const) {
        if (value[key] !== identity[key])
          throw new Error(`Phi RPC bootstrap attestation ${key} does not match`)
      }
      if (
        !record(value.guards) ||
        value.guards.projectBoundary !== true ||
        value.guards.remoteUrl !== true ||
        value.guards.writes !== 'deny'
      ) {
        throw new Error('Phi RPC bootstrap guards are not active')
      }
      received()
    } catch (cause) {
      stop(cause)
    }
  })
  try {
    await Promise.race([
      (async () => {
        const data = await connection.request({ type: 'get_available_commands' })
        if (stopped) throw stopped
        if (!record(data) || !Array.isArray(data.commands)) {
          throw new Error('Phi RPC command list is invalid')
        }
        const matches = data.commands.filter(
          (command) => record(command) && command.name === RPC_BOOTSTRAP_COMMAND
        )
        if (
          matches.length !== 1 ||
          !record(matches[0]) ||
          matches[0].source !== 'extension' ||
          matches[0].description !== RPC_BOOTSTRAP_DESCRIPTION
        ) {
          throw new Error('Phi RPC bootstrap guard command is not loaded')
        }
        // Never probe an unknown slash command: it would fall through to the model.
        probeStarted = true
        const [result] = await Promise.all([
          connection.prompt(`/${RPC_BOOTSTRAP_COMMAND} ${identity.nonce}`),
          notification
        ])
        if (result.agentInvoked || result.status !== 'completed' || !result.sessionSettled) {
          throw new Error('Phi RPC bootstrap challenge did not complete locally')
        }
      })(),
      cancellation
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    unsubscribeDisconnect()
    unsubscribeEvent()
  }
}

export function createBootstrapAttester(
  expected: Readonly<RpcBootstrapConfig>,
  options: BootstrapAttestationOptions = {}
): NonNullable<RpcSessionBackendOptions['initialize']> {
  const identity = Object.freeze({ ...expected })
  return ({ connection, params, signal }) => {
    if (params.sessionId !== identity.sessionId)
      throw new Error('Phi RPC bootstrap session does not match')
    return attestBootstrap(connection, identity, signal, options)
  }
}
