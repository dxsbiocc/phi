import {
  BROWSER_MAX_SCREENSHOT_COORDINATE,
  BROWSER_MAX_SCROLL_DELTA,
  BROWSER_SAFE_KEYS,
  BROWSER_SAFE_MODIFIERS,
  type BrowserActor,
  type BrowserCommand,
  type BrowserError,
  type BrowserViewport
} from '../../shared/browserTypes'
import type { BrowserScreenshot } from '../../shared/browserTypes'
import type { BrowserEngine, EngineCommand } from './browser-engine'
import type { BrowserTabCollection, BrowserTabRecord } from './browser-tab-collection'
import { isLoopbackBrowserHostname } from './browser-policy'
import { captureBrowserWorkspaceScreenshot } from './browser-workspace-screenshot'
import {
  reconcileEngineResult,
  safeBrowserEngineError,
  workspaceEngineResult
} from './browser-workspace-engine-state'

export type BrowserAgentActionCommand = Extract<
  BrowserCommand,
  { type: 'click' | 'scroll' | 'keypress' }
>

export function isBrowserAgentActionCommand(
  command: BrowserCommand
): command is BrowserAgentActionCommand {
  return command.type === 'click' || command.type === 'scroll' || command.type === 'keypress'
}

export function normalizeBrowserActionStabilityMs(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) >= 0
    ? Math.min(500, Math.floor(value as number))
    : 75
}

export type BrowserAgentScreenshotLease = {
  runId: string
  documentRevision: number
  width: number
  height: number
}

export class BrowserAgentScreenshotLeases {
  readonly #leases = new Map<string, BrowserAgentScreenshotLease>()
  readonly #viewports = new Map<string, BrowserViewport | null>()

  get(tabId: string): BrowserAgentScreenshotLease | undefined {
    return this.#leases.get(tabId)
  }

  remember(tabId: string, lease: BrowserAgentScreenshotLease): void {
    this.#leases.set(tabId, lease)
  }

  consume(tabId: string, runId: string, documentRevision: number): boolean {
    const lease = this.#leases.get(tabId)
    if (lease?.runId !== runId || lease.documentRevision !== documentRevision) return false
    this.#leases.delete(tabId)
    return true
  }

  invalidate(tabId: string): void {
    this.#leases.delete(tabId)
  }

  remove(tabId: string): void {
    this.#leases.delete(tabId)
    this.#viewports.delete(tabId)
  }

  viewportApplied(tabId: string, viewport: BrowserViewport | null): void {
    if (JSON.stringify(this.#viewports.get(tabId)) !== JSON.stringify(viewport)) {
      this.#leases.delete(tabId)
    }
    this.#viewports.set(tabId, viewport ? { ...viewport } : null)
    if (!viewport) return
    for (const otherTabId of this.#viewports.keys()) {
      if (otherTabId !== tabId) this.#leases.delete(otherTabId)
    }
  }

  clear(): void {
    this.#leases.clear()
    this.#viewports.clear()
  }

  invalidateAll(): void {
    this.#leases.clear()
  }
}

export type BrowserAgentActionAccess = { ok: true } | { ok: false; error: BrowserError }

function error(
  tabId: string,
  code: BrowserError['code'],
  message: string,
  retryable = false
): BrowserAgentActionAccess {
  return { ok: false, error: { code, message, retryable, tabId } }
}

export function isProjectLoopbackPage(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      isLoopbackBrowserHostname(parsed.hostname)
    )
  } catch {
    return false
  }
}

