import {
  BROWSER_MAX_SCREENSHOT_COORDINATE,
  BROWSER_MAX_SCROLL_DELTA,
  BROWSER_MAX_TEXT_BYTES,
  BROWSER_SAFE_KEYS,
  BROWSER_SAFE_MODIFIERS,
  type BrowserOutcome
} from '../../../shared/browserTypes'

const MAX_ORIGIN_ID_BYTES = 512
const MAX_ID_BYTES = 256
const MAX_URL_BYTES = 16 * 1024
const SAFE_KEYS = new Set<string>(BROWSER_SAFE_KEYS)

export interface BrowserToolActiveRun {
  runId: string
  cancelled: boolean
}

export interface BrowserToolHostCoordinatorOptions {
  resolveActiveRun: (originSessionId: string) => BrowserToolActiveRun | undefined
  executeAgent: (input: unknown, signal: AbortSignal) => Promise<BrowserOutcome>
  rememberedRequestCap?: number
}

type ParsedRequest = {
  originSessionId: string
  requestId: string
  toolCallId: string
  command: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error('Invalid browser host request')
  }
  return value
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function documentRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid browser host request')
  }
  return value as number
}

function coordinate(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > BROWSER_MAX_SCREENSHOT_COORDINATE
  ) {
    throw new Error('Invalid browser host request')
  }
  return value
}

function scrollDelta(value: unknown): number {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > BROWSER_MAX_SCROLL_DELTA) {
    throw new Error('Invalid browser host request')
  }
  return value as number
}

function validateInputKeys(command: Record<string, unknown>, baseKeys: string[]): void {
  if (!exactKeys(command, [...baseKeys, 'requireActive']) || command.requireActive !== true) {
    throw new Error('Invalid browser host request')
  }
}

