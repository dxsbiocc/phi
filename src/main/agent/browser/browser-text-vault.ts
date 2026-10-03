import { randomUUID } from 'node:crypto'
import {
  BROWSER_MAX_SCREENSHOT_COORDINATE,
  BROWSER_MAX_SCROLL_DELTA,
  BROWSER_MAX_TEXT_BYTES,
  BROWSER_SAFE_KEYS,
  BROWSER_SAFE_MODIFIERS
} from '../../../shared/browserTypes'

const PLACEHOLDER_PREFIX = '__phi_browser_text_v1__:'
const MAX_URL_BYTES = 16 * 1024
const INVALID_BROWSER_INPUT = Object.freeze({ action: 'invalid' })
const SAFE_KEYS = new Set<string>(BROWSER_SAFE_KEYS)

type VaultEntry = {
  placeholder: string
  text?: string
  valid: boolean
  denied?: boolean
  abortCleanup?: () => void
}

export interface BrowserTextVaultOptions {
  cap?: number
  tokenFactory?: () => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= BROWSER_MAX_TEXT_BYTES &&
    !value.startsWith(PLACEHOLDER_PREFIX)
  )
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 256
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function boundedUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_URL_BYTES
  )
}

function exactKeys(input: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(input).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function optionalTargetKeys(input: Record<string, unknown>, base: readonly string[]): boolean {
  return exactKeys(input, [...base, ...(Object.hasOwn(input, 'target') ? ['target'] : [])])
}

function validOptionalTarget(input: Record<string, unknown>): boolean {
  return (
    !Object.hasOwn(input, 'target') || input.target === 'current' || input.target === 'dedicated'
  )
}

function validCoordinate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= BROWSER_MAX_SCREENSHOT_COORDINATE
  )
}

function validScroll(value: unknown): value is number {
  return Number.isSafeInteger(value) && Math.abs(value as number) <= BROWSER_MAX_SCROLL_DELTA
}

function validModifiers(value: unknown): value is ['shift'] | [] {
  return (
    Array.isArray(value) &&
    (value.length === 0 ||
      (value.length === 1 && BROWSER_SAFE_MODIFIERS.includes(value[0] as 'shift')))
  )
}

function validTypeTextInput(input: Record<string, unknown>): input is Record<string, unknown> & {
  tabId: string
  expectedDocumentRevision: number
  text: string
  consequence: 'write' | 'irreversible'
} {
  const expectedKeys = [
    'action',
    'tabId',
    'expectedDocumentRevision',
    'text',
    'consequence',
    ...(Object.hasOwn(input, 'target') ? ['target'] : [])
  ].sort()
  const actualKeys = Object.keys(input).sort()
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    input.action === 'typeText' &&
    boundedIdentity(input.tabId) &&
    validRevision(input.expectedDocumentRevision) &&
    validOptionalTarget(input) &&
    (input.consequence === 'write' || input.consequence === 'irreversible') &&
    validText(input.text)
  )
}

export class BrowserTextVault {
  readonly #cap: number
  readonly #tokenFactory: () => string
  readonly #entries = new Map<string, VaultEntry>()

  constructor(options: BrowserTextVaultOptions = {}) {
    this.#cap =
      Number.isSafeInteger(options.cap) && (options.cap as number) > 0
        ? Math.min(options.cap as number, 1024)
        : 128
    this.#tokenFactory = options.tokenFactory ?? randomUUID
  }

  redact(toolCallId: string, input: unknown): Record<string, unknown> | undefined {
    if (!isRecord(input) || !Object.hasOwn(input, 'text')) return undefined
    return this.sanitize(toolCallId, input)
  }

  sanitize(toolCallId: string, input: unknown): Record<string, unknown> {
    if (!boundedIdentity(toolCallId) || !isRecord(input)) return { ...INVALID_BROWSER_INPUT }
    if (input.action !== 'typeText') return sanitizeOrdinaryBrowserInput(input)
    if (!validTypeTextInput(input)) return { ...INVALID_BROWSER_INPUT }
    const existing = this.#entries.get(toolCallId)
    if (existing && typeof input.text === 'string' && input.text === existing.placeholder) {
      return this.#redactedShape(input, existing.placeholder)
    }
    const placeholder = `${PLACEHOLDER_PREFIX}${this.#tokenFactory()}`
    const entry: VaultEntry = { placeholder, text: input.text, valid: true }
    this.#remember(toolCallId, entry)
    return this.#redactedShape(input, placeholder)
  }