export function authorizeBrowserAgentAction(options: {
  actor: BrowserActor
  command: BrowserAgentActionCommand
  tab: BrowserTabRecord
  activeTabId: string | null
  lease?: BrowserAgentScreenshotLease
}): BrowserAgentActionAccess {
  const { actor, command, tab, activeTabId, lease } = options
  const tabId = tab.snapshot.id
  if (actor.kind !== 'agent') {
    return error(tabId, 'PERMISSION_DENIED', 'Browser agent input requires an active agent run')
  }
  if (command.requireActive !== true || activeTabId !== tabId) {
    return error(tabId, 'PERMISSION_DENIED', 'Browser agent input requires the active tab')
  }
  if (command.expectedDocumentRevision !== tab.snapshot.documentRevision) {
    return error(
      tabId,
      'STALE_DOCUMENT',
      'The browser page changed before the action could run',
      true
    )
  }
  if (tab.snapshot.phase !== 'ready') {
    return error(
      tabId,
      'STALE_DOCUMENT',
      'Take a new browser snapshot after the page is ready',
      true
    )
  }
  if (tab.agentRunId !== actor.runId) {
    return error(tabId, 'PERMISSION_DENIED', 'The browser tab belongs to another agent run')
  }
  if (lease?.runId !== actor.runId || lease.documentRevision !== tab.snapshot.documentRevision) {
    return error(tabId, 'STALE_DOCUMENT', 'Take a new browser snapshot before sending input', true)
  }
  if (!isProjectLoopbackPage(tab.snapshot.url)) {
    return error(
      tabId,
      'PERMISSION_DENIED',
      'External-site browser input requires approval that is not available yet'
    )
  }
  if (
    command.type === 'click' &&
    (command.consequence !== 'read' ||
      !Number.isFinite(command.x) ||
      command.x < 0 ||
      command.x >= lease.width ||
      command.x > BROWSER_MAX_SCREENSHOT_COORDINATE ||
      !Number.isFinite(command.y) ||
      command.y < 0 ||
      command.y >= lease.height ||
      command.y > BROWSER_MAX_SCREENSHOT_COORDINATE)
  ) {
    return error(
      tabId,
      'PERMISSION_DENIED',
      'Browser clicks with write consequences require approval'
    )
  }
  if (
    command.type === 'scroll' &&
    (!Number.isSafeInteger(command.deltaX) ||
      !Number.isSafeInteger(command.deltaY) ||
      Math.abs(command.deltaX) > BROWSER_MAX_SCROLL_DELTA ||
      Math.abs(command.deltaY) > BROWSER_MAX_SCROLL_DELTA ||
      (command.deltaX === 0 && command.deltaY === 0))
  ) {
    return error(tabId, 'PERMISSION_DENIED', 'Browser scroll was not permitted')
  }
  if (command.type === 'keypress') {
    const safeKeys = new Set<string>(BROWSER_SAFE_KEYS)
    if (
      !safeKeys.has(command.key) ||
      (command.modifiers !== undefined &&
        (command.modifiers.length > 1 ||
          (command.modifiers.length === 1 &&
            !BROWSER_SAFE_MODIFIERS.includes(command.modifiers[0]))))
    ) {
      return error(tabId, 'PERMISSION_DENIED', 'Browser key was not permitted')
    }
  }
  return { ok: true }
}

