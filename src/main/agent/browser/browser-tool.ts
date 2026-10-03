import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import {
  BROWSER_MAX_SCREENSHOT_COORDINATE,
  BROWSER_MAX_SCROLL_DELTA,
  BROWSER_SAFE_KEYS,
  BROWSER_SAFE_MODIFIERS,
  type BrowserOutcome,
  type BrowserScreenshot,
  type BrowserTabSnapshot,
  type BrowserWorkspaceSnapshot
} from '../../../shared/browserTypes'

const MAX_URL_LENGTH = 16 * 1024
const MAX_ID_LENGTH = 256
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
  cancelHost?: (identity: { originSessionId: string; requestId: string }) => Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  action: 'open' | 'snapshot' | 'click' | 'scroll' | 'keypress',
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
  return {
    name: 'browser',
    label: 'Browser',
    description:
      'Open or inspect a page in Phi, or use read-only click, scroll, and safe navigation keys on the active project-loopback page. Input must use the tab and document revision from the latest screenshot. External-site input requires a later approval capability and is currently refused.',
    loadMode: 'essential',
    strict: true,
    approval: 'read',
    parameters: {
      oneOf: [
        {
          type: 'object',
          required: ['action', 'url'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['open'] },
            url: { type: 'string', minLength: 1, maxLength: MAX_URL_LENGTH },
            target: { type: 'string', enum: ['dedicated'] }
          }
        },
        {
          type: 'object',
          required: ['action', 'url', 'target', 'tabId', 'expectedDocumentRevision'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['open'] },
            url: { type: 'string', minLength: 1, maxLength: MAX_URL_LENGTH },
            target: { type: 'string', enum: ['current'] },
            tabId: { type: 'string', minLength: 1, maxLength: MAX_ID_LENGTH },
            expectedDocumentRevision: {
              type: 'integer',
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER
            }
          }
        },
        {
          type: 'object',
          required: ['action', 'tabId'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['snapshot'] },
            tabId: { type: 'string', minLength: 1, maxLength: MAX_ID_LENGTH },
            target: { type: 'string', enum: ['dedicated'] }
          }
        },
        {
          type: 'object',
          required: ['action', 'target', 'tabId', 'expectedDocumentRevision'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['snapshot'] },
            target: { type: 'string', enum: ['current'] },
            tabId: { type: 'string', minLength: 1, maxLength: MAX_ID_LENGTH },
            expectedDocumentRevision: {
              type: 'integer',
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER
            }
          }
        },
        ...(['click', 'scroll', 'keypress'] as const).flatMap((action) => {
          const actionProperties = {
            action: { type: 'string', enum: [action] },
            tabId: { type: 'string', minLength: 1, maxLength: MAX_ID_LENGTH },
            expectedDocumentRevision: {
              type: 'integer',
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER
            },
            target: { type: 'string', enum: ['dedicated'] }
          }
          const actionSpecific =
            action === 'click'
              ? {
                  x: {
                    type: 'number',
                    minimum: 0,
                    maximum: BROWSER_MAX_SCREENSHOT_COORDINATE
                  },
                  y: {
                    type: 'number',
                    minimum: 0,
                    maximum: BROWSER_MAX_SCREENSHOT_COORDINATE
                  },
                  consequence: { type: 'string', enum: ['read'] }
                }
              : action === 'scroll'
                ? {
                    deltaX: {
                      type: 'integer',
                      minimum: -BROWSER_MAX_SCROLL_DELTA,
                      maximum: BROWSER_MAX_SCROLL_DELTA
                    },
                    deltaY: {
                      type: 'integer',
                      minimum: -BROWSER_MAX_SCROLL_DELTA,
                      maximum: BROWSER_MAX_SCROLL_DELTA
                    }
                  }
                : {
                    key: { type: 'string', enum: [...BROWSER_SAFE_KEYS] },
                    modifiers: {
                      type: 'array',
                      items: { type: 'string', enum: [...BROWSER_SAFE_MODIFIERS] },
                      maxItems: 1,
                      uniqueItems: true
                    }
                  }
          const required = [
            'action',
            'tabId',
            'expectedDocumentRevision',
            ...(action === 'click'
              ? ['x', 'y', 'consequence']
              : action === 'scroll'
                ? ['deltaX', 'deltaY']
                : ['key'])
          ]
          return [
            {
              type: 'object',
              required,
              additionalProperties: false,
              properties: { ...actionProperties, ...actionSpecific }
            },
            {
              type: 'object',
              required: [...required, 'target'],
              additionalProperties: false,
              properties: {
                ...actionProperties,
                ...actionSpecific,
                target: { type: 'string', enum: ['current'] }
              }
            }
          ]
        })
      ]
    },
    async execute(toolCallId, params, _onUpdate, _ctx, signal) {
      if (
        !boundedText(originSessionId, MAX_ORIGIN_ID_LENGTH) ||
        !boundedText(toolCallId, MAX_ID_LENGTH)
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
        input.action === 'scroll' ||
        input.action === 'keypress'
          ? input.action
          : null
      const requestId = options.requestId ? options.requestId() : toolCallId
      let command: Record<string, unknown> | null = null
      if (
        action === 'open' &&
        boundedText(input.url, MAX_URL_LENGTH) &&
        (input.target === undefined || input.target === 'dedicated')
      ) {
        command = { type: 'open', requestId, url: input.url }
      } else if (
        action === 'open' &&
        input.target === 'current' &&
        boundedText(input.url, MAX_URL_LENGTH) &&
        boundedText(input.tabId, MAX_ID_LENGTH) &&
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
        targetIsValid(input.target) &&
        boundedText(input.tabId, MAX_ID_LENGTH) &&
        validDocumentRevision(input.expectedDocumentRevision) &&
        validCoordinate(input.x) &&
        validCoordinate(input.y) &&
        input.consequence === 'read'
      ) {
        command = {
          type: 'click',
          requestId,
          tabId: input.tabId,
          expectedDocumentRevision: input.expectedDocumentRevision,
          requireActive: true,
          x: input.x,
          y: input.y,
          consequence: 'read'
        }
      } else if (
        action === 'scroll' &&
        targetIsValid(input.target) &&
        boundedText(input.tabId, MAX_ID_LENGTH) &&
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
        targetIsValid(input.target) &&
        boundedText(input.tabId, MAX_ID_LENGTH) &&
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
        boundedText(input.tabId, MAX_ID_LENGTH) &&
        (input.target === undefined || input.target === 'dedicated')
      ) {
        command = { type: 'snapshot', requestId, tabId: input.tabId }
      } else if (
        action === 'snapshot' &&
        input.target === 'current' &&
        boundedText(input.tabId, MAX_ID_LENGTH) &&
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
          content: [{ type: 'text', text: 'Invalid browser request' }],
          details: { kind: 'browser_error', code: 'INVALID_REQUEST' },
          isError: true
        }
      }
      if (!boundedText(requestId, MAX_ID_LENGTH)) {
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
        void options.cancelHost?.({ originSessionId, requestId }).catch(() => undefined)
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
}
