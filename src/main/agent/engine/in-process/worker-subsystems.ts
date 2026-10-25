export type WorkerSubsystemName = 'decision' | 'mcp' | 'memory' | 'modelGateway'

type WorkerSubsystemHandle = {
  value?: unknown
  close(): void | Promise<void>
}

type WorkerSubsystemLoaders = Record<WorkerSubsystemName, () => Promise<WorkerSubsystemHandle>>

export function createWorkerSubsystemRegistry(loaders: WorkerSubsystemLoaders): {
  load(name: WorkerSubsystemName): Promise<WorkerSubsystemHandle>
  loaded(): WorkerSubsystemName[]
  closeLoaded(): Promise<void>
} {
  const modules = new Map<WorkerSubsystemName, Promise<WorkerSubsystemHandle>>()
  return {
    load(name) {
      const existing = modules.get(name)
      if (existing) return existing
      const loaded = loaders[name]().catch((error: unknown) => {
        modules.delete(name)
        throw error
      })
      modules.set(name, loaded)
      return loaded
    },
    loaded() {
      return [...modules.keys()]
    },
    async closeLoaded() {
      await Promise.allSettled([...modules.values()].map(async (loaded) => (await loaded).close()))
    }
  }
}

const workerSubsystems = createWorkerSubsystemRegistry({
  decision: async () => {
    const value = await import('./decision-runtime')
    return { value, close: () => value.closeDecisionRuntime() }
  },
  mcp: async () => {
    const [value, desktop] = await Promise.all([
      import('./mcp-runtime'),
      import('./desktop-mcp-runtime')
    ])
    return { value, close: () => desktop.closeAllDesktopMcpScopes() }
  },
  memory: async () => {
    const value = await import('../rpc/desktop-project-memory-runtime')
    return { value, close: () => value.closeAllDesktopProjectMemory() }
  },
  modelGateway: async () => {
    const value = await import('./model-gateway')
    return { value, close: () => value.closeAllModelGatewayLeases() }
  }
})

export async function loadWorkerDecisionRuntime(): Promise<typeof import('./decision-runtime')> {
  return (await workerSubsystems.load('decision')).value as typeof import('./decision-runtime')
}

export async function loadWorkerMcpRuntime(): Promise<typeof import('./mcp-runtime')> {
  return (await workerSubsystems.load('mcp')).value as typeof import('./mcp-runtime')
}

export async function memoryRuntime(): Promise<
  typeof import('../rpc/desktop-project-memory-runtime')
> {
  return (await workerSubsystems.load('memory'))
    .value as typeof import('../rpc/desktop-project-memory-runtime')
}

export async function modelGatewayRuntime(): Promise<typeof import('./model-gateway')> {
  return (await workerSubsystems.load('modelGateway')).value as typeof import('./model-gateway')
}

export async function closeLoadedWorkerSubsystems(): Promise<void> {
  await workerSubsystems.closeLoaded()
}
