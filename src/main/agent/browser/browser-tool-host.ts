import type { BrowserOutcome } from '../../../shared/browserTypes'

const MAX_ORIGIN_ID_BYTES = 512
const MAX_ID_BYTES = 256
const MAX_URL_BYTES = 16 * 1024

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

function requestKey(originSessionId: string, requestId: string): string {
  return JSON.stringify([originSessionId, requestId])
}

export class BrowserToolHostCoordinator {
  readonly #resolveActiveRun: BrowserToolHostCoordinatorOptions['resolveActiveRun']
  readonly #executeAgent: BrowserToolHostCoordinatorOptions['executeAgent']
  readonly #rememberedRequestCap: number
  readonly #controllers = new Map<string, AbortController>()
  readonly #cancelledBeforeStart = new Set<string>()
  readonly #completed = new Set<string>()

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

    const key = requestKey(request.originSessionId, request.requestId)
    if (this.#controllers.has(key)) throw new Error('Browser request is already active')
    this.#completed.delete(key)
    const controller = new AbortController()
    if (this.#cancelledBeforeStart.delete(key)) controller.abort()
    this.#controllers.set(key, controller)
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
      if (this.#controllers.get(key) === controller) this.#controllers.delete(key)
      this.#remember(this.#completed, key)
    }
  }

  cancel(input: unknown): void {
    if (!isRecord(input)) throw new Error('Invalid browser host request')
    const originSessionId = boundedString(input.originSessionId, MAX_ORIGIN_ID_BYTES)
    const requestId = boundedString(input.requestId, MAX_ID_BYTES)
    if (!this.#resolveActiveRun(originSessionId)) {
      throw new Error('Active browser run is unavailable')
    }
    const key = requestKey(originSessionId, requestId)
    const controller = this.#controllers.get(key)
    if (controller) {
      controller.abort()
      return
    }
    if (!this.#completed.has(key)) this.#remember(this.#cancelledBeforeStart, key)
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
}
