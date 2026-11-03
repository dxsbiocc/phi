/**
 * A session keeps the Cursor row it started with, but a remote kernel's Cursor tunnel moves
 * whenever the desktop reconnects. Each request follows the route configured last.
 */
export function withCurrentCursorRoute<T extends { provider: string; baseUrl?: string }>(
  model: T,
  baseUrl: string | undefined
): T {
  if (!baseUrl || model.provider !== 'cursor' || model.baseUrl === baseUrl) return model
  return { ...model, baseUrl }
}

/** Only the bundled Cursor endpoint needs Phi's Bun-to-Node HTTP/2 bridge. */
export async function cursorModelWithBridge<T extends { provider: string; baseUrl?: string }>(
  model: T | undefined,
  ensureBridge: () => Promise<string>
): Promise<T | undefined> {
  if (!model || model.provider !== 'cursor') return model
  if (model.baseUrl) {
    try {
      const configured = new URL(model.baseUrl)
      if (
        configured.origin !== 'https://api2.cursor.sh' ||
        configured.pathname !== '/' ||
        configured.search ||
        configured.hash
      ) {
        return model
      }
    } catch {
      return model
    }
  }
  const baseUrl = await ensureBridge()
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(baseUrl)) {
    throw new Error('Cursor HTTP/2 桥接不可用')
  }
  return { ...model, baseUrl }
}
