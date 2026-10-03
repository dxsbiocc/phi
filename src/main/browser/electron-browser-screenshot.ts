import {
  MAX_BROWSER_SCREENSHOT_BYTES,
  type EngineResult,
  type EngineTabState
} from './browser-engine'

export interface BrowserCapturedPageLike {
  toPNG(): Buffer
  getSize(): { width: number; height: number }
}

export interface ElectronScreenshotWebContentsLike {
  capturePage?: (
    rect?: { x: number; y: number; width: number; height: number },
    options?: { stayHidden?: boolean }
  ) => Promise<BrowserCapturedPageLike>
  isDestroyed?: () => boolean
}

export interface CaptureElectronBrowserScreenshotOptions {
  webContents: ElectronScreenshotWebContentsLike
  state: EngineTabState
  signal?: AbortSignal
  invalidated?: AbortSignal
  isCurrent: () => boolean
}

type CaptureRaceResult =
  | { type: 'captured'; image: BrowserCapturedPageLike }
  | { type: 'captureFailed' }
  | { type: 'cancelled' }
  | { type: 'invalidated' }

function rendererUnavailable(): EngineResult {
  return {
    ok: false,
    error: { code: 'RENDERER_CRASHED', message: 'Browser page is unavailable' }
  }
}

function isDestroyed(webContents: ElectronScreenshotWebContentsLike): boolean {
  try {
    return webContents.isDestroyed?.() ?? false
  } catch {
    return true
  }
}

function abortRace(
  signal: AbortSignal,
  type: 'cancelled' | 'invalidated',
  removeListeners: Array<() => void>
): Promise<CaptureRaceResult> {
  if (signal.aborted) return Promise.resolve({ type })
  return new Promise((resolve) => {
    const onAbort = (): void => resolve({ type })
    signal.addEventListener('abort', onAbort, { once: true })
    removeListeners.push(() => signal.removeEventListener('abort', onAbort))
  })
}

export async function captureElectronBrowserScreenshot(
  options: CaptureElectronBrowserScreenshotOptions
): Promise<EngineResult> {
  const { webContents } = options
  if (typeof webContents.capturePage !== 'function') {
    return {
      ok: false,
      error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Browser command is unavailable' }
    }
  }
  if (isDestroyed(webContents)) return rendererUnavailable()

  const documentRevision = options.state.documentRevision
  let capture: Promise<BrowserCapturedPageLike>
  try {
    capture = webContents.capturePage(undefined, { stayHidden: true })
  } catch {
    return {
      ok: false,
      error: { code: 'RENDERER_CRASHED', message: 'Browser screenshot capture failed' }
    }
  }
  const removeListeners: Array<() => void> = []
  const races: Array<Promise<CaptureRaceResult>> = [
    capture.then<CaptureRaceResult, CaptureRaceResult>(
      (image) => ({ type: 'captured', image }),
      () => ({ type: 'captureFailed' })
    )
  ]
  if (options.signal) races.push(abortRace(options.signal, 'cancelled', removeListeners))
  if (options.invalidated) {
    races.push(abortRace(options.invalidated, 'invalidated', removeListeners))
  }
  const captured = await Promise.race(races).finally(() => {
    for (const remove of removeListeners) remove()
  })
  if (captured.type === 'cancelled') {
    return {
      ok: false,
      error: { code: 'ACTION_CANCELLED', message: 'Browser action was cancelled' }
    }
  }
  if (captured.type === 'invalidated' || !options.isCurrent()) {
    return {
      ok: false,
      error: { code: 'TAB_NOT_FOUND', message: 'Browser tab was not found' }
    }
  }
  if (captured.type === 'captureFailed') {
    return {
      ok: false,
      error: { code: 'RENDERER_CRASHED', message: 'Browser screenshot capture failed' }
    }
  }
  if (options.signal?.aborted) {
    return {
      ok: false,
      error: { code: 'ACTION_CANCELLED', message: 'Browser action was cancelled' }
    }
  }
  if (isDestroyed(webContents)) return rendererUnavailable()
  if (options.state.documentRevision !== documentRevision) {
    return {
      ok: false,
      error: { code: 'STALE_DOCUMENT', message: 'Browser page changed during capture' }
    }
  }

  try {
    const png = captured.image.toPNG()
    const { width, height } = captured.image.getSize()
    if (
      png.byteLength === 0 ||
      png.byteLength > MAX_BROWSER_SCREENSHOT_BYTES ||
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0
    ) {
      return {
        ok: false,
        error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Browser screenshot is unavailable' }
      }
    }
    return {
      ok: true,
      state: { ...options.state },
      screenshot: {
        mediaType: 'image/png',
        data: png.toString('base64'),
        width,
        height,
        documentRevision
      }
    }
  } catch {
    return {
      ok: false,
      error: { code: 'RENDERER_CRASHED', message: 'Browser screenshot capture failed' }
    }
  }
}
