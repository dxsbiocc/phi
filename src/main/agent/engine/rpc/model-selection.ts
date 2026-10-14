import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import {
  RPC_MODEL_SELECTION_COMMAND,
  RPC_MODEL_SELECTION_DESCRIPTION,
  type RpcModelMetadata,
  type RpcModelSelectionRequest
} from '../phi-extension/lib/rpc-model-metadata'
import type { ModelGatewayModelRef } from '../model-gateway-types'
import type { RpcConnection } from './connection'
import { RpcPromptError } from './rpc-session-backend'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function failure(value: unknown): Error {
  return value instanceof Error ? value : new Error('Phi RPC model selection failed')
}

/** Select only through the verified Phi extension, restoring nullable catalog limits. */
export async function selectRemoteModel(
  connection: RpcConnection,
  expected: Readonly<RpcModelMetadata>,
  target: Readonly<ModelGatewayModelRef>,
  signal: AbortSignal,
  options: { timeoutMs?: number; beforeDispatch?: () => void } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Phi RPC model selection timeout must be positive and finite')
  const model = expected.models.find(
    ({ provider, id }) => provider === target.provider && id === target.id
  )
  if (
    expected.schema !== 1 ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(expected.nonce) ||
    !expected.sessionId ||
    !posix.isAbsolute(expected.projectRoot) ||
    posix.resolve(expected.projectRoot) !== expected.projectRoot ||
    !Number.isSafeInteger(expected.gatewayGeneration) ||
    expected.gatewayGeneration < 1 ||
    !model
  )
    throw new Error('Phi RPC expected model selection identity is invalid')
  if (
    (model.contextWindow !== null &&
      (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1)) ||
    (model.maxTokens !== null && (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1))
  )
    throw new Error('Phi RPC expected model limits are invalid')
  const limits = Object.freeze({ contextWindow: model.contextWindow, maxTokens: model.maxTokens })
  signal.throwIfAborted()
  const request: RpcModelSelectionRequest = Object.freeze({
    nonce: expected.nonce,
    sessionId: expected.sessionId,
    projectRoot: expected.projectRoot,
    gatewayGeneration: expected.gatewayGeneration,
    selectionId: randomUUID(),
    provider: target.provider,
    modelId: target.id
  })
  let stopped: Error | undefined
  let started = false
  let receive!: () => void
  let rejectNotification!: (error: Error) => void
  const notification = new Promise<void>((resolve, reject) => {
    receive = resolve
    rejectNotification = reject
  })
  void notification.catch(() => undefined)
  let rejectCancellation!: (error: Error) => void
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject
  })
  const stop = (error: unknown): void => {
    stopped ??= failure(error)
    rejectNotification(stopped)
    rejectCancellation(stopped)
  }
  const abort = (): void => stop(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => stop(new Error('Phi RPC model selection timed out')), timeoutMs)
  const detachDisconnect = connection.onDisconnect(({ error }) => stop(error))
  const detachEvent = connection.onEvent((frame) => {
    if (
      started &&
      frame.type === 'extension_error' &&
      frame.extensionPath === `command:${RPC_MODEL_SELECTION_COMMAND}` &&
      frame.event === 'command'
    ) {
      const message =
        typeof frame.error === 'string' &&
        frame.error.length > 0 &&
        frame.error.length <= 512 &&
        !frame.error.includes('\n')
          ? frame.error
          : 'Phi RPC model selection command failed'
      stop(new Error(message))
      return
    }
    if (frame.type === 'agent_start') {
      stop(new Error('Phi RPC model selection attempted model execution'))
      return
    }
    if (
      !started ||
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
    if (
      !record(value) ||
      value.type !== 'phi_rpc_model_selection' ||
      value.selectionId !== request.selectionId
    )
      return
    try {
      if (frame.notifyType !== 'info' || value.protocolVersion !== 1)
        throw new Error('Phi RPC model selection protocol does not match')
      for (const key of [
        'nonce',
        'sessionId',
        'projectRoot',
        'gatewayGeneration',
        'selectionId',
        'provider',
        'modelId'
      ] as const) {
        if (value[key] !== request[key])
          throw new Error(`Phi RPC model selection ${key} does not match`)
      }
      if (value.contextWindow !== limits.contextWindow || value.maxTokens !== limits.maxTokens)
        throw new Error('Phi RPC model selection limits do not match')
      receive()
    } catch (error) {
      stop(error)
    }
  })
  try {
    await Promise.race([
      (async () => {
        const data = await connection.request({ type: 'get_available_commands' })
        options.beforeDispatch?.()
        if (stopped) throw stopped
        if (!record(data) || !Array.isArray(data.commands))
          throw new Error('Phi RPC model selection command list is invalid')
        const commands = data.commands.filter(
          (command) => record(command) && command.name === RPC_MODEL_SELECTION_COMMAND
        )
        if (
          commands.length !== 1 ||
          !record(commands[0]) ||
          commands[0].source !== 'extension' ||
          commands[0].description !== RPC_MODEL_SELECTION_DESCRIPTION
        )
          throw new Error('Phi RPC model selection command is not loaded')
        started = true
        options.beforeDispatch?.()
        await Promise.all([
          connection
            .prompt(`/${RPC_MODEL_SELECTION_COMMAND} ${JSON.stringify(request)}`)
            .then((result) => {
              if (!result.agentInvoked && result.status === 'error')
                throw new RpcPromptError(result)
              if (result.agentInvoked || result.status !== 'completed' || !result.sessionSettled)
                throw new Error('Phi RPC model selection did not complete locally')
            }),
          notification
        ])
      })(),
      cancellation
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    detachDisconnect()
    detachEvent()
  }
}