export async function waitForBrowserActionStability(
  milliseconds: number,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false
  if (milliseconds <= 0) {
    await Promise.resolve()
    return !signal.aborted
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export type BrowserAgentActionExecutionResult =
  { ok: true; screenshot: BrowserScreenshot } | { ok: false; error: BrowserError }

function engineActionCommand(
  tab: BrowserTabRecord,
  command: BrowserAgentActionCommand
): Extract<EngineCommand, { type: 'click' | 'scroll' | 'keypress' }> | null {
  const expectedDocumentRevision =
    command.expectedDocumentRevision - tab.engineDocumentRevisionOffset
  if (expectedDocumentRevision < 0) return null
  if (command.type === 'click') {
    return {
      type: 'click',
      x: command.x,
      y: command.y,
      expectedDocumentRevision
    }
  }
  if (command.type === 'scroll') {
    return {
      type: 'scroll',
      deltaX: command.deltaX,
      deltaY: command.deltaY,
      expectedDocumentRevision
    }
  }
  return {
    type: 'keypress',
    key: command.key,
    ...(command.modifiers ? { modifiers: [...command.modifiers] } : {}),
    expectedDocumentRevision
  }
}

export async function executeBrowserAgentAction(options: {
  engine: BrowserEngine
  tabs: BrowserTabCollection
  tab: BrowserTabRecord
  command: BrowserAgentActionCommand
  screenshotAvailable: boolean
  actionStabilityMs: number
  signal: AbortSignal
  isDisposed: () => boolean
  onChanged: () => void
  onDocumentChanged: () => void
}): Promise<BrowserAgentActionExecutionResult> {
  const tabId = options.tab.snapshot.id
  const engineCommand = engineActionCommand(options.tab, options.command)
  if (!engineCommand || !options.tab.handle) {
    return {
      ok: false,
      error: {
        code: engineCommand ? 'CAPABILITY_UNAVAILABLE' : 'STALE_DOCUMENT',
        message: engineCommand
          ? 'Browser input is unavailable'
          : 'The browser page changed before the action could run',
        retryable: !engineCommand,
        tabId
      }
    }
  }

  const engineResult = await options.engine.execute(
    options.tab.handle,
    engineCommand,
    options.signal
  )
  const result = workspaceEngineResult(options.tab, engineResult)
  if (!result.ok) {
    return { ok: false, error: { ...safeBrowserEngineError(result.error), tabId } }
  }
  const previousDocumentRevision = options.tab.snapshot.documentRevision
  if (reconcileEngineResult(options.tab, result)) options.onChanged()
  if (options.tab.snapshot.documentRevision !== previousDocumentRevision) {
    options.onDocumentChanged()
  }

  if (!(await waitForBrowserActionStability(options.actionStabilityMs, options.signal))) {
    return {
      ok: false,
      error: {
        code: 'ACTION_CANCELLED',
        message: 'Browser input may have been delivered; no retry was attempted',
        retryable: false,
        tabId
      }
    }
  }

  const capture = (): ReturnType<typeof captureBrowserWorkspaceScreenshot> =>
    captureBrowserWorkspaceScreenshot({
      engine: options.engine,
      tabs: options.tabs,
      tab: options.tab,
      screenshotAvailable: options.screenshotAvailable,
      signal: options.signal,
      isDisposed: options.isDisposed
    })
  let captured = await capture()
  if (!captured.ok && captured.error.code === 'STALE_DOCUMENT' && !options.signal.aborted) {
    if (await waitForBrowserActionStability(options.actionStabilityMs, options.signal)) {
      captured = await capture()
    }
  }
  if (!captured.ok) {
    return {
      ok: false,
      error: {
        code: 'ACTION_TIMEOUT',
        message: 'Browser input was delivered; take a new snapshot to verify the result',
        retryable: false,
        tabId
      }
    }
  }
  return captured
}

export async function executeAuthorizedBrowserAgentAction(options: {
  actor: BrowserActor
  command: BrowserAgentActionCommand
  engine: BrowserEngine
  tabs: BrowserTabCollection
  tab: BrowserTabRecord
  activeTabId: string | null
  leases: BrowserAgentScreenshotLeases
  screenshotAvailable: boolean
  coordinateInputAvailable: boolean
  actionStabilityMs: number
  signal: AbortSignal
  isDisposed: () => boolean
  onChanged: () => void
}): Promise<BrowserAgentActionExecutionResult> {
  const access = authorizeBrowserAgentAction({
    actor: options.actor,
    command: options.command,
    tab: options.tab,
    activeTabId: options.activeTabId,
    lease: options.leases.get(options.command.tabId)
  })
  if (!access.ok) return access
  if (!options.coordinateInputAvailable || !options.tab.handle) {
    return {
      ok: false,
      error: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'Browser input is unavailable',
        retryable: false,
        tabId: options.command.tabId
      }
    }
  }
  if (
    options.actor.kind !== 'agent' ||
    !options.leases.consume(
      options.command.tabId,
      options.actor.runId,
      options.command.expectedDocumentRevision
    )
  ) {
    return {
      ok: false,
      error: {
        code: 'STALE_DOCUMENT',
        message: 'Take a new browser snapshot before sending input',
        retryable: true,
        tabId: options.command.tabId
      }
    }
  }
  const result = await executeBrowserAgentAction({
    engine: options.engine,
    tabs: options.tabs,
    tab: options.tab,
    command: options.command,
    screenshotAvailable: options.screenshotAvailable,
    actionStabilityMs: options.actionStabilityMs,
    signal: options.signal,
    isDisposed: options.isDisposed,
    onChanged: options.onChanged,
    onDocumentChanged: () => options.leases.invalidate(options.command.tabId)
  })
  if (result.ok && options.actor.kind === 'agent' && options.tab.snapshot.phase === 'ready') {
    options.leases.remember(options.command.tabId, {
      runId: options.actor.runId,
      documentRevision: result.screenshot.documentRevision,
      width: result.screenshot.width,
      height: result.screenshot.height
    })
  }
  return result
}