function parseCommand(
  command: Record<string, unknown>,
  requestId: string
): Record<string, unknown> {
  if (command.requestId !== requestId) throw new Error('Invalid browser host request')
  if (command.type === 'open') {
    if (!exactKeys(command, ['type', 'requestId', 'url'])) {
      throw new Error('Invalid browser host request')
    }
    return {
      type: 'open',
      requestId,
      url: boundedString(command.url, MAX_URL_BYTES)
    }
  }
  if (command.type === 'navigate') {
    if (
      !exactKeys(command, [
        'type',
        'requestId',
        'tabId',
        'url',
        'expectedDocumentRevision',
        'requireActive'
      ]) ||
      command.requireActive !== true
    ) {
      throw new Error('Invalid browser host request')
    }
    return {
      type: 'navigate',
      requestId,
      tabId: boundedString(command.tabId, MAX_ID_BYTES),
      url: boundedString(command.url, MAX_URL_BYTES),
      expectedDocumentRevision: documentRevision(command.expectedDocumentRevision),
      requireActive: true
    }
  }
  if (command.type === 'snapshot') {
    const dedicated = exactKeys(command, ['type', 'requestId', 'tabId'])
    const current = exactKeys(command, [
      'type',
      'requestId',
      'tabId',
      'expectedDocumentRevision',
      'requireActive'
    ])
    if (!dedicated && (!current || command.requireActive !== true)) {
      throw new Error('Invalid browser host request')
    }
    return {
      type: 'snapshot',
      requestId,
      tabId: boundedString(command.tabId, MAX_ID_BYTES),
      ...(current
        ? {
            expectedDocumentRevision: documentRevision(command.expectedDocumentRevision),
            requireActive: true
          }
        : {})
    }
  }
  if (command.type === 'click') {
    validateInputKeys(command, [
      'type',
      'requestId',
      'tabId',
      'expectedDocumentRevision',
      'x',
      'y',
      'consequence'
    ])
    if (
      command.consequence !== 'read' &&
      command.consequence !== 'write' &&
      command.consequence !== 'irreversible'
    ) {
      throw new Error('Invalid browser host request')
    }
    return {
      type: 'click',
      requestId,
      tabId: boundedString(command.tabId, MAX_ID_BYTES),
      expectedDocumentRevision: documentRevision(command.expectedDocumentRevision),
      requireActive: true,
      x: coordinate(command.x),
      y: coordinate(command.y),
      consequence: command.consequence
    }
  }
  if (command.type === 'typeText') {
    validateInputKeys(command, [
      'type',
      'requestId',
      'tabId',
      'expectedDocumentRevision',
      'text',
      'consequence'
    ])
    if (command.consequence !== 'write' && command.consequence !== 'irreversible') {
      throw new Error('Invalid browser host request')
    }
    return {
      type: 'typeText',
      requestId,
      tabId: boundedString(command.tabId, MAX_ID_BYTES),
      expectedDocumentRevision: documentRevision(command.expectedDocumentRevision),
      requireActive: true,
      text: boundedString(command.text, BROWSER_MAX_TEXT_BYTES),
      consequence: command.consequence
    }
  }
  if (command.type === 'scroll') {
    validateInputKeys(command, [
      'type',
      'requestId',
      'tabId',
      'expectedDocumentRevision',
      'deltaX',
      'deltaY'
    ])
    const deltaX = scrollDelta(command.deltaX)
    const deltaY = scrollDelta(command.deltaY)
    if (deltaX === 0 && deltaY === 0) throw new Error('Invalid browser host request')
    return {
      type: 'scroll',
      requestId,
      tabId: boundedString(command.tabId, MAX_ID_BYTES),
      expectedDocumentRevision: documentRevision(command.expectedDocumentRevision),
      requireActive: true,
      deltaX,
      deltaY
    }
  }
  if (command.type === 'keypress') {
    const hasModifiers = Object.hasOwn(command, 'modifiers')
    validateInputKeys(command, [
      'type',
      'requestId',
      'tabId',
      'expectedDocumentRevision',
      'key',
      ...(hasModifiers ? ['modifiers'] : [])
    ])
    const key = boundedString(command.key, 16)
    if (!SAFE_KEYS.has(key)) throw new Error('Invalid browser host request')
    if (
      hasModifiers &&
      (!Array.isArray(command.modifiers) ||
        command.modifiers.length > 1 ||
        (command.modifiers.length === 1 &&
          !BROWSER_SAFE_MODIFIERS.includes(command.modifiers[0] as 'shift')))
    ) {
      throw new Error('Invalid browser host request')
    }
    return {
      type: 'keypress',
      requestId,
      tabId: boundedString(command.tabId, MAX_ID_BYTES),
      expectedDocumentRevision: documentRevision(command.expectedDocumentRevision),
      requireActive: true,
      key,
      ...(hasModifiers ? { modifiers: [...(command.modifiers as string[])] } : {})
    }
  }
  throw new Error('Invalid browser host request')
}

function parseRequest(value: unknown): ParsedRequest {
  if (!isRecord(value) || !isRecord(value.command)) {
    throw new Error('Invalid browser host request')
  }
  const originSessionId = boundedString(value.originSessionId, MAX_ORIGIN_ID_BYTES)
  const requestId = boundedString(value.requestId, MAX_ID_BYTES)
  const toolCallId = boundedString(value.toolCallId, MAX_ID_BYTES)
  return {
    originSessionId,
    requestId,
    toolCallId,
    command: parseCommand(value.command, requestId)
  }
}

function requestIdentityKey(
  originSessionId: string,
  runId: string,
  toolCallId: string,
  requestId: string
): string {
  return JSON.stringify([originSessionId, runId, toolCallId, requestId])
}

function requestBaseKey(originSessionId: string, toolCallId: string, requestId: string): string {
  return JSON.stringify([originSessionId, toolCallId, requestId])
}

export class BrowserToolHostCoordinator {
  readonly #resolveActiveRun: BrowserToolHostCoordinatorOptions['resolveActiveRun']
  readonly #executeAgent: BrowserToolHostCoordinatorOptions['executeAgent']
  readonly #rememberedRequestCap: number
  readonly #controllers = new Map<
    string,
    { controller: AbortController; runId: string; originSessionId: string }
  >()
  readonly #cancelledBeforeStart = new Set<string>()
  readonly #completed = new Set<string>()
  readonly #requestRuns = new Map<string, string>()