  approvalInput(toolCallId: string, input: unknown): Record<string, unknown> {
    if (!isRecord(input)) return { ...INVALID_BROWSER_INPUT }
    if (input.action !== 'typeText') return sanitizeOrdinaryBrowserInput(input)
    if (!validTypeTextShapeWithPlaceholder(input)) return { ...INVALID_BROWSER_INPUT }
    const entry = this.#entries.get(toolCallId)
    if (!entry || input.text !== entry.placeholder) return { ...INVALID_BROWSER_INPUT }
    return this.#redactedShape(input, entry.placeholder)
  }

  take(toolCallId: string, placeholder: unknown): { text?: string; denied?: boolean } | undefined {
    if (!boundedIdentity(toolCallId) || typeof placeholder !== 'string') return undefined
    const entry = this.#entries.get(toolCallId)
    if (!entry || entry.placeholder !== placeholder) return undefined
    entry.abortCleanup?.()
    this.#entries.delete(toolCallId)
    if (entry.denied) return { denied: true }
    return entry.valid && entry.text ? { text: entry.text } : {}
  }

  markDenied(toolCallId: string): void {
    const entry = this.#entries.get(toolCallId)
    if (!entry) return
    entry.abortCleanup?.()
    this.#entries.set(toolCallId, {
      placeholder: entry.placeholder,
      valid: false,
      denied: true
    })
  }

  watchAbort(toolCallId: string, signal: AbortSignal): void {
    const entry = this.#entries.get(toolCallId)
    if (!entry) return
    entry.abortCleanup?.()
    if (signal.aborted) {
      this.markDenied(toolCallId)
      return
    }
    const onAbort = (): void => this.markDenied(toolCallId)
    signal.addEventListener('abort', onAbort, { once: true })
    entry.abortCleanup = () => signal.removeEventListener('abort', onAbort)
  }

  clear(): void {
    for (const entry of this.#entries.values()) entry.abortCleanup?.()
    this.#entries.clear()
  }

  #redactedShape(input: Record<string, unknown>, placeholder: string): Record<string, unknown> {
    return {
      action: 'typeText',
      ...(input.target === 'current' || input.target === 'dedicated'
        ? { target: input.target }
        : {}),
      ...(boundedIdentity(input.tabId) ? { tabId: input.tabId } : {}),
      ...(validRevision(input.expectedDocumentRevision)
        ? { expectedDocumentRevision: input.expectedDocumentRevision }
        : {}),
      text: placeholder,
      consequence: input.consequence
    }
  }

  #remember(toolCallId: string, entry: VaultEntry): void {
    this.#entries.get(toolCallId)?.abortCleanup?.()
    this.#entries.delete(toolCallId)
    this.#entries.set(toolCallId, entry)
    while (this.#entries.size > this.#cap) {
      const oldest = this.#entries.keys().next().value
      if (typeof oldest !== 'string') break
      this.#entries.get(oldest)?.abortCleanup?.()
      this.#entries.delete(oldest)
    }
  }
}

function validTypeTextShapeWithPlaceholder(input: Record<string, unknown>): boolean {
  return (
    optionalTargetKeys(input, [
      'action',
      'tabId',
      'expectedDocumentRevision',
      'text',
      'consequence'
    ]) &&
    input.action === 'typeText' &&
    boundedIdentity(input.tabId) &&
    validRevision(input.expectedDocumentRevision) &&
    validOptionalTarget(input) &&
    (input.consequence === 'write' || input.consequence === 'irreversible') &&
    typeof input.text === 'string' &&
    input.text.startsWith(PLACEHOLDER_PREFIX)
  )
}

