import type { CreateAgentSessionOptions, RuntimeResourceLoader } from './runtime-adapter'

export function trustedKernelSessionIdentity(options: CreateAgentSessionOptions): {
  phiSessionId?: string
} {
  if (!options.phiSessionId) return {}
  return { phiSessionId: options.phiSessionId }
}

function contextFile(value: unknown): { path: string; content: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const file = value as { path?: unknown; content?: unknown }
  if (typeof file.path !== 'string' || typeof file.content !== 'string') return undefined
  return { path: file.path, content: file.content }
}

export function trustedContextFiles(
  options: CreateAgentSessionOptions,
  resourceLoader: RuntimeResourceLoader | undefined
): Array<{ path: string; content: string }> | undefined {
  const loaded = resourceLoader?.getAgentsFiles()
  const loadedFiles =
    loaded && typeof loaded === 'object' && !Array.isArray(loaded)
      ? (loaded as { agentsFiles?: unknown }).agentsFiles
      : undefined
  const value = options.contextFiles ?? options.remoteProject?.contextFiles ?? loadedFiles
  if (!Array.isArray(value)) return undefined
  return value.flatMap((candidate) => {
    const file = contextFile(candidate)
    return file ? [file] : []
  })
}

export function trustedMcpServers(
  options: CreateAgentSessionOptions
): Array<{ name: string; config: Record<string, unknown> }> | undefined {
  if (options.mcpServers) return options.mcpServers
  return options.remoteProjectMcpServers?.map(({ name, config }) => ({
    name,
    config: structuredClone(config)
  }))
}

export function selectedResourceLoader(value: unknown): RuntimeResourceLoader | undefined {
  return value &&
    typeof value === 'object' &&
    (value as { __phiResourceLoader?: unknown }).__phiResourceLoader === true
    ? (value as RuntimeResourceLoader)
    : undefined
}

export function resourceToolCallHandlers(
  loader: RuntimeResourceLoader | undefined
): ReturnType<RuntimeResourceLoader['getToolCallHandlers']> {
  return loader ? loader.getToolCallHandlers() : Promise.resolve([])
}
