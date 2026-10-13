import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { OwnedModelGatewayLease } from '../../src/main/agent/engine/omp-bridge'
import type { CreateModelGatewayLeaseParams } from '../../src/main/agent/engine/model-gateway-types'
import type {
  prepareModelProxyRpcSessionTransport,
  ModelProxyRpcSessionTransport
} from '../../src/main/agent/engine/rpc/model-proxy-lease'
import type { RpcSessionCreateParams } from '../../src/main/agent/engine/rpc/rpc-session-backend'
import type { SshRpcSessionTransportOptions } from '../../src/main/agent/engine/rpc/ssh-stdio-factory'
import type {
  RemoteReverseTunnel,
  ReverseTunnelOptions
} from '../../src/main/agent/wrappers/remote-ssh-session'
import { createInitializationWire, deferred } from './rpc-initialization-wire'

type GatewayFixture = OwnedModelGatewayLease & { closes: number; lost(): void }
type TunnelFixture = RemoteReverseTunnel & { closes: number; lost(): void }
type GatewayHook = (
  params: CreateModelGatewayLeaseParams,
  lease: OwnedModelGatewayLease
) => Promise<OwnedModelGatewayLease>
type TunnelHook = (
  options: ReverseTunnelOptions,
  tunnel: RemoteReverseTunnel
) => Promise<RemoteReverseTunnel>
interface LifecycleFixture {
  transport: ModelProxyRpcSessionTransport
  gateways: GatewayFixture[]
  tunnels: TunnelFixture[]
  wires: ReturnType<typeof createInitializationWire>[]
  configurations: Array<Record<string, unknown>>
  gatewayHook(hook: GatewayHook): void
  tunnelHook(hook: TunnelHook): void
  configHook(hook: () => Promise<void>): void
  failOpen(error: Error): void
  failInitialize(error: Error): void
  streamPrompts(): void
}

export async function modelProxyLifecycleFixture(): Promise<LifecycleFixture> {
  const gateways: Array<OwnedModelGatewayLease & { closes: number; lost(): void }> = []
  const tunnels: Array<RemoteReverseTunnel & { closes: number; lost(): void }> = []
  const wires: ReturnType<typeof createInitializationWire>[] = []
  const configurations: Array<Record<string, unknown>> = []
  let gatewayHook:
    | ((
        params: CreateModelGatewayLeaseParams,
        lease: OwnedModelGatewayLease
      ) => Promise<OwnedModelGatewayLease>)
    | undefined
  let tunnelHook:
    | ((options: ReverseTunnelOptions, tunnel: RemoteReverseTunnel) => Promise<RemoteReverseTunnel>)
    | undefined
  let configHook: (() => Promise<void>) | undefined
  let openError: Error | undefined
  let initializeError: Error | undefined
  let streamPrompts = false
  let prepareSession!: NonNullable<SshRpcSessionTransportOptions['prepareSession']>
  const source = readFileSync(
    new URL('../../src/main/agent/engine/rpc/model-proxy-lease.ts', import.meta.url),
    'utf8'
  )
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  runInNewContext(output, {
    module,
    exports: module.exports,
    AbortController,
    require(specifier: string) {
      if (specifier === './model-selection')
        return {
          async selectRemoteModel(): Promise<void> {
            return undefined
          }
        }
      if (specifier === './model-proxy-config')
        return {
          async writeRemoteModelProxyConfig(options: Record<string, unknown>) {
            configurations.push(options)
            await configHook?.()
            return {
              nonce: 'f'.repeat(32),
              sessionId: options.sessionId,
              projectRoot: options.projectRoot,
              gatewayGeneration: options.gatewayGeneration
            }
          }
        }
      if (specifier === './ssh-stdio-factory')
        return {
          async prepareSshRpcSessionTransport(options: SshRpcSessionTransportOptions) {
            prepareSession = options.prepareSession!
            return {
              async open(params: RpcSessionCreateParams, signal: AbortSignal) {
                // The production private-generation directory creation is covered
                // by its own actual local-shell tests. This seam isolates ownership.
                await prepareSession({
                  params,
                  homePath: '/private/home',
                  agentDir: '/private/home/agent',
                  signal
                })
                if (openError) throw openError
                const wire = createInitializationWire((command, respond, emit) => {
                  if (streamPrompts && command.type === 'prompt') {
                    respond({ agentInvoked: true })
                    emit({ type: 'agent_start' })
                    return true
                  }
                  return false
                })
                wires.push(wire)
                return wire.transport
              },
              async initialize() {
                if (initializeError) throw initializeError
              }
            }
          }
        }
      throw new Error(`Unexpected lifecycle dependency ${specifier}`)
    }
  })
  const prepare = (
    module.exports as {
      prepareModelProxyRpcSessionTransport: typeof prepareModelProxyRpcSessionTransport
    }
  ).prepareModelProxyRpcSessionTransport
  const transport = await prepare({
    projectId: 'project',
    models: [{ provider: 'fixture', id: 'model' }],
    runtime: {} as never,
    bundle: {} as never,
    gateway: {
      async createModelGatewayLease(params) {
        const completion = deferred<void>()
        const lease = {
          leaseId: `lease-${gateways.length + 1}`,
          sessionId: params.sessionId,
          generation: params.generation,
          localPort: 32000 + gateways.length,
          bearerToken: `${params.generation}`.padEnd(43, 'x'),
          models: [
            {
              provider: 'fixture',
              id: 'model',
              name: 'Fixture',
              reasoning: false,
              input: ['text' as const],
              contextWindow: 1000,
              maxTokens: 100
            }
          ],
          closed: completion.promise,
          closes: 0,
          lost: () => completion.resolve(),
          async close() {
            if (this.closes) return
            this.closes++
            completion.resolve()
          }
        }
        gateways.push(lease)
        return gatewayHook ? gatewayHook(params, lease) : lease
      }
    },
    session: {
      async openReverseTunnel(options) {
        const completion = deferred<void>()
        const tunnel = {
          remotePort: 33000 + tunnels.length,
          closed: completion.promise,
          closes: 0,
          lost() {
            options.onInvalidated?.()
            completion.resolve()
          },
          async close() {
            if (this.closes) return
            this.closes++
            completion.resolve()
          }
        }
        tunnels.push(tunnel)
        return tunnelHook ? tunnelHook(options, tunnel) : tunnel
      }
    }
  })
  return {
    transport,
    gateways,
    tunnels,
    wires,
    configurations,
    gatewayHook(hook: NonNullable<typeof gatewayHook>) {
      gatewayHook = hook
    },
    tunnelHook(hook: NonNullable<typeof tunnelHook>) {
      tunnelHook = hook
    },
    configHook(hook: NonNullable<typeof configHook>) {
      configHook = hook
    },
    failOpen(error: Error) {
      openError = error
    },
    failInitialize(error: Error) {
      initializeError = error
    },
    streamPrompts() {
      streamPrompts = true
    }
  }
}
