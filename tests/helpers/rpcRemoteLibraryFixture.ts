import { join } from 'node:path'
import { createRemoteRuntimeFixture, type RemoteRuntimeFixture } from './remoteRuntimeFixture'
import { installFlockShim } from './flockShim'
import { RemoteLibraryService } from '../../src/main/agent/engine/rpc/remote-library-service'
import type {
  RemoteLibraryIdentity,
  RemoteLibraryTarget
} from '../../src/main/agent/engine/rpc/remote-library-types'
import {
  createRpcDesktopToolScope,
  type RpcDesktopToolRun
} from '../../src/main/agent/engine/rpc/desktop-tool-scope'
import { HostServiceRegistry } from '../../src/main/agent/engine/host-service-registry'
import { BrowserTextVault } from '../../src/main/agent/browser/browser-text-vault'
import type { PhiToolResult } from '../../src/main/agent/engine/types'

export interface RemoteLibraryFixture {
  server: RemoteRuntimeFixture
  service: RemoteLibraryService
  services: HostServiceRegistry
  target: RemoteLibraryTarget
  identity: RemoteLibraryIdentity
  scope: ReturnType<typeof createRpcDesktopToolScope>
  call(name: string, input?: Record<string, unknown>, signal?: AbortSignal): Promise<PhiToolResult>
  close(): Promise<void>
}
export function rpcRemoteLibraryFixture(
  options: {
    currentRun?: () => RpcDesktopToolRun | undefined
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
  const services = new HostServiceRegistry()
  services.register('library.execute', (request, context) => service.execute(request, context))
  services.register('library.cancel', (request, context) => service.cancel(request, context))
  const run = { id: 'remote-library-run', signal: new AbortController().signal }
  const scope = createRpcDesktopToolScope({
    identity: { ...identity, cwd: server.projectRoot },
    services,
    currentRun: options.currentRun ?? (() => run),
    recentUserImages: () => [],
    allowBrowserTypeText: () => false,
    browserTextVault: new BrowserTextVault(),
    agentDir: server.localAnchor,
    allowedSkills: [],
    scriptTools: [],
    remoteLibrary: true
  })
  let call = 0
  return {
    server,
    service,
    services,
    target,
    identity,
    scope,
    async call(name, input = {}, signal) {
      const tool = scope.tools.find((tool) => tool.name === name)
      if (!tool) throw new Error('Missing library tool')
      return tool.execute(
        `library-call-${++call}`,
        input,
        undefined,
        { cwd: server.projectRoot, recentUserImages: () => [] },
        signal
      )
    },
    async close() {
      scope.dispose()
      service.dispose()
      await Promise.all(server.sessions.map((session) => session.close()))
      restoreFlock()
      if (!options.server) server.cleanup()
    }
  }
}
