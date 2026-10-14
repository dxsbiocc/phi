import type { BrowserTextVault } from '../../browser/browser-text-vault'
import type { GatewayHttpListener } from '../in-process/model-gateway-http'
import type { OmpBridge, OwnedModelGatewayLease } from '../omp-bridge'
import type { ModelGatewayModelRef, SafeModelDescriptor } from '../model-gateway-types'
import type { RpcModelMetadata } from '../phi-extension/lib/rpc-model-metadata'
import { selectRemoteModel } from './model-selection'
import type {
  RemoteReverseTunnel,
  RemoteSshSession,
  RemoteStdioProcess
} from '../../wrappers/remote-ssh-session'
import { writeRemoteModelProxyConfig } from './model-proxy-config'
import {
  prepareSshRpcSessionTransport,
  type SshRpcSessionTransport,
  type SshRpcSessionTransportOptions,
  type RpcRuntimePreparationContext,
  type RpcRuntimePreparationResult
} from './ssh-stdio-factory'
import { assertPhiModelProviderCompatible } from './rpc-startup-policy'
import type { RpcSessionBackendOptions, RpcSessionCreateParams } from './rpc-session-backend'

export interface ModelProxyRpcTransportOptions extends Omit<
  SshRpcSessionTransportOptions,
  'session' | 'prepareSession' | 'prepareRuntime'
> {
  readonly gateway: Pick<OmpBridge, 'createModelGatewayLease'>
  readonly browserTextVault?: BrowserTextVault
  readonly currentBrowserRunSignal?: () => AbortSignal | undefined
  /** Main-only generation/selection check, including the last awaited command lookup. */
  readonly assertSelectionCurrent?: () => void
  readonly session: Pick<
    RemoteSshSession,
    'openStdio' | 'openReverseTunnel' | 'execWithInput' | 'execBounded'
  >
  readonly models: readonly ModelGatewayModelRef[]
  readonly prepareRuntime?: (
    context: RpcRuntimePreparationContext & {
      readonly modelDescriptors: readonly SafeModelDescriptor[]
      readonly native: {
        readonly endpoint: string
        readonly models: readonly ModelGatewayModelRef[]
      }
    }
  ) => Promise<void | RpcRuntimePreparationResult>
}

export interface ModelProxyRpcSessionTransport extends SshRpcSessionTransport {
  readonly prepare: NonNullable<RpcSessionBackendOptions['prepare']>
  readonly selectModel: NonNullable<RpcSessionBackendOptions['selectModel']>
}

// Monotonic across replacement transport factories in this main process.
let modelProxyGeneration = 0

interface Generation {
  readonly controller: AbortController
  gateway?: OwnedModelGatewayLease
  browserGateway?: GatewayHttpListener
  tunnel?: RemoteReverseTunnel
  channel?: RemoteStdioProcess
  publication?: Pick<RpcModelMetadata, 'nonce' | 'sessionId' | 'projectRoot' | 'gatewayGeneration'>
  close(reason?: unknown): Promise<void>
}

