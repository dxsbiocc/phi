import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import {
  BROWSER_MAX_SCREENSHOT_COORDINATE,
  BROWSER_MAX_SCROLL_DELTA,
  BROWSER_MAX_TEXT_BYTES,
  BROWSER_SAFE_KEYS,
  BROWSER_SAFE_MODIFIERS,
  type BrowserOutcome,
  type BrowserScreenshot,
  type BrowserTabSnapshot,
  type BrowserWorkspaceSnapshot
} from '../../../shared/browserTypes'
import {
  BROWSER_TOOL_MAX_ID_BYTES,
  BROWSER_TOOL_MAX_URL_BYTES,
  browserToolParameters
} from './browser-tool-schema'

const MAX_ORIGIN_ID_LENGTH = 512
const SAFE_KEYS = new Set<string>(BROWSER_SAFE_KEYS)

export type BrowserToolHostRequest = {
  originSessionId: string
  requestId: string
  toolCallId: string
  command: Record<string, unknown>
}

export type BrowserToolHostExecutor = (
  request: BrowserToolHostRequest,
  signal?: AbortSignal
) => Promise<BrowserOutcome>

export interface BrowserToolOptions {
  requestId?: () => string
  cancelHost?: (identity: {
    originSessionId: string
    requestId: string
    toolCallId: string
  }) => Promise<unknown>
  takeText?: (
    toolCallId: string,
    placeholder: string
  ) => { text?: string; denied?: boolean } | undefined
  allowTypeText?: () => boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function exactOptionalTargetKeys(
  input: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  return exactKeys(input, [...expected, ...(Object.hasOwn(input, 'target') ? ['target'] : [])])
}

function safeDisplayUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '(unavailable)'
  }
}

function selectedTab(
  snapshot: BrowserWorkspaceSnapshot,
  tabId?: string
): BrowserTabSnapshot | null {
  const target = tabId ?? snapshot.activeTabId
  return target ? (snapshot.tabs.find((tab) => tab.id === target) ?? null) : null
}

function tabText(
  verb: string,
  snapshot: BrowserWorkspaceSnapshot,
  tabId?: string,
  screenshot?: BrowserScreenshot
): string {
  const tab = selectedTab(snapshot, tabId)
  if (!tab) return `${verb}. No browser tab is active.`
  return [
    `${verb} browser tab ${tab.id}.`,
    `Title: ${tab.title || '(untitled)'}`,
    `URL: ${safeDisplayUrl(tab.url)}`,
    `State: ${tab.phase}`,
    `Document revision: ${tab.documentRevision}`,
    ...(screenshot
      ? [
          `Image: ${screenshot.width}×${screenshot.height} pixels`,
          `Snapshot document revision: ${screenshot.documentRevision}`
        ]
      : [])
  ].join('\n')
}

function successDetails(
  action: 'open' | 'snapshot' | 'click' | 'typeText' | 'scroll' | 'keypress',
  snapshot: BrowserWorkspaceSnapshot,
  tabId?: string,
  screenshot?: BrowserScreenshot
): Record<string, unknown> {
  const tab = selectedTab(snapshot, tabId)
  return {
    kind: 'browser',
    action,
    revision: snapshot.revision,
    ...(tab
      ? {
          tab: {
            id: tab.id,
            title: tab.title,
            url: safeDisplayUrl(tab.url),
            phase: tab.phase,
            documentRevision: tab.documentRevision
          }
        }
      : {}),
    ...(screenshot
      ? {
          screenshot: {
            tabId: screenshot.tabId,
            width: screenshot.width,
            height: screenshot.height,
            documentRevision: screenshot.documentRevision
          }
        }
      : {})
  }
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes
  )
}

function validDocumentRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function validCoordinate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= BROWSER_MAX_SCREENSHOT_COORDINATE
  )
}

function validScrollDelta(value: unknown): value is number {
  return Number.isSafeInteger(value) && Math.abs(value as number) <= BROWSER_MAX_SCROLL_DELTA
}

function validModifiers(value: unknown): value is ['shift'] | [] {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      (value.length === 0 ||
        (value.length === 1 && BROWSER_SAFE_MODIFIERS.includes(value[0] as 'shift'))))
  )
}

function targetIsValid(value: unknown): value is 'current' | 'dedicated' | undefined {
  return value === undefined || value === 'dedicated' || value === 'current'
}

function cancelledResult(): {
  content: Array<{ type: 'text'; text: string }>
  details: { kind: string; code: string; retryable: boolean }
  isError: true
} {
  return {
    content: [
      {
        type: 'text',
        text: 'Browser action was cancelled. Input already delivered to the page was not undone.'
      }
    ],
    details: { kind: 'browser_error', code: 'ACTION_CANCELLED', retryable: false },
    isError: true
  }
}

