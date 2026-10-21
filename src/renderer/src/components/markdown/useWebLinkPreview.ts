import { useEffect, useState } from 'react'
import type { WebLinkPreview } from '../../../../shared/webLinkPreviewTypes'
import { webLinkPreviewCache } from '../../lib/webLinkPreviewCache'

export function useWebLinkPreview(
  url: string,
  active: boolean
): { preview: WebLinkPreview | null; loading: boolean } {
  const [result, setResult] = useState<{ url: string; value: WebLinkPreview | null } | null>(null)
  const cached = webLinkPreviewCache.peek(url)
  const value = result?.url === url ? result.value : cached

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let attempts = 0
    let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined
    const load = (): void => {
      void webLinkPreviewCache.read(url).then((preview) => {
        if (cancelled) return
        // A full in-flight queue returns null without caching. Retry instead of
        // treating that temporary refusal as a missing site icon.
        const shed = preview === null && webLinkPreviewCache.peek(url) === undefined
        if (shed && attempts < 20) {
          attempts += 1
          retryTimer = globalThis.setTimeout(load, 300)
          return
        }
        setResult({ url, value: preview })
      })
    }
    load()
    return () => {
      cancelled = true
      globalThis.clearTimeout(retryTimer)
    }
  }, [active, url])

  return { preview: value ?? null, loading: value === undefined }
}
