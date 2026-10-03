import type {
  BrowserActor,
  BrowserCapabilities,
  BrowserError,
  BrowserOutcome,
  BrowserScreenshot
} from '../../shared/browserTypes'
import type { BrowserEngine } from './browser-engine'
import type { BrowserTabCollection } from './browser-tab-collection'
import { captureBrowserWorkspaceScreenshot } from './browser-workspace-screenshot'
import type { BrowserWorkspaceRequestCache } from './browser-workspace-request-cache'
import {
  authorizeBrowserAgentAction,
  executePreparedBrowserAgentAction,
  prepareBrowserAgentAction,
  type BrowserAgentActionCommand,
  type BrowserPreparedAgentAction
} from './browser-workspace-agent-action'
import type { BrowserAgentScreenshotLeases } from './browser-agent-screenshot-leases'
import {
  BrowserActionApprovalLeases,
  type BrowserActionApprovalRequester
} from './browser-approval'

type AgentActor = Extract<BrowserActor, { kind: 'agent' }>

export interface BrowserAgentActionCoordinatorOptions {
  engine: BrowserEngine
  tabs: BrowserTabCollection
  requestCache: BrowserWorkspaceRequestCache
  screenshotLeases: BrowserAgentScreenshotLeases
  approvalLeases: BrowserActionApprovalLeases
  capabilities: BrowserCapabilities
  actionStabilityMs: number
  approvalRestoreTimeoutMs: number
  approveAgentAction?: BrowserActionApprovalRequester
  enqueue: <T>(operation: () => Promise<T> | T) => Promise<T>
  isDisposed: () => boolean
  failure: (error: BrowserError) => BrowserOutcome
  success: (screenshot: BrowserScreenshot) => BrowserOutcome
  tabNotFound: (tabId: string) => BrowserError
  cancelledError: (tabId: string) => BrowserError
  onChanged: () => void
}

export class BrowserAgentActionCoordinator {
  readonly #options: BrowserAgentActionCoordinatorOptions
  readonly #requests = new Map<string, Promise<BrowserOutcome>>()
  readonly #tabRequests = new Map<string, string>()
  #approvalTail: Promise<void> = Promise.resolve()

  constructor(options: BrowserAgentActionCoordinatorOptions) {
    this.#options = options
  }

