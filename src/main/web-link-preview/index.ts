import type { WebLinkPreview } from '../../shared/webLinkPreviewTypes'
import { rasterIconDataUrl, readHeadMetadata } from './metadata'
import { createPreviewFetcher, type PreviewFetcher } from './transport'
import { checkedPreviewUrl, withAbort } from './urlSafety'

type CachedPreview = Omit<WebLinkPreview, 'url'>

interface PreviewServiceOptions {
  fetch?: PreviewFetcher
  now?: () => number
  timeoutMs?: number
  cacheEntries?: number
  concurrency?: number
}

/** Hover-only metadata requests use an isolated, bounded cache, never browser sessions. */
export function createWebLinkPreviewService(options: PreviewServiceOptions = {}): {
  get: (input: unknown) => Promise<WebLinkPreview>
} {
  const fetch = options.fetch ?? createPreviewFetcher()
  const now = options.now ?? Date.now
  const cache = new Map<string, { value: CachedPreview; expires: number }>()
  const pending = new Map<string, Promise<CachedPreview>>()
  const capacity = Math.min(Math.max(options.cacheEntries ?? 100, 1), 100)
  const concurrency = Math.min(Math.max(options.concurrency ?? 4, 1), 6)
  let active = 0

  const fallback = (url: string): CachedPreview => ({
    resolvedUrl: url,
    title: null,
    description: null,
    siteName: null,
    iconDataUrl: null
  })

  async function load(url: string): Promise<CachedPreview> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs ?? 6000, 6000))
    let result = fallback(url)
    try {
      const page = await withAbort(
        fetch(url, { signal: controller.signal, kind: 'html', maxBytes: 262_144 }),
        controller.signal
      )
      const metadata = readHeadMetadata(page.body.toString('utf8'))
      result = {
        ...result,
        resolvedUrl: page.url,
        title: metadata.title,
        description: metadata.description,
        siteName: metadata.siteName
      }
      const iconController = new AbortController()
      const abortIcon = (): void => iconController.abort()
      controller.signal.addEventListener('abort', abortIcon, { once: true })
      const iconTimer = setTimeout(abortIcon, 1500)
      try {
        const candidates = [...metadata.icons.slice(0, 2), '/favicon.ico']
        for (const href of candidates) {
          if (iconController.signal.aborted) break
          try {
            const iconUrl = checkedPreviewUrl(new URL(href, page.url).href).href
            const icon = await withAbort(
              fetch(iconUrl, { signal: iconController.signal, kind: 'icon', maxBytes: 65_536 }),
              iconController.signal
            )
            result.iconDataUrl = rasterIconDataUrl(icon.body, icon.contentType)
            if (result.iconDataUrl) break
          } catch {
            // Unavailable or non-raster icons leave the page metadata usable.
          }
        }
      } finally {
        clearTimeout(iconTimer)
        controller.signal.removeEventListener('abort', abortIcon)
        iconController.abort()
      }
    } catch {
      // Preview availability never blocks opening or copying the original link.
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
    return result
  }

  return {
    async get(input) {
      const original = typeof input === 'string' ? input : ''
      const parsed = checkedPreviewUrl(input)
      parsed.hash = ''
      const key = parsed.href
      const cached = cache.get(key)
      if (cached && cached.expires > now()) {
        cache.delete(key)
        cache.set(key, cached)
        return { ...cached.value, url: original }
      }
      cache.delete(key)
      let task = pending.get(key)
      if (!task) {
        if (active >= concurrency) return { ...fallback(key), url: original }
        active++
        task = load(key)
          .then((value) => {
            const useful = value.title || value.description || value.siteName || value.iconDataUrl
            cache.set(key, { value, expires: now() + (useful ? 600_000 : 30_000) })
            while (cache.size > capacity) cache.delete(cache.keys().next().value!)
            return value
          })
          .finally(() => {
            active--
            pending.delete(key)
          })
        pending.set(key, task)
      }
      return { ...(await task), url: original }
    }
  }
}
