import { randomUUID } from 'node:crypto'
import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import type {
  BrowserOutcome,
  BrowserScreenshot,
  BrowserTabSnapshot,
  BrowserWorkspaceSnapshot
} from '../../../shared/browserTypes'

const MAX_URL_LENGTH = 16 * 1024
const MAX_ID_LENGTH = 256
const MAX_ORIGIN_ID_LENGTH = 512

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
  action: 'open' | 'snapshot',
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

function cancelledResult(): {
  content: Array<{ type: 'text'; text: string }>
  details: { kind: string; code: string; retryable: boolean }
  isError: true
} {
  return {
    content: [{ type: 'text', text: 'Browser action was cancelled' }],
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
      'Open a web page in Phi or capture one Phi browser tab. Open creates a dedicated agent tab by default. Use target=current only when the user explicitly asks to reuse the referenced current tab, with its tabId and document revision. Snapshot returns compact page state and the current PNG pixels.',
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
        }
      ]
    },
    async execute(toolCallId, params, _onUpdate, _ctx, signal) {
      const input = isRecord(params) ? params : {}
      const action = input.action === 'open' || input.action === 'snapshot' ? input.action : null
      const requestId = (options.requestId ?? randomUUID)()
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
      if (
        !boundedText(originSessionId, MAX_ORIGIN_ID_LENGTH) ||
        !boundedText(requestId, MAX_ID_LENGTH) ||
        !boundedText(toolCallId, MAX_ID_LENGTH)
      ) {
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
        if (action === 'snapshot' && !outcome.screenshot) {
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
                action === 'snapshot' ? 'Captured' : 'Opened',
                outcome.snapshot,
                tabId,
                outcome.screenshot
              )
            },
            ...(action === 'snapshot' && outcome.screenshot
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
