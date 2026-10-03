import {
  BROWSER_MAX_SCREENSHOT_COORDINATE,
  BROWSER_MAX_SCROLL_DELTA,
  BROWSER_MAX_TEXT_BYTES,
  BROWSER_SAFE_KEYS,
  BROWSER_SAFE_MODIFIERS,
  type BrowserActor,
  type BrowserCommand,
  type BrowserError
} from '../../shared/browserTypes'
import type { BrowserEngine, EngineTargetInspection } from './browser-engine'
import type { BrowserTabCollection, BrowserTabRecord } from './browser-tab-collection'
import { safeBrowserEngineError } from './browser-workspace-engine-state'
import { authorizeBrowserTarget, validatedBrowserTargetInspection } from './browser-target-policy'
import {
  BrowserActionApprovalLeases,
  browserActionDigest,
  browserActionApprovalRequirement,
  browserTargetDescriptorDigest,
  browserTextDigest,
  isLoopbackBrowserActionUrl,
  type BrowserActionApprovalIdentity,
  type BrowserActionApprovalPrompt,
  type BrowserActionConsequence
} from './browser-approval'
import {
  executeBrowserAgentAction,
  type BrowserAgentActionExecutionResult
} from './browser-agent-action-execution'
import {
  type BrowserAgentScreenshotLease,
  type BrowserAgentScreenshotLeases
} from './browser-agent-screenshot-leases'

export type BrowserAgentActionCommand = Extract<
  BrowserCommand,
  { type: 'click' | 'typeText' | 'scroll' | 'keypress' }
>

export function isBrowserAgentActionCommand(
  command: BrowserCommand
): command is BrowserAgentActionCommand {
  return (
    command.type === 'click' ||
    command.type === 'typeText' ||
    command.type === 'scroll' ||
    command.type === 'keypress'
  )
}

export function normalizeBrowserActionStabilityMs(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) >= 0
    ? Math.min(500, Math.floor(value as number))
    : 75
}

export type BrowserAgentActionAccess = { ok: true } | { ok: false; error: BrowserError }

