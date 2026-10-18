import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

type ElectronNet = { net?: { fetch: typeof globalThis.fetch } }

/**
 * Downloads made on behalf of the desktop use Chromium networking, so the operating
 * system's proxy settings apply the same way they do in a browser. Plain Node and
 * isolated tests have no Electron network stack and fall back to the global fetch.
 */
export function desktopFetch(
  override?: typeof globalThis.fetch,
  loadElectron: () => unknown = () => nodeRequire('electron')
): typeof globalThis.fetch {
  if (override) return override
  try {
    const electron = loadElectron() as ElectronNet | string
    if (typeof electron === 'object' && electron.net?.fetch) {
      return electron.net.fetch.bind(electron.net)
    }
  } catch {
    // Not running inside Electron's main process.
  }
  return globalThis.fetch
}
