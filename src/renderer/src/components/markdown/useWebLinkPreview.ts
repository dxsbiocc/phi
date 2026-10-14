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
    void webLinkPreviewCache.read(url).then((preview) => {
      if (!cancelled) setResult({ url, value: preview })
    })
    return () => {
      cancelled = true
    }
  }, [active, url])

  return { preview: value ?? null, loading: value === undefined }
}