  constructor(options: BrowserToolHostCoordinatorOptions) {
    this.#resolveActiveRun = options.resolveActiveRun
    this.#executeAgent = options.executeAgent
    this.#rememberedRequestCap =
      Number.isSafeInteger(options.rememberedRequestCap) &&
      (options.rememberedRequestCap as number) > 0
        ? Math.min(options.rememberedRequestCap as number, 4096)
        : 256
  }

  async execute(input: unknown): Promise<BrowserOutcome> {
    const request = parseRequest(input)
    const run = this.#resolveActiveRun(request.originSessionId)
    if (!run || run.cancelled) throw new Error('Active browser run is unavailable')

    const baseKey = requestBaseKey(request.originSessionId, request.toolCallId, request.requestId)
    const existingRunId = this.#requestRuns.get(baseKey)
    if (existingRunId && existingRunId !== run.runId) {
      throw new Error('Browser request belongs to another run')
    }
    this.#rememberMap(this.#requestRuns, baseKey, run.runId)
    const key = requestIdentityKey(
      request.originSessionId,
      run.runId,
      request.toolCallId,
      request.requestId
    )
    if (this.#controllers.has(key)) throw new Error('Browser request is already active')
    this.#completed.delete(key)
    const controller = new AbortController()
    if (this.#cancelledBeforeStart.delete(key)) controller.abort()
    this.#controllers.set(key, {
      controller,
      runId: run.runId,
      originSessionId: request.originSessionId
    })
    try {
      return await this.#executeAgent(
        {
          originSessionId: request.originSessionId,
          runId: run.runId,
          toolCallId: request.toolCallId,
          command: request.command
        },
        controller.signal
      )
    } finally {
      if (this.#controllers.get(key)?.controller === controller) this.#controllers.delete(key)
      this.#remember(this.#completed, key)
    }
  }

  cancel(input: unknown): void {
    if (!isRecord(input) || !exactKeys(input, ['originSessionId', 'requestId', 'toolCallId'])) {
      throw new Error('Invalid browser host request')
    }
    const originSessionId = boundedString(input.originSessionId, MAX_ORIGIN_ID_BYTES)
    const requestId = boundedString(input.requestId, MAX_ID_BYTES)
    const toolCallId = boundedString(input.toolCallId, MAX_ID_BYTES)
    const baseKey = requestBaseKey(originSessionId, toolCallId, requestId)
    const recordedRunId = this.#requestRuns.get(baseKey)
    if (recordedRunId) {
      const recordedKey = requestIdentityKey(originSessionId, recordedRunId, toolCallId, requestId)
      const active = this.#controllers.get(recordedKey)
      if (active) active.controller.abort()
      return
    }
    const currentRun = this.#resolveActiveRun(originSessionId)
    if (!currentRun) throw new Error('Active browser run is unavailable')
    const key = requestIdentityKey(originSessionId, currentRun.runId, toolCallId, requestId)
    const active = this.#controllers.get(key)
    if (active) {
      active.controller.abort()
      return
    }
    if (!this.#completed.has(key)) this.#remember(this.#cancelledBeforeStart, key)
  }

  cancelRun(runId: string, originSessionId?: string): void {
    if (!runId) return
    for (const active of this.#controllers.values()) {
      if (active.runId !== runId) continue
      if (originSessionId && active.originSessionId !== originSessionId) continue
      active.controller.abort()
    }
  }

  #remember(target: Set<string>, key: string): void {
    target.delete(key)
    target.add(key)
    while (target.size > this.#rememberedRequestCap) {
      const oldest = target.values().next().value
      if (typeof oldest !== 'string') break
      target.delete(oldest)
    }
  }

  #rememberMap(target: Map<string, string>, key: string, value: string): void {
    target.delete(key)
    target.set(key, value)
    while (target.size > this.#rememberedRequestCap) {
      const oldest = target.keys().next().value
      if (typeof oldest !== 'string') break
      target.delete(oldest)
    }
  }
}
