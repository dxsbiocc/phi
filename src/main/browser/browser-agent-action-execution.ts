import type { BrowserError, BrowserScreenshot } from '../../shared/browserTypes'
import type { BrowserEngine, EngineCommand, EngineTargetInspection } from './browser-engine'
import type { BrowserTabCollection, BrowserTabRecord } from './browser-tab-collection'
import { captureBrowserWorkspaceScreenshot } from './browser-workspace-screenshot'
import {
  reconcileEngineResult,
  safeBrowserEngineError,
  workspaceEngineResult
} from './browser-workspace-engine-state'
import type { BrowserAgentActionCommand } from './browser-workspace-agent-action'

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
  command: BrowserAgentActionCommand,
  expectedTarget?: EngineTargetInspection
): Extract<EngineCommand, { type: 'click' | 'typeText' | 'scroll' | 'keypress' }> | null {
  const expectedDocumentRevision =
    command.expectedDocumentRevision - tab.engineDocumentRevisionOffset
  if (expectedDocumentRevision < 0) return null
  if (command.type === 'click') {
    return {
      type: 'click',
      x: command.x,
      y: command.y,
      expectedDocumentRevision,
      ...(expectedTarget ? { expectedTarget } : {})
    }
  }
  if (command.type === 'typeText') {
    return {
      type: 'typeText',
      text: command.text,
      expectedDocumentRevision,
      ...(expectedTarget ? { expectedTarget } : {})
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
  expectedTarget?: EngineTargetInspection
  screenshotAvailable: boolean
  actionStabilityMs: number
  signal: AbortSignal
  isDisposed: () => boolean
  onChanged: () => void
  onDocumentChanged: () => void
}): Promise<BrowserAgentActionExecutionResult> {
  const tabId = options.tab.snapshot.id
  const engineCommand = engineActionCommand(options.tab, options.command, options.expectedTarget)
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
