import { join } from 'node:path'
import { createRemoteRuntimeFixture, type RemoteRuntimeFixture } from './remoteRuntimeFixture'
import { installFlockShim } from './flockShim'
import { RemoteLibraryService } from '../../src/main/agent/engine/rpc/remote-library-service'
import type {
  RemoteLibraryIdentity,
  RemoteLibraryTarget
} from '../../src/main/agent/engine/rpc/remote-library-types'
import {
  buildLibraryCustomTools,
  type LibraryToolAction,
  type LibraryToolStore
} from '../../src/main/agent/library/library-tools'
import type { PhiToolResult } from '../../src/main/agent/engine/types'

export interface RemoteLibraryFixture {
  server: RemoteRuntimeFixture
  service: RemoteLibraryService
  target: RemoteLibraryTarget
  identity: RemoteLibraryIdentity
  call(name: string, input?: Record<string, unknown>, signal?: AbortSignal): Promise<PhiToolResult>
  close(): Promise<void>
}
export function rpcRemoteLibraryFixture(
  options: {
    identity?: RemoteLibraryIdentity
    server?: RemoteRuntimeFixture
  } = {}
): RemoteLibraryFixture {
  const server = options.server ?? createRemoteRuntimeFixture()
  const restoreFlock = installFlockShim(join(server.root, 'flock-shim'))
  const identity = options.identity ?? {
    runtimeSessionId: 'remote-library-runtime',
    sessionId: 'remote-library-phi',
    projectId: 'remote-library-project'
  }
  const target: RemoteLibraryTarget = {
    workspace: server.workspace,
    openLockStdio: async (command) => (await server.connect()).openStdio!(command)
  }
  const service = new RemoteLibraryService(async (requested) => {
    if (JSON.stringify(requested) !== JSON.stringify(identity))
      throw new Error('Unverified selected remote library identity')
    return target
  })
  let request = 0
  async function execute<T>(
    action: LibraryToolAction,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    signal?.throwIfAborted()
    const suffix = ++request
    const toolCallId = `library-call-${suffix}`
    return (await service.execute(
      {
        ...identity,
        requestId: `library-request-${suffix}`,
        toolCallId,
        action,
        input
      },
      { originSessionId: identity.runtimeSessionId, toolCallId, signal }
    )) as T
  }
  const tools = buildLibraryCustomTools((_context, signal): LibraryToolStore => ({
    save: (input) => execute('save', input as Record<string, unknown>, signal),
    update: (id, patch) => execute('update', { id, patch }, signal),
    remove: (id) => execute('remove', { id }, signal),
    list: (filters) => execute('list', filters as Record<string, unknown>, signal),
    find: (query, filters) => execute('find', { query, filters }, signal),
    audit: () => execute('audit', {}, signal)
  }))
  return {
    server,
    service,
    target,
    identity,
    async call(name, input = {}, signal) {
      signal?.throwIfAborted()
      const tool = tools.find((tool) => tool.name === name)
      if (!tool) throw new Error('Missing library tool')
      const result = await tool.execute(
        `library-tool-${request + 1}`,
        input,
        undefined,
        { cwd: server.projectRoot, recentUserImages: () => [] },
        signal
      )
      signal?.throwIfAborted()
      return result
    },
    async close() {
      service.dispose()
      await Promise.all(server.sessions.map((session) => session.close()))
      restoreFlock()
      if (!options.server) server.cleanup()
    }
  }
}