  execute(
    requestKey: string,
    actor: AgentActor,
    command: BrowserAgentActionCommand,
    signal: AbortSignal
  ): Promise<BrowserOutcome> {
    const active = this.#requests.get(requestKey)
    if (active) return active
    const activeTabRequest = this.#tabRequests.get(command.tabId)
    if (activeTabRequest && activeTabRequest !== requestKey) {
      return Promise.resolve(
        this.#options.failure({
          code: 'STALE_DOCUMENT',
          message: 'Another browser action is already using this snapshot',
          retryable: true,
          tabId: command.tabId
        })
      )
    }
    const run = this.#run(requestKey, actor, command, signal)
    this.#requests.set(requestKey, run)
    this.#tabRequests.set(command.tabId, requestKey)
    return run.finally(() => {
      if (this.#requests.get(requestKey) === run) this.#requests.delete(requestKey)
      if (this.#tabRequests.get(command.tabId) === requestKey) {
        this.#tabRequests.delete(command.tabId)
      }
    })
  }

  async #run(
    requestKey: string,
    actor: AgentActor,
    command: BrowserAgentActionCommand,
    signal: AbortSignal
  ): Promise<BrowserOutcome> {
    const prepared = await this.#options.enqueue(async () => {
      const cached = this.#options.requestCache.get(requestKey)
      if (cached) return { kind: 'outcome' as const, outcome: cached }
      if (signal.aborted) {
        return {
          kind: 'outcome' as const,
          outcome: this.#options.failure(this.#options.cancelledError(command.tabId))
        }
      }
      const tab = this.#options.tabs.find(command.tabId)
      if (!tab) {
        return {
          kind: 'outcome' as const,
          outcome: this.#options.failure(this.#options.tabNotFound(command.tabId))
        }
      }
      const result = await prepareBrowserAgentAction({
        actor,
        engine: this.#options.engine,
        tab,
        command,
        activeTabId: this.#options.tabs.activeTabId,
        leases: this.#options.screenshotLeases,
        coordinateInputAvailable: this.#options.capabilities.coordinateInput,
        signal
      })
      return result.ok
        ? { kind: 'prepared' as const, prepared: result.prepared }
        : { kind: 'outcome' as const, outcome: this.#options.failure(result.error) }
    })
    if (prepared.kind === 'outcome') return prepared.outcome
    const complete = (): Promise<BrowserOutcome> =>
      this.#complete(requestKey, actor, command, signal, prepared.prepared)
    if (!prepared.prepared.approvalIdentity) return complete()
    const run = this.#approvalTail.then(complete)
    this.#approvalTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async #complete(
    requestKey: string,
    actor: AgentActor,
    command: BrowserAgentActionCommand,
    signal: AbortSignal,
    prepared: BrowserPreparedAgentAction
  ): Promise<BrowserOutcome> {
    if (prepared.approvalIdentity) {
      if (!this.#options.approveAgentAction || !prepared.approvalPrompt) {
        return this.#remember(
          requestKey,
          command,
          this.#options.failure({
            code: 'PERMISSION_DENIED',
            message: 'Browser input requires explicit user approval',
            retryable: false,
            tabId: command.tabId
          })
        )
      }
      const started = await this.#options.enqueue(() => {
        const tab = this.#options.tabs.find(command.tabId)
        if (!tab) {
          return {
            kind: 'outcome' as const,
            outcome: this.#options.failure(this.#options.tabNotFound(command.tabId))
          }
        }
        const access = authorizeBrowserAgentAction({
          actor,
          command,
          tab,
          activeTabId: this.#options.tabs.activeTabId,
          lease: this.#options.screenshotLeases.get(command.tabId)
        })
        if (!access.ok || tab.snapshot.origin !== prepared.approvalIdentity?.origin) {
          return {
            kind: 'outcome' as const,
            outcome: this.#options.failure(
              access.ok
                ? {
                    code: 'STALE_DOCUMENT',
                    message: 'The browser origin changed before approval started',
                    retryable: true,
                    tabId: command.tabId
                  }
                : access.error
            )
          }
        }
        return {
          kind: 'pending' as const,
          decisionPromise: this.#options.approvalLeases.request(
            prepared.approvalIdentity,
            prepared.approvalPrompt as NonNullable<typeof prepared.approvalPrompt>,
            this.#options.approveAgentAction as BrowserActionApprovalRequester,
            signal
          )
        }
      })
      if (started.kind === 'outcome') {
        return this.#remember(requestKey, command, started.outcome)
      }
      const decision = await started.decisionPromise
      if (decision !== 'approved') {
        return this.#remember(
          requestKey,
          command,
          this.#options.failure({
            code: decision === 'cancelled' ? 'ACTION_CANCELLED' : 'PERMISSION_DENIED',
            message:
              decision === 'cancelled'
                ? 'Browser action was cancelled'
                : 'User denied the browser action',
            retryable: false,
            tabId: command.tabId
          })
        )
      }
    }

    const grantedIdentity = prepared.approvalIdentity
    try {
      if (
        (grantedIdentity && !this.#options.screenshotLeases.isPresented(command.tabId)) ||
        !this.#options.screenshotLeases.matches(
          command.tabId,
          actor.runId,
          command.expectedDocumentRevision
        )
      ) {
        const presented = await this.#options.screenshotLeases.waitUntilPresented(
          command.tabId,
          signal,
          this.#options.approvalRestoreTimeoutMs
        )
        if (!presented) {
          return this.#remember(
            requestKey,
            command,
            this.#options.failure({
              code: signal.aborted ? 'ACTION_CANCELLED' : 'STALE_DOCUMENT',
              message: signal.aborted
                ? 'Browser action was cancelled'
                : 'Browser viewport did not return after approval',
              retryable: false,
              tabId: command.tabId
            })
          )
        }
      }

      const outcome = await this.#options.enqueue(async () => {
        const tab = this.#options.tabs.find(command.tabId)
        if (!tab) return this.#options.failure(this.#options.tabNotFound(command.tabId))
        if (
          !this.#options.screenshotLeases.matches(
            command.tabId,
            actor.runId,
            command.expectedDocumentRevision
          )
        ) {
          if (
            tab.snapshot.origin !== prepared.approvalIdentity?.origin ||
            tab.snapshot.documentRevision !== command.expectedDocumentRevision ||
            tab.snapshot.phase !== 'ready'
          ) {
            return this.#options.failure({
              code: 'STALE_DOCUMENT',
              message: 'The browser page changed before approval completed',
              retryable: true,
              tabId: command.tabId
            })
          }
          const recaptured = await captureBrowserWorkspaceScreenshot({
            engine: this.#options.engine,
            tabs: this.#options.tabs,
            tab,
            screenshotAvailable: this.#options.capabilities.screenshot,
            signal,
            isDisposed: this.#options.isDisposed
          })
          if (!recaptured.ok) return this.#options.failure(recaptured.error)
          if (
            recaptured.screenshot.width !== prepared.originalScreenshotLease.width ||
            recaptured.screenshot.height !== prepared.originalScreenshotLease.height ||
            recaptured.screenshot.documentRevision !== command.expectedDocumentRevision
          ) {
            return this.#options.failure({
              code: 'STALE_DOCUMENT',
              message: 'The browser viewport changed before approval completed',
              retryable: true,
              tabId: command.tabId
            })
          }
          this.#options.screenshotLeases.remember(command.tabId, {
            runId: actor.runId,
            documentRevision: recaptured.screenshot.documentRevision,
            width: recaptured.screenshot.width,
            height: recaptured.screenshot.height
          })
        }
        const executed = await executePreparedBrowserAgentAction({
          actor,
          engine: this.#options.engine,
          tabs: this.#options.tabs,
          tab,
          command,
          prepared,
          activeTabId: this.#options.tabs.activeTabId,
          leases: this.#options.screenshotLeases,
          approvalLeases: this.#options.approvalLeases,
          screenshotAvailable: this.#options.capabilities.screenshot,
          actionStabilityMs: this.#options.actionStabilityMs,
          signal,
          isDisposed: this.#options.isDisposed,
          onChanged: this.#options.onChanged
        })
        return executed.ok
          ? this.#options.success(executed.screenshot)
          : this.#options.failure(executed.error)
      })
      return this.#remember(requestKey, command, outcome)
    } finally {
      if (grantedIdentity) this.#options.approvalLeases.revoke(grantedIdentity)
    }
  }

  #remember(
    requestKey: string,
    command: BrowserAgentActionCommand,
    outcome: BrowserOutcome
  ): BrowserOutcome {
    if (!this.#options.isDisposed()) {
      this.#options.requestCache.remember(
        requestKey,
        outcome.ok
          ? {
              ok: false,
              error: {
                code: 'CAPABILITY_UNAVAILABLE',
                message: 'Browser input was already delivered; take a new snapshot',
                retryable: false,
                tabId: command.tabId
              },
              snapshot: outcome.snapshot
            }
          : outcome
      )
    }
    return outcome
  }
}
