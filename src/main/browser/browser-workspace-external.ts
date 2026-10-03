import type { BrowserActor, BrowserError, BrowserTabSnapshot } from '../../shared/browserTypes'
import type { BrowserPolicyContext, BrowserUrlPolicyResult } from './browser-policy'

export interface BrowserWorkspaceExternalOptions {
  actor: BrowserActor
  activeTab?: BrowserTabSnapshot
  requestedTabId: string
  expectedDocumentRevision: number
  policyContext: BrowserPolicyContext
  normalizeUrl: (input: string, context: BrowserPolicyContext) => BrowserUrlPolicyResult
  openExternal?: (url: string) => Promise<void>
}

export type BrowserWorkspaceExternalResult = { ok: true } | { ok: false; error: BrowserError }

export async function openActiveBrowserTabExternally(
  options: BrowserWorkspaceExternalOptions
): Promise<BrowserWorkspaceExternalResult> {
  if (options.actor.kind !== 'human') {
    return {
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: 'Only the user can open a page in the default browser',
        retryable: false
      }
    }
  }
  if (!options.activeTab) {
    return {
      ok: false,
      error: {
        code: 'TAB_NOT_FOUND',
        message: 'Browser tab was not found',
        retryable: false,
        tabId: options.requestedTabId
      }
    }
  }
  if (
    options.activeTab.id !== options.requestedTabId ||
    options.activeTab.documentRevision !== options.expectedDocumentRevision
  ) {
    return {
      ok: false,
      error: {
        code: 'STALE_DOCUMENT',
        message: 'The active browser page changed before it could be opened externally',
        retryable: true,
        tabId: options.requestedTabId
      }
    }
  }
  const normalized = options.normalizeUrl(options.activeTab.url, options.policyContext)
  if (!normalized.ok) return normalized
  if (!options.openExternal) {
    return {
      ok: false,
      error: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'Opening the default browser is unavailable',
        retryable: false,
        tabId: options.activeTab.id
      }
    }
  }
  try {
    await options.openExternal(normalized.url)
    return { ok: true }
  } catch {
    return {
      ok: false,
      error: {
        code: 'ENGINE_UNAVAILABLE',
        message: 'The default browser could not be opened',
        retryable: true,
        tabId: options.activeTab.id
      }
    }
  }
}
