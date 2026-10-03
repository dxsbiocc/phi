import { createHash } from 'node:crypto'
import type { BrowserCommand } from '../../shared/browserTypes'
import { isLoopbackBrowserHostname } from './browser-policy'
import type { EngineTargetInspection } from './browser-engine'

export type BrowserActionName = 'click' | 'typeText' | 'scroll' | 'keypress'
export type BrowserActionConsequence = 'read' | 'write' | 'irreversible'
export type BrowserActionApprovalReason = 'external_origin' | 'form_submission' | 'irreversible'

export type BrowserActionApprovalRequirement =
  { kind: 'allow' } | { kind: 'confirm'; reason: BrowserActionApprovalReason }

export type BrowserActionApprovalDecision = 'approved' | 'denied' | 'cancelled'

export interface BrowserActionApprovalIdentity {
  sessionId: string
  runId: string
  toolCallId: string
  requestId: string
  tabId: string
  origin: string
  documentRevision: number
  action: BrowserActionName
  consequence: BrowserActionConsequence
  targetFingerprint: string | null
  targetDescriptorDigest: string | null
  textDigest: string | null
  actionDigest: string
}

export interface BrowserActionApprovalPrompt {
  sessionId: string
  runId: string
  toolCallId: string
  origin: string
  action: BrowserActionName
  consequence: BrowserActionConsequence
  reason: BrowserActionApprovalReason
}

export type BrowserActionApprovalRequester = (
  request: BrowserActionApprovalPrompt,
  signal: AbortSignal
) => Promise<BrowserActionApprovalDecision>

function safeHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
}

export function browserActionApprovalRequirement(options: {
  url: string
  action: BrowserActionName
  consequence: BrowserActionConsequence
  submitsForm: boolean
}): BrowserActionApprovalRequirement {
  if (options.consequence === 'irreversible') {
    return { kind: 'confirm', reason: 'irreversible' }
  }
  if (options.submitsForm) return { kind: 'confirm', reason: 'form_submission' }
  const parsed = safeHttpUrl(options.url)
  if (!parsed || !isLoopbackBrowserHostname(parsed.hostname)) {
    return { kind: 'confirm', reason: 'external_origin' }
  }
  return { kind: 'allow' }
}

export function isLoopbackBrowserActionUrl(value: string): boolean {
  const parsed = safeHttpUrl(value)
  return Boolean(parsed && isLoopbackBrowserHostname(parsed.hostname))
}

function identityKey(identity: BrowserActionApprovalIdentity): string {
  return JSON.stringify([
    identity.sessionId,
    identity.runId,
    identity.toolCallId,
    identity.requestId,
    identity.tabId,
    identity.origin,
    identity.documentRevision,
    identity.action,
    identity.consequence,
    identity.targetFingerprint,
    identity.targetDescriptorDigest,
    identity.textDigest,
    identity.actionDigest
  ])
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function browserTargetDescriptorDigest(
  inspection: EngineTargetInspection | undefined
): string | null {
  return inspection ? digest(inspection.descriptor) : null
}

export function browserTextDigest(text: string | undefined): string | null {
  return text === undefined ? null : digest({ text })
}

type ApprovalActionCommand = Extract<
  BrowserCommand,
  { type: 'click' | 'typeText' | 'scroll' | 'keypress' }
>

export function browserActionDigest(command: ApprovalActionCommand): string {
  switch (command.type) {
    case 'click':
      return digest({
        action: command.type,
        x: command.x,
        y: command.y,
        consequence: command.consequence
      })
    case 'typeText':
      return digest({
        action: command.type,
        textDigest: browserTextDigest(command.text),
        consequence: command.consequence
      })
    case 'scroll':
      return digest({ action: command.type, deltaX: command.deltaX, deltaY: command.deltaY })
    case 'keypress':
      return digest({
        action: command.type,
        key: command.key,
        modifiers: command.modifiers ?? []
      })
  }
}

interface PendingApproval {
  identity: BrowserActionApprovalIdentity
  controller: AbortController
}

/**
 * Holds only short-lived, one-action approvals. It deliberately has no
 * serialization API: browser approval must never become a remembered site
 * allowlist or survive the process.
 */
export class BrowserActionApprovalLeases {
  readonly #leases = new Map<
    string,
    { identity: BrowserActionApprovalIdentity; cleanup: () => void }
  >()
  readonly #pending = new Map<string, PendingApproval>()

  async request(
    identity: BrowserActionApprovalIdentity,
    prompt: BrowserActionApprovalPrompt,
    approve: BrowserActionApprovalRequester,
    signal?: AbortSignal
  ): Promise<BrowserActionApprovalDecision> {
    const key = identityKey(identity)
    this.#deleteLease(key)
    this.#pending.get(key)?.controller.abort()
    const controller = new AbortController()
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    this.#pending.set(key, { identity: { ...identity }, controller })
    if (combinedSignal.aborted) {
      this.#pending.delete(key)
      return 'cancelled'
    }

    let decision: BrowserActionApprovalDecision
    try {
      decision = await approve({ ...prompt }, combinedSignal)
    } catch {
      decision = 'cancelled'
    } finally {
      if (this.#pending.get(key)?.controller === controller) this.#pending.delete(key)
    }
    if (combinedSignal.aborted) return 'cancelled'
    if (decision === 'approved') {
      const onAbort = (): void => this.#deleteLease(key)
      combinedSignal.addEventListener('abort', onAbort, { once: true })
      this.#leases.set(key, {
        identity: { ...identity },
        cleanup: () => combinedSignal.removeEventListener('abort', onAbort)
      })
    }
    return decision
  }

  consume(identity: BrowserActionApprovalIdentity): boolean {
    const key = identityKey(identity)
    if (!this.#leases.has(key)) return false
    this.#deleteLease(key)
    return true
  }

  revoke(identity: BrowserActionApprovalIdentity): void {
    this.#deleteLease(identityKey(identity))
  }

  invalidateTab(tabId: string): void {
    this.#invalidate((identity) => identity.tabId === tabId)
  }

  invalidateRun(runId: string): void {
    this.#invalidate((identity) => identity.runId === runId)
  }

  clear(): void {
    for (const pending of this.#pending.values()) pending.controller.abort()
    this.#pending.clear()
    for (const key of [...this.#leases.keys()]) this.#deleteLease(key)
  }

  snapshotForTesting(): BrowserActionApprovalIdentity[] {
    return [...this.#leases.values()].map(({ identity }) => ({ ...identity }))
  }

  #invalidate(predicate: (identity: BrowserActionApprovalIdentity) => boolean): void {
    for (const [key, pending] of this.#pending) {
      if (!predicate(pending.identity)) continue
      pending.controller.abort()
      this.#pending.delete(key)
    }
    for (const [key, lease] of this.#leases) {
      if (predicate(lease.identity)) this.#deleteLease(key)
    }
  }

  #deleteLease(key: string): void {
    const lease = this.#leases.get(key)
    if (!lease) return
    this.#leases.delete(key)
    lease.cleanup()
  }
}
