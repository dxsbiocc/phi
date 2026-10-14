import { RpcSessionBackend } from '../../src/main/agent/engine/rpc/rpc-session-backend'
import type { BasicEngineFixture } from './basic-suite'
import { createLocalStdioFixture } from './local-stdio-factory'

export async function createRpcFixture(): Promise<
  BasicEngineFixture & {
    backend: RpcSessionBackend
    kill(sessionId: string): Promise<void>
  }
> {
  const fixture = await createLocalStdioFixture()
  const backend = new RpcSessionBackend(fixture.open, {
    startupTimeoutMs: 15000,
    requestTimeoutMs: 10000
  })
  const ids = new Set<string>()
  let closing: Promise<void> | undefined
  return {
    sessions: backend,
    backend,
    provider: fixture.provider,
    onSessionEvent: (id, listener) => backend.onSessionEvent(id, listener),
    params(sessionId) {
      ids.add(sessionId)
      return {
        sessionId,
        cwd: fixture.cwd,
        agentDir: fixture.agentDir,
        model: {
          provider: 'phi-contract',
          id: 'contract-model',
          name: 'Contract Model',
          reasoning: false
        }
      }
    },
    kill: (id) => fixture.kill(id),
    close() {
      closing ??= (async () => {
        try {
          await Promise.all([...ids].map((sessionId) => backend.dispose({ sessionId })))
        } finally {
          await fixture.close()
        }
      })()
      return closing
    }
  }
}
