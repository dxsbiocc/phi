import type { WebContents } from 'electron'
import {
  BROWSER_MAX_SCROLL_DELTA,
  BROWSER_SAFE_KEYS,
  BROWSER_SAFE_MODIFIERS
} from '../../shared/browserTypes'
import type { EngineCommand, EngineResult, EngineTabState } from './browser-engine'

export type ElectronBrowserViewBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type ElectronBrowserScreenshotLease = {
  width: number
  height: number
  documentRevision: number
  bounds: ElectronBrowserViewBounds
}

type ElectronBrowserInputEvent = Parameters<WebContents['sendInputEvent']>[0]

export interface ElectronBrowserInputTarget {
  state: EngineTabState
  presented: boolean
  latestScreenshot?: ElectronBrowserScreenshotLease
  view: {
    getBounds?: () => ElectronBrowserViewBounds
    webContents: {
      focus?: WebContents['focus']
      sendInputEvent?: WebContents['sendInputEvent']
    }
  }
  window: {
    isMinimized(): boolean
    isVisible(): boolean
    isFocused?: () => boolean
  }
}

type BrowserInputCommand = Extract<EngineCommand, { type: 'click' | 'scroll' | 'keypress' }>

type PreparedBrowserInput =
  | {
      ok: true
      screenshot: ElectronBrowserScreenshotLease
      bounds: ElectronBrowserViewBounds
    }
  | { ok: false; result: EngineResult }

function unavailable(): EngineResult {
  return {
    ok: false,
    error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Browser command is unavailable' }
  }
}

export function readElectronBrowserViewBounds(
  target: Pick<ElectronBrowserInputTarget, 'view'>
): ElectronBrowserViewBounds | null {
  if (typeof target.view.getBounds !== 'function') return null
  try {
    const bounds = target.view.getBounds()
    return Number.isSafeInteger(bounds.x) &&
      Number.isSafeInteger(bounds.y) &&
      Number.isSafeInteger(bounds.width) &&
      bounds.width > 0 &&
      Number.isSafeInteger(bounds.height) &&
      bounds.height > 0
      ? { ...bounds }
      : null
  } catch {
    return null
  }
}

