import type { RemoteRuntimeWorkspace } from '../../src/main/agent/remote-runtime/types'
import type { WorkspaceHost } from '../../src/main/agent/workspace-host/types'

export interface HostOperationSnapshot {
  total: number
  fs: number
  exec: number
  methods: Readonly<Record<string, number>>
}

export interface HostOperationCounter {
  snapshot(): HostOperationSnapshot
  reset(): void
}

export function countWorkspaceHostOperations(
  workspace: RemoteRuntimeWorkspace
): HostOperationCounter {
  const methods = new Map<string, number>()
  workspace.projectHost = countedHost(workspace.projectHost, 'project', methods)
  workspace.runtimeHost = countedHost(workspace.runtimeHost, 'runtime', methods)
  const execWithInput = workspace.execWithInput
  workspace.execWithInput = (...args) => {
    methods.set('runtime.exec.input', (methods.get('runtime.exec.input') ?? 0) + 1)
    return execWithInput(...args)
  }
  return {
    snapshot: () => snapshot(methods),
    reset: () => methods.clear()
  }
}

function countedHost(
  host: WorkspaceHost,
  scope: 'project' | 'runtime',
  methods: Map<string, number>
): WorkspaceHost {
  const call = <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    methods.set(`${scope}.${name}`, (methods.get(`${scope}.${name}`) ?? 0) + 1)
    return operation()
  }
  return {
    fs: {
      glob: (...args) => call('fs.glob', () => host.fs.glob(...args)),
      list: (...args) => call('fs.list', () => host.fs.list(...args)),
      mkdirp: (...args) => call('fs.mkdirp', () => host.fs.mkdirp(...args)),
      readRange: (...args) => call('fs.readRange', () => host.fs.readRange(...args)),
      remove: (...args) => call('fs.remove', () => host.fs.remove(...args)),
      stat: (...args) => call('fs.stat', () => host.fs.stat(...args)),
      writeAtomic: (...args) => call('fs.writeAtomic', () => host.fs.writeAtomic(...args))
    },
    exec: {
      run: (...args) => call('exec.run', () => host.exec.run(...args)),
      spawnBackground: (...args) =>
        call('exec.spawnBackground', () => host.exec.spawnBackground(...args))
    },
    capabilities: () => host.capabilities(),
    ...(host.pty ? { pty: host.pty } : {}),
    ...(host.watch ? { watch: host.watch } : {}),
    ...(host.forwardPort ? { forwardPort: host.forwardPort } : {}),
    ...(host.close ? { close: () => host.close!() } : {})
  }
}

function snapshot(methods: ReadonlyMap<string, number>): HostOperationSnapshot {
  const entries = [...methods.entries()].sort(([left], [right]) => left.localeCompare(right))
  const sum = (kind?: '.fs.' | '.exec.'): number =>
    entries.reduce((total, [name, count]) => total + (kind && !name.includes(kind) ? 0 : count), 0)
  return {
    total: sum(),
    fs: sum('.fs.'),
    exec: sum('.exec.'),
    methods: Object.fromEntries(entries)
  }
}
