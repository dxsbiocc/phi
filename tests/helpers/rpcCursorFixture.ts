import { randomBytes, randomUUID } from 'node:crypto'
import type { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import { createScopedCursorH2Gateway } from '../../src/main/agent/engine/in-process/scoped-cursor-h2-gateway'
import type { RemoteRuntimeTurnResult } from '../../src/main/agent/engine/rpc/remote-session-runtime'
import { runtimeCompositionFixture } from './rpcRuntimeCompositionFixture'
import { startLoopbackCursor } from './loopbackCursor'

/** Real scoped Cursor tunnel, private RPC runtime and official CLI over local test transports. */
export interface RpcCursorFixture {
  provider: Awaited<ReturnType<typeof startLoopbackCursor>>
  cli: {
    connection: {
      prompt(text: string): Promise<RemoteRuntimeTurnResult['result']>
      request<T>(request: Parameters<RpcConnection['request']>[0]): Promise<T>
      onEvent(
        listener: Parameters<RpcConnection['onEvent']>[0]
      ): ReturnType<RpcConnection['onEvent']>
      abort(): Promise<void>
    }
    stderr(): string
  }
  close(): Promise<void>
}

export async function createRpcCursorFixture(): Promise<RpcCursorFixture> {
  const fixture = await runtimeCompositionFixture({ auditModelGatewayWire: false })
  const provider = await startLoopbackCursor()
  const token = randomBytes(32).toString('base64url')
  const scoped = await createScopedCursorH2Gateway({
    token,
    allowedModelIds: [
      'cursor-grok-4.6-fast',
      'cursor-grok-4.6-low-fast',
      'cursor-grok-4.6-medium-fast',
      'cursor-grok-4.6-high-fast',
      'cursor-grok-4.6-xhigh-fast'
    ],
    resolveBearer: async () => 'private-cursor-access-fixture',
    upstreamOrigin: provider.url
  })
  const ref = { provider: 'cursor', id: 'cursor-grok-4.6-fast' }
  let closing: Promise<void> | undefined
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      await fixture.close()
      await scoped.close()
      await provider.close()
    })())
  try {
    const runtime = await fixture.create({
      transport: {
        ...fixture.defaults.transport,
        models: [ref],
        gateway: {
          async createModelGatewayLease(params: { sessionId: string; generation: number }) {
            let finish!: () => void
            const closed = new Promise<void>((resolve) => {
              finish = resolve
            })
            return {
              leaseId: `lease-${params.generation}`,
              sessionId: params.sessionId,
              generation: params.generation,
              localPort: scoped.port,
              bearerToken: randomBytes(32).toString('base64url'),
              cursor: { localPort: scoped.port, bearerToken: token },
              models: [
                {
                  ...ref,
                  name: 'Grok 4.6 Fast',
                  reasoning: true,
                  input: ['text' as const],
                  contextWindow: 256000,
                  maxTokens: 16384
                }
              ],
              closed,
              async close() {
                finish()
              }
            }
          }
        }
      },
      params: {
        ...fixture.defaults.params,
        model: { ...ref, name: 'Grok 4.6 Fast', reasoning: true, supportsImages: false },
        thinkingLevel: 'high'
      },
      action: { type: 'new', model: ref }
    })
    const rpc = (runtime as unknown as { connection: RpcConnection }).connection
    return {
      provider,
      cli: {
        connection: {
          prompt: async (text: string) => (await runtime.prompt(randomUUID(), text)).result,
          request: <T>(request: Parameters<RpcConnection['request']>[0]) => rpc.request<T>(request),
          onEvent: (listener: Parameters<RpcConnection['onEvent']>[0]) => rpc.onEvent(listener),
          abort: () => runtime.stop()
        },
        stderr: () => ''
      },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
