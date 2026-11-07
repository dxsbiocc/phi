import type { PhiEngine, PhiSessionCreateParams } from '../src/main/agent/engine/types'
import { KernelSessionFactory } from '../src/main/agent/engine/kernel-session-factory'
import { SessionRoutingEngine } from '../src/main/agent/engine/session-routing-engine'
import { createKernelFixture } from './engine-contract/kernel-factory'
import { engineContract } from './engine-contract/suite'
import type { EngineFactory, EngineFixture } from './engine-contract/in-process-factory'

function routedKernelFactory(shape: 'local' | 'remote'): EngineFactory {
  return async (modelId): Promise<EngineFixture> => {
    const fixture = await createKernelFixture({ modelId })
    const factory = new KernelSessionFactory({
      ...(shape === 'local'
        ? {
            launchLocal: async (_params, context) => {
              context.configureClient(fixture.client)
              const greeting = await fixture.client.hello({
                hostCapabilities: Array.from(context.hostCapabilities)
              })
              return {
                client: fixture.client,
                greeting,
                configuredBeforeHello: true,
                close: async () => undefined
              }
            }
          }
        : {
            launchRemote: async (_params: PhiSessionCreateParams, context) => {
              context.configureClient(fixture.client)
              const greeting = await fixture.client.hello({
                hostCapabilities: Array.from(context.hostCapabilities)
              })
              return {
                client: fixture.client,
                greeting,
                configuredBeforeHello: true,
                runtimeRoot: '/kernel-runtime',
                close: async () => undefined
              }
            }
          })
    })
    const routed = new SessionRoutingEngine(fixture.legacy.engine, () => factory)
    const engine: PhiEngine =
      shape === 'local'
        ? routed
        : {
            ...routed,
            stop: () => routed.stop(),
            sessions: {
              ...routed.sessions,
              create: (params, control) =>
                routed.sessions.create(
                  {
                    ...params,
                    remoteProject: {
                      phiSessionId: params.sessionId,
                      projectId: 'remote-contract',
                      location: {
                        kind: 'ssh',
                        hostProfileId: 'ssh-config:contract',
                        remoteRoot: fixture.cwd,
                        canonicalRoot: fixture.cwd
                      },
                      contextFiles: []
                    }
                  },
                  control
                )
            }
          }
    let closing: Promise<void> | undefined
    return {
      engine,
      agentDir: fixture.agentDir,
      cwd: fixture.cwd,
      model: fixture.model,
      replacementModel: fixture.legacy.replacementModel,
      provider: fixture.provider,
      createModelGatewayLease: fixture.legacy.createModelGatewayLease,
      removeModel: fixture.legacy.removeModel,
      seedOAuth: fixture.legacy.seedOAuth,
      close() {
        closing ??= fixture.close()
        return closing
      }
    }
  }
}

engineContract('SessionRoutingEngine/Kernel/local', routedKernelFactory('local'))
engineContract('SessionRoutingEngine/Kernel/remote-shaped', routedKernelFactory('remote'))
