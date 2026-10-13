export interface StartupWindow {
  isDestroyed: () => boolean
  setBackgroundColor: (color: string) => void
  show: () => void
}

function isOpaqueBackground(input: unknown): input is string {
  if (typeof input !== 'string') return false
  if (/^#[\da-f]{6}$/i.test(input)) return true
  const rgb =
    input.match(/^rgb\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\)$/) ??
    input.match(/^rgba\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3}),\s*1\)$/)
  return Boolean(rgb && rgb.slice(1).every((channel) => Number(channel) <= 255))
}

// Keep the main window hidden behind the standalone splash until Chromium has
// painted and React reports its first usable frame and selected theme.
export function createMainWindowStartup(
  window: StartupWindow,
  onFailure: (reason: string) => void,
  timeoutMs = 15_000,
  onReady?: () => void
): {
  painted: () => void
  rendererReady: (background: unknown) => void
  fail: (reason: string) => void
  retry: () => boolean
  dispose: () => void
} {
  let painted = false
  let rendererReady = false
  let shown = false
  let failed = false
  let disposed = false
  let completed = false
  let timer: ReturnType<typeof setTimeout>

  const clearTimer = (): void => clearTimeout(timer)
  const reveal = (): void => {
    if (disposed || failed || shown || window.isDestroyed() || !painted || !rendererReady) return
    shown = true
    window.show()
  }
  const completeIfReady = (): void => {
    if (!painted || !rendererReady || completed) return
    completed = true
    clearTimer()
    if (onReady) onReady()
    else reveal()
  }
  const fail = (reason: string): void => {
    if (disposed || (rendererReady && painted) || failed || window.isDestroyed()) return
    failed = true
    clearTimer()
    onFailure(reason)
  }
  const armTimer = (): void => {
    timer = setTimeout(() => fail('renderer-ready-timeout'), timeoutMs)
    timer.unref?.()
  }
  armTimer()

  return {
    painted: () => {
      painted = true
      completeIfReady()
    },
    rendererReady: (background) => {
      if (!isOpaqueBackground(background)) throw new Error('Invalid window background')
      if (disposed || failed || window.isDestroyed()) return
      window.setBackgroundColor(background)
      rendererReady = true
      completeIfReady()
    },
    fail,
    retry: () => {
      if (disposed || !failed || window.isDestroyed()) return false
      failed = false
      rendererReady = false
      clearTimer()
      armTimer()
      return true
    },
    dispose: () => {
      disposed = true
      clearTimer()
    }
  }
}
