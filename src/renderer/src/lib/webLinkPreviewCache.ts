import type { WebLinkPreview } from '../../../shared/webLinkPreviewTypes'
import { getRendererApi } from './rendererApi'

type PreviewReader = (url: string) => Promise<WebLinkPreview | null>

export function createWebLinkPreviewCache(
  read: PreviewReader,
  options: { now?: () => number; capacity?: number; ttlMs?: number; failureTtlMs?: number } = {}
): {
  peek: (url: string) => WebLinkPreview | null | undefined
  read: PreviewReader
} {
  const now = options.now ?? Date.now
  const capacity = Math.max(1, Math.floor(options.capacity ?? 100))
  const entries = new Map<string, { value: WebLinkPreview | null; expiresAt: number }>()
  const pending = new Map<string, Promise<WebLinkPreview | null>>()
  const peek = (url: string): WebLinkPreview | null | undefined => {
    const entry = entries.get(url)
    if (!entry) return undefined
    if (entry.expiresAt <= now()) {
      entries.delete(url)
      return undefined
    }
    entries.delete(url)
    entries.set(url, entry)
    return entry.value
  }

  return {
    peek,
    read: (url) => {
      const cached = peek(url)
      if (cached !== undefined) return Promise.resolve(cached)
      const inFlight = pending.get(url)
      if (inFlight) return inFlight
      if (pending.size >= 8) return Promise.resolve(null)
      const request = Promise.resolve()
        .then(() => read(url))
        .catch(() => null)
        .then((value) => {
          pending.delete(url)
          const available = Boolean(value?.title || value?.description || value?.iconDataUrl)
          entries.set(url, {
            value,
            expiresAt:
              now() +
              (available ? (options.ttlMs ?? 15 * 60_000) : (options.failureTtlMs ?? 30_000))
          })
          while (entries.size > capacity) entries.delete(entries.keys().next().value!)
          return value
        })
      pending.set(url, request)
      return request
    }
  }
}

export const webLinkPreviewCache = createWebLinkPreviewCache(async (url) => {
  const api = getRendererApi()
  return typeof api.getWebLinkPreview === 'function' ? api.getWebLinkPreview(url) : null
})
