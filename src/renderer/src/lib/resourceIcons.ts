import { RESOURCE_ICON_MAX_BYTES } from '../../../shared/resourceIconTypes'

type ResourceIconReader = (key: string) => Promise<string | null>

export type ResourceIconCache = {
  peek: (key: string) => string | null | undefined
  read: (key: string) => Promise<string | null>
  markFailed: (key: string, source: string) => void
}

function imageDataUrl(value: string | null): string | null {
  if (!value || value.length > Math.ceil(RESOURCE_ICON_MAX_BYTES / 3) * 4 + 80) return null
  const match =
    /^data:image\/(?:png|jpeg|webp|gif|svg\+xml|x-icon|vnd.microsoft.icon);base64,([a-z0-9+/]+={0,2})$/i.exec(
      value
    )
  if (!match) return null
  const payload = match[1]
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return payload.length % 4 === 0 && (payload.length / 4) * 3 - padding <= RESOURCE_ICON_MAX_BYTES
    ? value
    : null
}

/** Shares resolved and missing icons across features without retaining an unbounded image catalog. */
export function createResourceIconCache(
  reader: ResourceIconReader,
  capacity = 64
): ResourceIconCache {
  const entries = new Map<string, string | null>()
  const pending = new Map<string, Promise<string | null>>()
  const limit = Math.max(1, Math.floor(capacity))

  function peek(key: string): string | null | undefined {
    const value = entries.get(key)
    if (value !== undefined) {
      entries.delete(key)
      entries.set(key, value)
    }
    return value
  }

  function store(key: string, value: string | null): void {
    entries.delete(key)
    entries.set(key, value)
    while (entries.size > limit) entries.delete(entries.keys().next().value!)
  }

  return {
    peek,
    read(key) {
      const cached = peek(key)
      if (cached !== undefined) return Promise.resolve(cached)
      const inFlight = pending.get(key)
      if (inFlight) return inFlight
      const request = Promise.resolve()
        .then(() => reader(key))
        .then(imageDataUrl, () => null)
        .then((source) => {
          store(key, source)
          pending.delete(key)
          return source
        })
      pending.set(key, request)
      return request
    },
    markFailed(key, source) {
      if (entries.get(key) === source) store(key, null)
    }
  }
}

export const resourceIconCache = createResourceIconCache((key) => window.api.readResourceIcon(key))

type VisibilityObserver = Pick<IntersectionObserver, 'observe' | 'disconnect'>
type VisibilityObserverFactory = (
  callback: (entries: Pick<IntersectionObserverEntry, 'isIntersecting'>[]) => void
) => VisibilityObserver

/** Only visible mounted entries request image bytes; older webviews fall back to immediate loading. */
export function observeResourceIconVisibility(
  element: Element,
  onVisible: () => void,
  createObserver: VisibilityObserverFactory | undefined = typeof IntersectionObserver ===
  'undefined'
    ? undefined
    : (callback) => new IntersectionObserver(callback)
): () => void {
  if (!createObserver) {
    onVisible()
    return () => undefined
  }
  let active = true
  const observer = createObserver((entries) => {
    if (!active || !entries.some((entry) => entry.isIntersecting)) return
    active = false
    observer.disconnect()
    onVisible()
  })
  observer.observe(element)
  return () => {
    active = false
    observer.disconnect()
  }
}
