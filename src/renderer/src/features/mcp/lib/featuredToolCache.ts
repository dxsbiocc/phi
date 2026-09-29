const TOOL_LIST_CACHE_MS = 5 * 60_000
const toolNamesByConnector = new Map<string, { names: string[]; expiresAt: number }>()

export function cachedFeaturedToolNames(id: string): string[] | null {
  const cached = toolNamesByConnector.get(id)
  if (!cached || cached.expiresAt <= Date.now()) {
    toolNamesByConnector.delete(id)
    return null
  }
  return cached.names
}

export function cacheFeaturedToolNames(id: string, names: string[]): void {
  toolNamesByConnector.set(id, { names, expiresAt: Date.now() + TOOL_LIST_CACHE_MS })
}

export function clearFeaturedToolNames(id: string): void {
  toolNamesByConnector.delete(id)
}