function sanitizeOrdinaryBrowserInput(input: Record<string, unknown>): Record<string, unknown> {
  switch (input.action) {
    case 'open': {
      if (
        optionalTargetKeys(input, ['action', 'url']) &&
        (!Object.hasOwn(input, 'target') || input.target === 'dedicated') &&
        boundedUrl(input.url)
      ) {
        return {
          action: 'open',
          url: input.url,
          ...(input.target === 'dedicated' ? { target: 'dedicated' } : {})
        }
      }
      if (
        exactKeys(input, ['action', 'url', 'target', 'tabId', 'expectedDocumentRevision']) &&
        input.target === 'current' &&
        boundedUrl(input.url) &&
        boundedIdentity(input.tabId) &&
        validRevision(input.expectedDocumentRevision)
      ) {
        return {
          action: 'open',
          url: input.url,
          target: 'current',
          tabId: input.tabId,
          expectedDocumentRevision: input.expectedDocumentRevision
        }
      }
      break
    }
    case 'snapshot': {
      if (
        optionalTargetKeys(input, ['action', 'tabId']) &&
        (!Object.hasOwn(input, 'target') || input.target === 'dedicated') &&
        boundedIdentity(input.tabId)
      ) {
        return {
          action: 'snapshot',
          tabId: input.tabId,
          ...(input.target === 'dedicated' ? { target: 'dedicated' } : {})
        }
      }
      if (
        exactKeys(input, ['action', 'target', 'tabId', 'expectedDocumentRevision']) &&
        input.target === 'current' &&
        boundedIdentity(input.tabId) &&
        validRevision(input.expectedDocumentRevision)
      ) {
        return {
          action: 'snapshot',
          target: 'current',
          tabId: input.tabId,
          expectedDocumentRevision: input.expectedDocumentRevision
        }
      }
      break
    }
    case 'click':
      if (
        optionalTargetKeys(input, [
          'action',
          'tabId',
          'expectedDocumentRevision',
          'x',
          'y',
          'consequence'
        ]) &&
        validOptionalTarget(input) &&
        boundedIdentity(input.tabId) &&
        validRevision(input.expectedDocumentRevision) &&
        validCoordinate(input.x) &&
        validCoordinate(input.y) &&
        (input.consequence === 'read' ||
          input.consequence === 'write' ||
          input.consequence === 'irreversible')
      ) {
        return {
          action: 'click',
          tabId: input.tabId,
          expectedDocumentRevision: input.expectedDocumentRevision,
          x: input.x,
          y: input.y,
          consequence: input.consequence,
          ...(input.target ? { target: input.target } : {})
        }
      }
      break
    case 'scroll':
      if (
        optionalTargetKeys(input, [
          'action',
          'tabId',
          'expectedDocumentRevision',
          'deltaX',
          'deltaY'
        ]) &&
        validOptionalTarget(input) &&
        boundedIdentity(input.tabId) &&
        validRevision(input.expectedDocumentRevision) &&
        validScroll(input.deltaX) &&
        validScroll(input.deltaY) &&
        (input.deltaX !== 0 || input.deltaY !== 0)
      ) {
        return {
          action: 'scroll',
          tabId: input.tabId,
          expectedDocumentRevision: input.expectedDocumentRevision,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          ...(input.target ? { target: input.target } : {})
        }
      }
      break
    case 'keypress': {
      const hasModifiers = Object.hasOwn(input, 'modifiers')
      if (
        exactKeys(input, [
          'action',
          'tabId',
          'expectedDocumentRevision',
          'key',
          ...(Object.hasOwn(input, 'target') ? ['target'] : []),
          ...(hasModifiers ? ['modifiers'] : [])
        ]) &&
        validOptionalTarget(input) &&
        boundedIdentity(input.tabId) &&
        validRevision(input.expectedDocumentRevision) &&
        typeof input.key === 'string' &&
        SAFE_KEYS.has(input.key) &&
        (!hasModifiers || validModifiers(input.modifiers))
      ) {
        return {
          action: 'keypress',
          tabId: input.tabId,
          expectedDocumentRevision: input.expectedDocumentRevision,
          key: input.key,
          ...(hasModifiers ? { modifiers: [...(input.modifiers as string[])] } : {}),
          ...(input.target ? { target: input.target } : {})
        }
      }
      break
    }
  }
  return { ...INVALID_BROWSER_INPUT }
}

export function installBrowserTextPreDispatchRedaction<TContext, TResult>(
  session: {
    agent: {
      beforeToolCall?: (
        context: TContext,
        signal?: AbortSignal
      ) => Promise<TResult | undefined> | TResult | undefined
    }
  },
  vault: BrowserTextVault
): void {
  const beforeToolCall = session.agent.beforeToolCall
  session.agent.beforeToolCall = async (context, signal) => {
    const record = context as {
      toolCall?: { id?: unknown; name?: unknown; arguments?: unknown }
      args?: unknown
    }
    if (record.toolCall?.name !== 'browser' || typeof record.toolCall.id !== 'string') {
      return await beforeToolCall?.(context, signal)
    }
    const input = vault.sanitize(record.toolCall.id, record.args)
    record.toolCall.arguments = input
    record.args = input
    if (signal) vault.watchAbort(record.toolCall.id, signal)
    try {
      const result = await beforeToolCall?.({ ...context, args: input } as TContext, signal)
      if (
        typeof result === 'object' &&
        result !== null &&
        !Array.isArray(result) &&
        (result as { block?: unknown }).block === true
      ) {
        vault.markDenied(record.toolCall.id)
        return result
      }
      return {
        ...(typeof result === 'object' && result !== null && !Array.isArray(result) ? result : {}),
        args: input
      } as TResult
    } catch (error) {
      vault.markDenied(record.toolCall.id)
      throw error
    }
  }
}

export async function withBrowserTextVaultCleanup<T>(
  vault: BrowserTextVault,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run()
  } finally {
    vault.clear()
  }
}
