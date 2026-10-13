// Bun preload for the actual worker. A missing selector must never reach a public
// fallback model during a negative contract test.
const originalFetch = globalThis.fetch
const guardedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error(`Engine contract blocked non-loopback fetch: ${url.origin}`)
  }
  return originalFetch(input, { ...init, redirect: 'error' })
}) as typeof fetch
Object.defineProperty(guardedFetch, 'preconnect', {
  value: (value: string | URL): void => {
    const url = new URL(value)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      throw new Error(`Engine contract blocked non-loopback preconnect: ${url.origin}`)
    }
    const preconnect = (originalFetch as typeof fetch & { preconnect?: (url: string) => void })
      .preconnect
    preconnect?.(url.href)
  }
})
globalThis.fetch = guardedFetch