export function sameElectronBrowserViewBounds(
  left: ElectronBrowserViewBounds,
  right: ElectronBrowserViewBounds
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

function inputContext(
  target: ElectronBrowserInputTarget,
  expectedDocumentRevision: number,
  signal?: AbortSignal
): PreparedBrowserInput {
  if (signal?.aborted) {
    return {
      ok: false,
      result: {
        ok: false,
        error: { code: 'ACTION_CANCELLED', message: 'Browser action was cancelled' }
      }
    }
  }
  const screenshot = target.latestScreenshot
  if (
    !screenshot ||
    target.state.isLoading ||
    target.state.documentRevision !== expectedDocumentRevision ||
    screenshot.documentRevision !== expectedDocumentRevision
  ) {
    return {
      ok: false,
      result: {
        ok: false,
        error: { code: 'STALE_DOCUMENT', message: 'Browser screenshot is stale' }
      }
    }
  }
  if (
    !target.presented ||
    target.window.isMinimized() ||
    !target.window.isVisible() ||
    target.window.isFocused?.() !== true ||
    typeof target.view.webContents.focus !== 'function' ||
    typeof target.view.webContents.sendInputEvent !== 'function'
  ) {
    return { ok: false, result: unavailable() }
  }
  const bounds = readElectronBrowserViewBounds(target)
  if (!bounds || !sameElectronBrowserViewBounds(bounds, screenshot.bounds)) {
    target.latestScreenshot = undefined
    return {
      ok: false,
      result: {
        ok: false,
        error: { code: 'STALE_DOCUMENT', message: 'Browser screenshot is stale' }
      }
    }
  }
  return { ok: true, screenshot, bounds }
}

function prepareInput(
  target: ElectronBrowserInputTarget,
  expectedDocumentRevision: number,
  signal?: AbortSignal
): PreparedBrowserInput {
  const first = inputContext(target, expectedDocumentRevision, signal)
  if (!first.ok) return first
  try {
    target.view.webContents.focus?.()
  } catch {
    return { ok: false, result: unavailable() }
  }
  return inputContext(target, expectedDocumentRevision, signal)
}

function deliveryFailed(): EngineResult {
  return {
    ok: false,
    error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Browser input delivery failed' }
  }
}

function sendPairedInput(
  target: ElectronBrowserInputTarget,
  down: ElectronBrowserInputEvent,
  up: ElectronBrowserInputEvent
): EngineResult {
  const sendInputEvent = target.view.webContents.sendInputEvent
  if (typeof sendInputEvent !== 'function') return unavailable()
  let downDelivered = false
  try {
    sendInputEvent.call(target.view.webContents, down)
    downDelivered = true
    sendInputEvent.call(target.view.webContents, up)
    return { ok: true, state: { ...target.state } }
  } catch {
    if (downDelivered) {
      try {
        sendInputEvent.call(target.view.webContents, up)
      } catch {
        // A release was attempted. Replaying the full action would be less safe.
      }
    }
    return deliveryFailed()
  }
}

export function executeElectronBrowserInput(
  target: ElectronBrowserInputTarget,
  command: BrowserInputCommand,
  signal?: AbortSignal,
  options: { alreadyFocused?: boolean } = {}
): EngineResult {
  const input = options.alreadyFocused
    ? inputContext(target, command.expectedDocumentRevision, signal)
    : prepareInput(target, command.expectedDocumentRevision, signal)
  if (!input.ok) return input.result

  if (command.type === 'click') {
    if (
      !Number.isFinite(command.x) ||
      command.x < 0 ||
      command.x >= input.screenshot.width ||
      !Number.isFinite(command.y) ||
      command.y < 0 ||
      command.y >= input.screenshot.height
    ) {
      return {
        ok: false,
        error: { code: 'STALE_DOCUMENT', message: 'Browser screenshot coordinates are stale' }
      }
    }
    const x = Math.floor((command.x * input.bounds.width) / input.screenshot.width)
    const y = Math.floor((command.y * input.bounds.height) / input.screenshot.height)
    target.latestScreenshot = undefined
    return sendPairedInput(
      target,
      { type: 'mouseDown', x, y, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x, y, button: 'left', clickCount: 1 }
    )
  }

  if (command.type === 'scroll') {
    if (
      !Number.isSafeInteger(command.deltaX) ||
      !Number.isSafeInteger(command.deltaY) ||
      Math.abs(command.deltaX) > BROWSER_MAX_SCROLL_DELTA ||
      Math.abs(command.deltaY) > BROWSER_MAX_SCROLL_DELTA ||
      (command.deltaX === 0 && command.deltaY === 0)
    ) {
      return {
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: 'Browser scroll was not permitted' }
      }
    }
    try {
      target.latestScreenshot = undefined
      target.view.webContents.sendInputEvent?.({
        type: 'mouseWheel',
        x: Math.floor(input.bounds.width / 2),
        y: Math.floor(input.bounds.height / 2),
        deltaX: command.deltaX,
        deltaY: command.deltaY,
        canScroll: true,
        hasPreciseScrollingDeltas: true
      })
      return { ok: true, state: { ...target.state } }
    } catch {
      return deliveryFailed()
    }
  }

  const safeKeys = new Set<string>(BROWSER_SAFE_KEYS)
  if (
    !safeKeys.has(command.key) ||
    (command.modifiers !== undefined &&
      (command.modifiers.length > 1 ||
        (command.modifiers.length === 1 && !BROWSER_SAFE_MODIFIERS.includes(command.modifiers[0]))))
  ) {
    return {
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: 'Browser key was not permitted' }
    }
  }
  const modifiers = command.modifiers ? [...command.modifiers] : undefined
  target.latestScreenshot = undefined
  return sendPairedInput(
    target,
    { type: 'keyDown', keyCode: command.key, ...(modifiers ? { modifiers } : {}) },
    { type: 'keyUp', keyCode: command.key, ...(modifiers ? { modifiers } : {}) }
  )
}