export function buildBrowserTool(
  originSessionId: string,
  executeHost: BrowserToolHostExecutor,
  options: BrowserToolOptions = {}
): CustomTool {
  const tool = {
    lenientArgValidation: true,
    name: 'browser',
    label: 'Browser',
    description:
      'Open or inspect a page in Phi, or click, type, scroll, and use safe navigation keys on the active page. Input must use the active tab and document revision from the latest screenshot. Each external-site input asks the user to allow that exact action once; sensitive or unsafe targets require user takeover.',
    loadMode: 'essential',
    strict: true,
    approval: 'read',
    parameters: browserToolParameters(),
    async execute(toolCallId, params, _onUpdate, _ctx, signal) {
      if (
        !boundedText(originSessionId, MAX_ORIGIN_ID_LENGTH) ||
        !boundedText(toolCallId, BROWSER_TOOL_MAX_ID_BYTES)
      ) {
        return {
          content: [{ type: 'text', text: 'Invalid browser request' }],
          details: { kind: 'browser_error', code: 'INVALID_REQUEST' },
          isError: true
        }
      }
      const input = isRecord(params) ? params : {}
      const action =
        input.action === 'open' ||
        input.action === 'snapshot' ||
        input.action === 'click' ||
        input.action === 'typeText' ||
        input.action === 'scroll' ||
        input.action === 'keypress'
          ? input.action
          : null
      const requestId = options.requestId ? options.requestId() : toolCallId
      let command: Record<string, unknown> | null = null
      let typeTextDenied = false
      if (
        action === 'open' &&
        exactOptionalTargetKeys(input, ['action', 'url']) &&
        boundedText(input.url, BROWSER_TOOL_MAX_URL_BYTES) &&
        (input.target === undefined || input.target === 'dedicated')
      ) {
        command = { type: 'open', requestId, url: input.url }
      } else if (
        action === 'open' &&
        exactKeys(input, ['action', 'url', 'target', 'tabId', 'expectedDocumentRevision']) &&
        input.target === 'current' &&
        boundedText(input.url, BROWSER_TOOL_MAX_URL_BYTES) &&
        boundedText(input.tabId, BROWSER_TOOL_MAX_ID_BYTES) &&
        validDocumentRevision(input.expectedDocumentRevision)
      ) {
        command = {
          type: 'navigate',
          requestId,
          tabId: input.tabId,
          url: input.url,
          expectedDocumentRevision: input.expectedDocumentRevision,
          requireActive: true
        }
      } else if (
        action === 'click' &&
        exactOptionalTargetKeys(input, [
          'action',
          'tabId',
          'expectedDocumentRevision',
          'x',
          'y',
          'consequence'
        ]) &&
        targetIsValid(input.target) &&
        boundedText(input.tabId, BROWSER_TOOL_MAX_ID_BYTES) &&
        validDocumentRevision(input.expectedDocumentRevision) &&
        validCoordinate(input.x) &&
        validCoordinate(input.y) &&
        (input.consequence === 'read' ||
          input.consequence === 'write' ||
          input.consequence === 'irreversible')
      ) {
        command = {
          type: 'click',
          requestId,
          tabId: input.tabId,
          expectedDocumentRevision: input.expectedDocumentRevision,
          requireActive: true,
          x: input.x,
          y: input.y,
          consequence: input.consequence
        }
      } else if (
        action === 'typeText' &&
        exactOptionalTargetKeys(input, [
          'action',
          'tabId',
          'expectedDocumentRevision',
          'text',
          'consequence'
        ]) &&
        targetIsValid(input.target) &&
        boundedText(input.tabId, BROWSER_TOOL_MAX_ID_BYTES) &&
        validDocumentRevision(input.expectedDocumentRevision) &&
        typeof input.text === 'string' &&
        (input.consequence === 'write' || input.consequence === 'irreversible')
      ) {
        const taken = options.takeText?.(toolCallId, input.text)
        const text = taken?.text
        if (!boundedText(text, BROWSER_MAX_TEXT_BYTES)) {
          typeTextDenied = taken?.denied === true
          command = null
        } else if (options.allowTypeText?.() === false) {
          typeTextDenied = true
          command = null
        } else {
          command = {
            type: 'typeText',
            requestId,
            tabId: input.tabId,
            expectedDocumentRevision: input.expectedDocumentRevision,
            requireActive: true,
            text,
            consequence: input.consequence
          }
        }
      } else if (
        action === 'scroll' &&
        exactOptionalTargetKeys(input, [
          'action',
          'tabId',
          'expectedDocumentRevision',
          'deltaX',
          'deltaY'
        ]) &&
        targetIsValid(input.target) &&
        boundedText(input.tabId, BROWSER_TOOL_MAX_ID_BYTES) &&
        validDocumentRevision(input.expectedDocumentRevision) &&
        validScrollDelta(input.deltaX) &&
        validScrollDelta(input.deltaY) &&
        (input.deltaX !== 0 || input.deltaY !== 0)
      ) {
        command = {
          type: 'scroll',
          requestId,
          tabId: input.tabId,
          expectedDocumentRevision: input.expectedDocumentRevision,
          requireActive: true,
          deltaX: input.deltaX,
          deltaY: input.deltaY
        }
      } else if (
        action === 'keypress' &&
        exactKeys(input, [
          'action',
          'tabId',
          'expectedDocumentRevision',
          'key',
          ...(Object.hasOwn(input, 'target') ? ['target'] : []),
          ...(Object.hasOwn(input, 'modifiers') ? ['modifiers'] : [])
        ]) &&
        targetIsValid(input.target) &&
        boundedText(input.tabId, BROWSER_TOOL_MAX_ID_BYTES) &&
        validDocumentRevision(input.expectedDocumentRevision) &&
        typeof input.key === 'string' &&
        SAFE_KEYS.has(input.key) &&
        validModifiers(input.modifiers)
      ) {
        command = {
          type: 'keypress',
          requestId,
          tabId: input.tabId,
          expectedDocumentRevision: input.expectedDocumentRevision,
          requireActive: true,
          key: input.key,
          ...(input.modifiers === undefined ? {} : { modifiers: [...input.modifiers] })
        }
      } else if (
        action === 'snapshot' &&
        exactOptionalTargetKeys(input, ['action', 'tabId']) &&
        boundedText(input.tabId, BROWSER_TOOL_MAX_ID_BYTES) &&
        (input.target === undefined || input.target === 'dedicated')
      ) {
        command = { type: 'snapshot', requestId, tabId: input.tabId }
      } else if (
        action === 'snapshot' &&
        exactKeys(input, ['action', 'target', 'tabId', 'expectedDocumentRevision']) &&
        input.target === 'current' &&
        boundedText(input.tabId, BROWSER_TOOL_MAX_ID_BYTES) &&
        validDocumentRevision(input.expectedDocumentRevision)
      ) {
        command = {
          type: 'snapshot',
          requestId,
          tabId: input.tabId,
          expectedDocumentRevision: input.expectedDocumentRevision,
          requireActive: true
        }
      }
      if (!action || !command) {
        return {
          content: [
            {
              type: 'text',
              text: typeTextDenied
                ? 'Browser text input is unavailable in the current mode'
                : 'Invalid browser request'
            }
          ],
          details: {
            kind: 'browser_error',
            code: typeTextDenied ? 'PERMISSION_DENIED' : 'INVALID_REQUEST'
          },
          isError: true
        }
      }
      if (!boundedText(requestId, BROWSER_TOOL_MAX_ID_BYTES)) {
        return {
          content: [{ type: 'text', text: 'Invalid browser request' }],
          details: { kind: 'browser_error', code: 'INVALID_REQUEST' },
          isError: true
        }
      }

      if (signal?.aborted) {
        return cancelledResult()
      }

      const cancel = (): void => {
        void options.cancelHost?.({ originSessionId, requestId, toolCallId }).catch(() => undefined)
      }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        const outcome = await executeHost(
          { originSessionId, requestId, toolCallId, command },
          signal
        )
        if (signal?.aborted) return cancelledResult()
        if (!outcome.ok) {
          return {
            content: [{ type: 'text', text: `Browser request failed (${outcome.error.code})` }],
            details: {
              kind: 'browser_error',
              code: outcome.error.code,
              retryable: outcome.error.retryable,
              ...(outcome.error.tabId ? { tabId: outcome.error.tabId } : {})
            },
            isError: true
          }
        }
        const tabId = typeof command.tabId === 'string' ? command.tabId : undefined
        if (action !== 'open' && !outcome.screenshot) {
          return {
            content: [{ type: 'text', text: 'Browser snapshot did not return an image' }],
            details: {
              kind: 'browser_error',
              code: 'CAPABILITY_UNAVAILABLE',
              retryable: false,
              ...(tabId ? { tabId } : {})
            },
            isError: true
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: tabText(
                action === 'snapshot' ? 'Captured' : action === 'open' ? 'Opened' : 'Controlled',
                outcome.snapshot,
                tabId,
                outcome.screenshot
              )
            },
            ...(action !== 'open' && outcome.screenshot
              ? [
                  {
                    type: 'image' as const,
                    data: outcome.screenshot.data,
                    mimeType: outcome.screenshot.mediaType
                  }
                ]
              : [])
          ],
          details: successDetails(action, outcome.snapshot, tabId, outcome.screenshot)
        }
      } catch {
        if (signal?.aborted) return cancelledResult()
        return {
          content: [{ type: 'text', text: 'Browser request failed' }],
          details: { kind: 'browser_error', code: 'HOST_UNAVAILABLE', retryable: true },
          isError: true
        }
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
    }
  }
  return tool as CustomTool
}
