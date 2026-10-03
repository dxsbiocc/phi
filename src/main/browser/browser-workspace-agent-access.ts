import type { BrowserActor, BrowserError } from '../../shared/browserTypes'
import type { BrowserTabRecord } from './browser-tab-collection'

export type BrowserTabAccessResult =
  { ok: true; claimRunId?: string } | { ok: false; error: BrowserError }

export interface BrowserTabAccessOptions {
  actor: BrowserActor
  tab: BrowserTabRecord
  activeTabId: string | null
  expectedDocumentRevision?: number
  requireActive: boolean
}

function staleDocument(tabId: string): BrowserTabAccessResult {
  return {
    ok: false,
    error: {
      code: 'STALE_DOCUMENT',
      message: 'The browser page changed before the action could run',
      retryable: true,
      tabId
    }
  }
}

function denied(tabId: string, ownedByAnotherRun: boolean): BrowserTabAccessResult {
  return {
    ok: false,
    error: {
      code: 'PERMISSION_DENIED',
      message: ownedByAnotherRun
        ? 'The browser tab belongs to another agent run'
        : 'The agent can only take over the active browser tab',
      retryable: false,
      tabId
    }
  }
}

export function authorizeBrowserTabAccess(
  options: BrowserTabAccessOptions
): BrowserTabAccessResult {
  const { actor, tab, activeTabId, expectedDocumentRevision, requireActive } = options
  const tabId = tab.snapshot.id
  const revisionMatches = expectedDocumentRevision === tab.snapshot.documentRevision

  if (actor.kind === 'human') {
    return expectedDocumentRevision !== undefined && !revisionMatches
      ? staleDocument(tabId)
      : { ok: true }
  }

  if (tab.agentRunId === actor.runId) {
    return expectedDocumentRevision !== undefined && !revisionMatches
      ? staleDocument(tabId)
      : { ok: true }
  }

  if (!requireActive || activeTabId !== tabId) {
    return denied(tabId, tab.agentRunId !== null)
  }
  if (expectedDocumentRevision === undefined || !revisionMatches) {
    return staleDocument(tabId)
  }
  return { ok: true, claimRunId: actor.runId }
}