/** Race acquisition without losing responsibility for a resource that arrives late. */
async function acquire<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  close: (resource: T) => Promise<void>
): Promise<T> {
  void operation.then(
    (value) => {
      if (signal.aborted) void close(value).catch(() => undefined)
    },
    () => undefined
  )
  let abort!: () => void
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/**
 * Shared deployment is prepared once; model access is acquired anew for every
 * backend generation before RpcConnection starts its existing handshake timer.
 */
export async function prepareModelProxyRpcSessionTransport(
  options: ModelProxyRpcTransportOptions,
  preparationSignal?: AbortSignal
): Promise<ModelProxyRpcSessionTransport> {
  if (!options.session.openReverseTunnel)
    throw new Error('Connected SSH session cannot forward the model gateway')
  for (const model of options.models) assertPhiModelProviderCompatible(model.provider)
  const models = Object.freeze(
    options.models.map(({ provider, id }) => Object.freeze({ provider, id }))
  )
  const generations = new WeakMap<Readonly<RpcSessionCreateParams>, Generation>()
  const transport = await prepareSshRpcSessionTransport(
    {
      ...options,
      prepareRuntime: options.prepareRuntime
        ? async (context) => {
            const owned = generations.get(context.params)
            if (!owned?.gateway || !owned.tunnel || !owned.publication)
              throw new Error('Missing published model proxy generation')
            owned.controller.signal.throwIfAborted()
            const result = await options.prepareRuntime!(
              Object.freeze({
                ...context,
                modelDescriptors: Object.freeze(
                  owned.gateway.models.map(
                    ({ provider, id, name, reasoning, input, contextWindow, maxTokens, cost }) =>
                      Object.freeze({
                        provider,
                        id,
                        name,
                        reasoning,
                        input: Object.freeze([...input]),
                        contextWindow,
                        maxTokens,
                        ...(cost ? { cost: Object.freeze({ ...cost }) } : {})
                      })
                  )
                ),
                native: Object.freeze({
                  endpoint: `http://127.0.0.1:${owned.tunnel.remotePort}/v1/pi/stream`,
                  models
                })
              })
            )
            owned.controller.signal.throwIfAborted()
            return result
          }
        : undefined,
      prepareSession: async ({ params, agentDir, signal }) => {
        const owned = generations.get(params)
        if (!owned?.gateway || !owned.tunnel)
          throw new Error('Model proxy generation was not prepared')
        owned.controller.signal.throwIfAborted()
        const publication = await writeRemoteModelProxyConfig({
          session: options.session,
          agentDir,
          models: owned.gateway.models,
          remotePort: owned.tunnel.remotePort,
          gatewayBearer: owned.gateway.bearerToken,
          sessionId: owned.gateway.sessionId,
          projectRoot: params.cwd,
          gatewayGeneration: owned.gateway.generation,
          signal
        })
        owned.controller.signal.throwIfAborted()
        if (
          publication.sessionId !== params.sessionId ||
          publication.projectRoot !== params.cwd ||
          publication.gatewayGeneration !== owned.gateway.generation
        )
          throw new Error('Private model publication does not match its generation')
        owned.publication = Object.freeze({ ...publication })
      }
    },
    preparationSignal
  )
  return {
    async selectModel({ connection, params, signal }, model) {
      const owned = generations.get(params)
      if (!owned?.gateway || !owned.publication)
        throw new Error('Missing published model proxy generation')
      owned.controller.signal.throwIfAborted()
      await selectRemoteModel(
        connection,
        Object.freeze({ schema: 1, ...owned.publication, models: owned.gateway.models }),
        model,
        signal,
        { beforeDispatch: options.assertSelectionCurrent }
      )
      owned.controller.signal.throwIfAborted()
    },
    async prepare(params, signal) {
      signal.throwIfAborted()
      if (generations.has(params)) throw new Error('Model proxy generation was already prepared')
      if (
        !params.model ||
        !models.some(
          ({ provider, id }) => provider === params.model!.provider && id === params.model!.id
        )
      )
        throw new Error('Selected remote model is unavailable')
      const controller = new AbortController()
      let closing: Promise<void> | undefined
      let release!: () => void
      const owned: Generation = {
        controller,
        close(reason = new Error('Model proxy generation closed')) {
          if (closing) return closing
          // Publish the idempotent result before aborting: callbacks may re-enter.
          closing = new Promise<void>((resolve) => {
            release = resolve
          })
          signal.removeEventListener('abort', abort)
          if (generations.get(params) === owned) generations.delete(params)
          controller.abort(reason)
          // Revoke model access immediately, then release only this generation's
          // channel and forwarding. A cleanup failure cannot suppress the others.
          const tasks = [
            Promise.resolve().then(() => owned.gateway?.close()),
            Promise.resolve().then(() => owned.browserGateway?.close()),
            Promise.resolve().then(() => owned.channel?.close()),
            Promise.resolve().then(() => owned.tunnel?.close())
          ]
          void Promise.allSettled(tasks).then(() => release())
          return closing
        }
      }
      const abort = (): void => {
        void owned.close(signal.reason)
      }
      generations.set(params, owned)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      try {
        owned.gateway = await acquire(
          options.gateway.createModelGatewayLease(
            {
              sessionId: params.sessionId,
              generation: ++modelProxyGeneration,
              models
            },
            controller.signal
          ),
          controller.signal,
          (lease) => lease.close()
        )
        controller.signal.throwIfAborted()
        void owned.gateway.closed.then(
          () => owned.close(new Error('Model gateway worker closed')),
          () => owned.close(new Error('Model gateway worker closed'))
        )
        if (options.browserTextVault) {
          const { createBrowserModelGateway } = await import('./browser-model-gateway')
          if (!options.currentBrowserRunSignal)
            throw new Error('Browser model privacy requires a live run binding')
          owned.browserGateway = await acquire(
            createBrowserModelGateway({
              lease: owned.gateway,
              vault: options.browserTextVault,
              currentRunSignal: options.currentBrowserRunSignal,
              signal: controller.signal
            }),
            controller.signal,
            (listener) => listener.close()
          )
        }
        owned.tunnel = await acquire(
          options.session.openReverseTunnel!({
            localPort: owned.browserGateway?.port ?? owned.gateway.localPort,
            signal: controller.signal,
            onInvalidated: () => {
              void owned.close(new Error('Model gateway forwarding was invalidated'))
            }
          }),
          controller.signal,
          (tunnel) => tunnel.close()
        )
        controller.signal.throwIfAborted()
        void owned.tunnel.closed.then(
          () => owned.close(new Error('Model gateway forwarding closed')),
          () => owned.close(new Error('Model gateway forwarding closed'))
        )
        return () => owned.close()
      } catch (error) {
        await owned.close(error)
        throw error
      }
    },
    async open(params, signal, generation) {
      const owned = generations.get(params)
      if (!owned) throw new Error('Missing prepared model proxy generation')
      const abort = (): void => {
        void owned.close(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      try {
        owned.controller.signal.throwIfAborted()
        const channel = await acquire(
          transport.open(params, owned.controller.signal, generation),
          owned.controller.signal,
          (late) => late.close()
        )
        owned.channel = channel
        owned.controller.signal.throwIfAborted()
        const detach = (): void => signal.removeEventListener('abort', abort)
        void channel.closed.then(
          () => {
            detach()
            return owned.close()
          },
          () => {
            detach()
            return owned.close()
          }
        )
        return {
          stdin: channel.stdin,
          stdout: channel.stdout,
          stderr: channel.stderr,
          closed: channel.closed,
          close: () => owned.close()
        }
      } catch (error) {
        signal.removeEventListener('abort', abort)
        await owned.close(error)
        throw error
      }
    },
    async initialize(context) {
      const owned = generations.get(context.params)
      if (!owned) throw new Error('Missing prepared model proxy generation')
      owned.controller.signal.throwIfAborted()
      // Let the backend preserve the original attestation error before its
      // generation signal and preparation cleanup close the channel.
      await transport.initialize(context)
      owned.controller.signal.throwIfAborted()
    }
  }
}