function error(
  tabId: string,
  code: BrowserError['code'],
  message: string,
  retryable = false
): { ok: false; error: BrowserError } {
  return { ok: false, error: { code, message, retryable, tabId } }
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
  if (
    command.type === 'click' &&
    ((command.consequence !== 'read' &&
      command.consequence !== 'write' &&
      command.consequence !== 'irreversible') ||
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
    command.type === 'typeText' &&
    ((command.consequence !== 'write' && command.consequence !== 'irreversible') ||
      command.text.length === 0 ||
      Buffer.byteLength(command.text, 'utf8') > BROWSER_MAX_TEXT_BYTES)
  ) {
    return error(tabId, 'PERMISSION_DENIED', 'Browser text input was not permitted')
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

export interface BrowserPreparedAgentAction {
  expectedTarget?: EngineTargetInspection
  approvalIdentity: BrowserActionApprovalIdentity | null
  approvalPrompt: BrowserActionApprovalPrompt | null
  originalScreenshotLease: BrowserAgentScreenshotLease
}

type BrowserAgentActionPreparationResult =
  { ok: true; prepared: BrowserPreparedAgentAction } | { ok: false; error: BrowserError }

export async function prepareBrowserAgentAction(options: {
  actor: Extract<BrowserActor, { kind: 'agent' }>
  command: BrowserAgentActionCommand
  engine: BrowserEngine
  tab: BrowserTabRecord
  activeTabId: string | null
  leases: BrowserAgentScreenshotLeases
  coordinateInputAvailable: boolean
  signal: AbortSignal
}): Promise<BrowserAgentActionPreparationResult> {
  const originalScreenshotLease = options.leases.get(options.command.tabId)
  const access = authorizeBrowserAgentAction({
    actor: options.actor,
    command: options.command,
    tab: options.tab,
    activeTabId: options.activeTabId,
    lease: originalScreenshotLease
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
  let expectedTarget: EngineTargetInspection | undefined
  if (options.command.type === 'click' || options.command.type === 'typeText') {
    const expectedDocumentRevision =
      options.command.expectedDocumentRevision - options.tab.engineDocumentRevisionOffset
    if (expectedDocumentRevision < 0) {
      return {
        ok: false,
        error: {
          code: 'STALE_DOCUMENT',
          message: 'The browser page changed before the action could run',
          retryable: true,
          tabId: options.command.tabId
        }
      }
    }
    const inspected = await options.engine.execute(
      options.tab.handle,
      options.command.type === 'click'
        ? {
            type: 'describeTarget',
            target: 'point',
            x: options.command.x,
            y: options.command.y,
            expectedDocumentRevision
          }
        : { type: 'describeTarget', target: 'focused', expectedDocumentRevision },
      options.signal
    )
    if (!inspected.ok) {
      return {
        ok: false,
        error: { ...safeBrowserEngineError(inspected.error), tabId: options.command.tabId }
      }
    }
    if (
      options.signal.aborted ||
      inspected.state.isLoading ||
      inspected.state.documentRevision !== expectedDocumentRevision
    ) {
      return {
        ok: false,
        error: {
          code: options.signal.aborted ? 'ACTION_CANCELLED' : 'STALE_DOCUMENT',
          message: options.signal.aborted
            ? 'Browser action was cancelled'
            : 'The browser page changed before the action could run',
          retryable: !options.signal.aborted,
          tabId: options.command.tabId
        }
      }
    }
    expectedTarget = validatedBrowserTargetInspection(inspected) ?? undefined
    if (!expectedTarget) {
      return {
        ok: false,
        error: {
          code: 'PERMISSION_DENIED',
          message: 'The browser target could not be classified safely',
          retryable: false,
          tabId: options.command.tabId
        }
      }
    }
    const targetAccess = authorizeBrowserTarget({
      action: options.command.type,
      tabId: options.command.tabId,
      inspection: expectedTarget,
      consequence: options.command.consequence
    })
    if (!targetAccess.ok) return targetAccess
  }
  const consequence: BrowserActionConsequence =
    options.command.type === 'click' || options.command.type === 'typeText'
      ? options.command.consequence
      : 'read'
  const requirement = browserActionApprovalRequirement({
    url: options.tab.snapshot.url,
    action: options.command.type,
    consequence,
    submitsForm: expectedTarget?.descriptor.submitsForm === true
  })
  const externalPage = !isLoopbackBrowserActionUrl(options.tab.snapshot.url)
  const externalSubmitIsSafeGet = (() => {
    if (!externalPage || !expectedTarget?.descriptor.submitsForm) return true
    if (
      expectedTarget.descriptor.formMethod !== 'get' ||
      !expectedTarget.descriptor.formAction ||
      !options.tab.snapshot.origin
    ) {
      return false
    }
    try {
      return new URL(expectedTarget.descriptor.formAction).origin === options.tab.snapshot.origin
    } catch {
      return false
    }
  })()
  if (!externalSubmitIsSafeGet) {
    return error(
      options.command.tabId,
      'USER_HANDOFF_REQUIRED',
      'External form submission requires user takeover'
    )
  }
  if (
    options.command.type === 'click' &&
    externalPage &&
    expectedTarget &&
    !expectedTarget.descriptor.submitsForm &&
    (expectedTarget.descriptor.tagName !== 'A' || options.command.consequence !== 'read')
  ) {
    return error(
      options.command.tabId,
      'USER_HANDOFF_REQUIRED',
      'This external browser target requires user takeover'
    )
  }
  let approvalIdentity: BrowserActionApprovalIdentity | null = null
  let approvalPrompt: BrowserActionApprovalPrompt | null = null
  if (requirement.kind === 'confirm') {
    if (options.actor.kind !== 'agent' || !options.tab.snapshot.origin) {
      return {
        ok: false,
        error: {
          code: 'PERMISSION_DENIED',
          message: 'Browser input requires explicit user approval',
          retryable: false,
          tabId: options.command.tabId
        }
      }
    }
    approvalIdentity = {
      sessionId: options.actor.sessionId,
      runId: options.actor.runId,
      toolCallId: options.actor.toolCallId,
      requestId: options.command.requestId,
      tabId: options.command.tabId,
      origin: options.tab.snapshot.origin,
      documentRevision: options.command.expectedDocumentRevision,
      action: options.command.type,
      consequence,
      targetFingerprint: expectedTarget?.fingerprint ?? null,
      targetDescriptorDigest: browserTargetDescriptorDigest(expectedTarget),
      textDigest:
        options.command.type === 'typeText' ? browserTextDigest(options.command.text) : null,
      actionDigest: browserActionDigest(options.command)
    }
    approvalPrompt = {
      sessionId: options.actor.sessionId,
      runId: options.actor.runId,
      toolCallId: options.actor.toolCallId,
      origin: options.tab.snapshot.origin,
      action: options.command.type,
      consequence,
      reason: requirement.reason
    }
  }
  if (!originalScreenshotLease) {
    return error(
      options.command.tabId,
      'STALE_DOCUMENT',
      'Take a new browser snapshot before sending input',
      true
    )
  }
  return {
    ok: true,
    prepared: {
      ...(expectedTarget ? { expectedTarget } : {}),
      approvalIdentity,
      approvalPrompt,
      originalScreenshotLease: { ...originalScreenshotLease }
    }
  }
}

export async function executePreparedBrowserAgentAction(options: {
  actor: Extract<BrowserActor, { kind: 'agent' }>
  command: BrowserAgentActionCommand
  prepared: BrowserPreparedAgentAction
  engine: BrowserEngine
  tabs: BrowserTabCollection
  tab: BrowserTabRecord
  activeTabId: string | null
  leases: BrowserAgentScreenshotLeases
  approvalLeases: BrowserActionApprovalLeases
  screenshotAvailable: boolean
  actionStabilityMs: number
  signal: AbortSignal
  isDisposed: () => boolean
  onChanged: () => void
}): Promise<BrowserAgentActionExecutionResult> {
  const freshAccess = authorizeBrowserAgentAction({
    actor: options.actor,
    command: options.command,
    tab: options.tab,
    activeTabId: options.activeTabId,
    lease: options.leases.get(options.command.tabId)
  })
  if (!freshAccess.ok) return freshAccess
  const approvalIdentity = options.prepared.approvalIdentity
  if (approvalIdentity && browserActionDigest(options.command) !== approvalIdentity.actionDigest) {
    return error(
      options.command.tabId,
      'PERMISSION_DENIED',
      'Browser action changed after approval',
      false
    )
  }
  if (approvalIdentity && options.tab.snapshot.origin !== approvalIdentity.origin) {
    return error(
      options.command.tabId,
      'STALE_DOCUMENT',
      'The browser origin changed before approval completed',
      true
    )
  }
  let expectedTarget = options.prepared.expectedTarget
  if (expectedTarget) {
    const expectedDocumentRevision =
      options.command.expectedDocumentRevision - options.tab.engineDocumentRevisionOffset
    if (expectedDocumentRevision < 0 || !options.tab.handle) {
      return error(
        options.command.tabId,
        'STALE_DOCUMENT',
        'The browser page changed before approval completed',
        true
      )
    }
    const inspectedAgain = await options.engine.execute(
      options.tab.handle,
      options.command.type === 'click'
        ? {
            type: 'describeTarget',
            target: 'point',
            x: options.command.x,
            y: options.command.y,
            expectedDocumentRevision
          }
        : { type: 'describeTarget', target: 'focused', expectedDocumentRevision },
      options.signal
    )
    const freshTarget = validatedBrowserTargetInspection(inspectedAgain)
    if (
      !freshTarget ||
      freshTarget.fingerprint !== expectedTarget.fingerprint ||
      (approvalIdentity &&
        browserTargetDescriptorDigest(freshTarget) !== approvalIdentity.targetDescriptorDigest)
    ) {
      return error(
        options.command.tabId,
        'STALE_DOCUMENT',
        'The browser target changed before approval completed',
        true
      )
    }
    const targetAccess = authorizeBrowserTarget({
      action: options.command.type as 'click' | 'typeText',
      tabId: options.command.tabId,
      inspection: freshTarget,
      consequence:
        options.command.type === 'click' || options.command.type === 'typeText'
          ? options.command.consequence
          : undefined
    })
    if (!targetAccess.ok) return targetAccess
    expectedTarget = freshTarget
  }
  if (approvalIdentity && !options.approvalLeases.consume(approvalIdentity)) {
    return error(
      options.command.tabId,
      'STALE_DOCUMENT',
      'Browser approval expired before input delivery',
      true
    )
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
    ...(expectedTarget ? { expectedTarget } : {}),
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
