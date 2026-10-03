import type {
  BrowserActor,
  BrowserCommand,
  BrowserOutcome,
  BrowserRendererEventEnvelope,
  BrowserViewport,
  BrowserWorkspaceEvent,
  BrowserWorkspaceSnapshot
} from '../../shared/browserTypes'
import {
  BROWSER_MAX_SCREENSHOT_COORDINATE,
  BROWSER_MAX_SCROLL_DELTA,
  BROWSER_MAX_TEXT_BYTES,
  BROWSER_SAFE_KEYS,
  BROWSER_SAFE_MODIFIERS
} from '../../shared/browserTypes'
import type {
  BrowserWorkspaceOwner,
  BrowserWorkspaceRegistration
} from './browser-workspace-registry'
import type { BrowserPolicyContext } from './browser-policy'

const MAX_ID_BYTES = 256
const MAX_ORIGIN_ID_BYTES = 512
const MAX_URL_BYTES = 16 * 1024
const MAX_KEY_BYTES = 64
const MAX_COORDINATE = BROWSER_MAX_SCREENSHOT_COORDINATE
const SAFE_BROWSER_KEYS = new Set<string>(BROWSER_SAFE_KEYS)

export interface BrowserRendererSenderLike {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): unknown
}

export interface BrowserWorkspaceLike {
  execute(
    actor: BrowserActor,
    command: BrowserCommand,
    signal?: AbortSignal
  ): Promise<BrowserOutcome>
  snapshot(): BrowserWorkspaceSnapshot
  setViewport(tabId: string, viewport: BrowserViewport | null): Promise<void>
  subscribe(listener: (event: BrowserWorkspaceEvent) => void): () => void
}

export interface BrowserWorkspaceRegistryLike {
  getOrCreate(registration: BrowserWorkspaceRegistration): Promise<BrowserWorkspaceLike>
  disposeSession(sessionId: string): Promise<void>
}

export interface BrowserIpcSession {
  sessionId: string
  owner: BrowserWorkspaceOwner
  sessionGeneration?: number
}

export interface BrowserIpcCoordinatorOptions {
  getRegistry: () => BrowserWorkspaceRegistryLike
  getTrustedRenderer: () => BrowserRendererSenderLike | null
  resolveHumanSession: () => BrowserIpcSession | undefined
  resolveAgentSession: (originSessionId: string) => BrowserIpcSession | undefined
}

export interface BrowserAppShellWindowOpenDetails {
  url: string
  disposition?: string
  postBody?: unknown
}

export interface BrowserAppShellWindowOpenOptions {
  details: BrowserAppShellWindowOpenDetails
  coordinator: BrowserIpcCoordinator
  policyContext?: BrowserPolicyContext
  openExternal: (url: string) => Promise<void>
}

export interface BrowserIpcMainLike {
  handle(
    channel: string,
    handler: (event: { sender: BrowserRendererSenderLike }, input?: unknown) => unknown
  ): unknown
}

export class BrowserIpcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserIpcError'
  }
}

function invalidRequest(): never {
  throw new BrowserIpcError('Invalid browser request')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function boundedString(
  value: unknown,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {}
): string {
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && !value) ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    return invalidRequest()
  }
  return value
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalidRequest()
  return value as number
}

function optionalRevision(value: unknown): number | undefined {
  return value === undefined ? undefined : revision(value)
}

function optionalRequireActive(value: unknown): true | undefined {
  if (value === undefined) return undefined
  if (value !== true) return invalidRequest()
  return true
}

function coordinate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) {
    return invalidRequest()
  }
  return value
}

function screenshotCoordinate(value: unknown): number {
  const result = coordinate(value)
  if (result < 0) return invalidRequest()
  return result
}

function scrollDelta(value: unknown): number {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > BROWSER_MAX_SCROLL_DELTA) {
    return invalidRequest()
  }
  return value as number
}

function requiredActive(value: unknown): true {
  if (value !== true) return invalidRequest()
  return true
}

function consequence(value: unknown): 'read' | 'write' | 'irreversible' {
  if (value !== 'read' && value !== 'write' && value !== 'irreversible') {
    return invalidRequest()
  }
  return value
}

export function parseBrowserCommand(input: unknown): BrowserCommand {
  try {
    if (!isRecord(input) || typeof input.type !== 'string') return invalidRequest()
    const requestId = boundedString(input.requestId, MAX_ID_BYTES)
    switch (input.type) {
      case 'open':
        return {
          type: 'open',
          requestId,
          url: boundedString(input.url, MAX_URL_BYTES)
        }
      case 'openExternal':
        return {
          type: 'openExternal',
          requestId,
          tabId: boundedString(input.tabId, MAX_ID_BYTES),
          expectedDocumentRevision: revision(input.expectedDocumentRevision)
        }
      case 'newTab':
        return {
          type: 'newTab',
          requestId,
          ...(input.url === undefined ? {} : { url: boundedString(input.url, MAX_URL_BYTES) })
        }
      case 'activate':
      case 'close':
      case 'restore':
        return {
          type: input.type,
          requestId,
          tabId: boundedString(input.tabId, MAX_ID_BYTES)
        }
      case 'navigate': {
        const expectedDocumentRevision = optionalRevision(input.expectedDocumentRevision)
        const requireActive = optionalRequireActive(input.requireActive)
        return {
          type: 'navigate',
          requestId,
          tabId: boundedString(input.tabId, MAX_ID_BYTES),
          url: boundedString(input.url, MAX_URL_BYTES),
          ...(expectedDocumentRevision === undefined ? {} : { expectedDocumentRevision }),
          ...(requireActive ? { requireActive } : {})
        }
      }
      case 'snapshot': {
        const expectedDocumentRevision = optionalRevision(input.expectedDocumentRevision)
        const requireActive = optionalRequireActive(input.requireActive)
        return {
          type: 'snapshot',
          requestId,
          tabId: boundedString(input.tabId, MAX_ID_BYTES),
          ...(expectedDocumentRevision === undefined ? {} : { expectedDocumentRevision }),
          ...(requireActive ? { requireActive } : {})
        }
      }
      case 'history':
        if (input.direction !== 'back' && input.direction !== 'forward') return invalidRequest()
        return {
          type: 'history',
          requestId,
          tabId: boundedString(input.tabId, MAX_ID_BYTES),
          direction: input.direction
        }
      case 'reload':
      case 'stop':
        return {
          type: input.type,
          requestId,
          tabId: boundedString(input.tabId, MAX_ID_BYTES)
        }
      case 'click':
        return {
          type: 'click',
          requestId,
          tabId: boundedString(input.tabId, MAX_ID_BYTES),
          x: screenshotCoordinate(input.x),
          y: screenshotCoordinate(input.y),
          expectedDocumentRevision: revision(input.expectedDocumentRevision),
          consequence: consequence(input.consequence),
          requireActive: requiredActive(input.requireActive)
        }
      case 'typeText':
        if (
          !exactKeys(input, [
            'type',
            'requestId',
            'tabId',
            'text',
            'expectedDocumentRevision',
            'consequence',
            'requireActive'
          ])
        ) {
          return invalidRequest()
        }
        if (input.consequence !== 'write' && input.consequence !== 'irreversible') {
          return invalidRequest()
        }
        return {
          type: 'typeText',
          requestId,
          tabId: boundedString(input.tabId, MAX_ID_BYTES),
          text: boundedString(input.text, BROWSER_MAX_TEXT_BYTES),
          expectedDocumentRevision: revision(input.expectedDocumentRevision),
          consequence: input.consequence,
          requireActive: requiredActive(input.requireActive)
        }
      case 'keypress':
        if (typeof input.key !== 'string' || !SAFE_BROWSER_KEYS.has(input.key)) {
          return invalidRequest()
        }
        if (
          input.modifiers !== undefined &&
          (!Array.isArray(input.modifiers) ||
            input.modifiers.length > 1 ||
            (input.modifiers.length === 1 &&
              !BROWSER_SAFE_MODIFIERS.includes(input.modifiers[0] as 'shift')))
        ) {
          return invalidRequest()
        }
        return {
          type: 'keypress',
          requestId,
          tabId: boundedString(input.tabId, MAX_ID_BYTES),
          key: boundedString(input.key, MAX_KEY_BYTES),
          expectedDocumentRevision: revision(input.expectedDocumentRevision),
          ...(input.modifiers === undefined ? {} : { modifiers: [...input.modifiers] }),
          requireActive: requiredActive(input.requireActive)
        }
      case 'scroll': {
        const deltaX = scrollDelta(input.deltaX)
        const deltaY = scrollDelta(input.deltaY)
        if (deltaX === 0 && deltaY === 0) return invalidRequest()
        return {
          type: 'scroll',
          requestId,
          tabId: boundedString(input.tabId, MAX_ID_BYTES),
          deltaX,
          deltaY,
          expectedDocumentRevision: revision(input.expectedDocumentRevision),
          requireActive: requiredActive(input.requireActive)
        }
      }
      default:
        return invalidRequest()
    }
  } catch (error) {
    if (error instanceof BrowserIpcError) throw error
    return invalidRequest()
  }
}

function parseViewport(input: unknown): {
  sessionId: string
  sessionGeneration: number
  tabId: string
  viewport: BrowserViewport | null
} {
  try {
    if (
      !isRecord(input) ||
      !exactKeys(input, ['sessionId', 'sessionGeneration', 'tabId', 'viewport'])
    ) {
      return invalidRequest()
    }
    const sessionId = boundedString(input.sessionId, MAX_ID_BYTES)
    const sessionGeneration = revision(input.sessionGeneration)
    const tabId = boundedString(input.tabId, MAX_ID_BYTES)
    if (input.viewport === null) return { sessionId, sessionGeneration, tabId, viewport: null }
    if (!isRecord(input.viewport)) return invalidRequest()
    if (!exactKeys(input.viewport, ['x', 'y', 'width', 'height'])) return invalidRequest()
    const width = coordinate(input.viewport.width)
    const height = coordinate(input.viewport.height)
    if (width <= 0 || height <= 0) return invalidRequest()
    return {
      sessionId,
      sessionGeneration,
      tabId,
      viewport: {
        x: coordinate(input.viewport.x),
        y: coordinate(input.viewport.y),
        width,
        height
      }
    }
  } catch (error) {
    if (error instanceof BrowserIpcError) throw error
    return invalidRequest()
  }
}

function safeSession(session: BrowserIpcSession | undefined): BrowserIpcSession {
  if (
    !session ||
    !session.sessionId ||
    Buffer.byteLength(session.sessionId, 'utf8') > MAX_ID_BYTES
  ) {
    throw new BrowserIpcError('Browser session is unavailable')
  }
  return session
}

export class BrowserIpcCoordinator {
  readonly #getRegistry: BrowserIpcCoordinatorOptions['getRegistry']
  readonly #getTrustedRenderer: BrowserIpcCoordinatorOptions['getTrustedRenderer']
  readonly #resolveHumanSession: BrowserIpcCoordinatorOptions['resolveHumanSession']
  readonly #resolveAgentSession: BrowserIpcCoordinatorOptions['resolveAgentSession']
  readonly #subscribedWorkspaces = new WeakSet<BrowserWorkspaceLike>()
  #nextAppShellRequestId = 0

  constructor(options: BrowserIpcCoordinatorOptions) {
    this.#getRegistry = options.getRegistry
    this.#getTrustedRenderer = options.getTrustedRenderer
    this.#resolveHumanSession = options.resolveHumanSession
    this.#resolveAgentSession = options.resolveAgentSession
  }

  async executeHuman(sender: BrowserRendererSenderLike, input: unknown): Promise<BrowserOutcome> {
    return this.#safe(async () => {
      this.#assertTrustedRenderer(sender)
      const command = parseBrowserCommand(input)
      const session = safeSession(this.#resolveHumanSession())
      const workspace = await this.#workspace(session)
      return workspace.execute({ kind: 'human' }, command)
    })
  }

  async snapshotHuman(sender: BrowserRendererSenderLike): Promise<BrowserWorkspaceSnapshot> {
    return this.#safe(async () => {
      this.#assertTrustedRenderer(sender)
      const session = safeSession(this.#resolveHumanSession())
      return (await this.#workspace(session)).snapshot()
    })
  }

  async setViewportHuman(sender: BrowserRendererSenderLike, input: unknown): Promise<void> {
    return this.#safe(async () => {
      this.#assertTrustedRenderer(sender)
      const parsed = parseViewport(input)
      const session = safeSession(this.#resolveHumanSession())
      if (
        parsed.sessionId !== session.sessionId ||
        parsed.sessionGeneration !== session.sessionGeneration
      ) {
        throw new BrowserIpcError('Browser session is unavailable')
      }
      const workspace = await this.#workspace(session)
      await workspace.setViewport(parsed.tabId, parsed.viewport)
    })
  }

  async executeAgent(input: unknown, signal?: AbortSignal): Promise<BrowserOutcome> {
    return this.#safe(async () => {
      if (!isRecord(input)) return invalidRequest()
      const originSessionId = boundedString(input.originSessionId, MAX_ORIGIN_ID_BYTES)
      const runId = boundedString(input.runId, MAX_ID_BYTES)
      const toolCallId = boundedString(input.toolCallId, MAX_ID_BYTES)
      const command = parseBrowserCommand(input.command)
      const session = safeSession(this.#resolveAgentSession(originSessionId))
      const workspace = await this.#workspace(session)
      return workspace.execute(
        { kind: 'agent', sessionId: session.sessionId, runId, toolCallId },
        command,
        signal
      )
    })
  }

  async openAppShellUrl(input: unknown): Promise<BrowserOutcome> {
    return this.#safe(async () => {
      const url = boundedString(input, MAX_URL_BYTES)
      const session = safeSession(this.#resolveHumanSession())
      const workspace = await this.#workspace(session)
      const outcome = await workspace.execute(
        { kind: 'human' },
        {
          type: 'open',
          requestId: `app-shell-${++this.#nextAppShellRequestId}`,
          url
        }
      )
      if (
        outcome.ok &&
        !this.#sendEvent(session.sessionId, {
          type: 'panelRequested',
          reason: 'appShellOpen',
          revision: outcome.snapshot.revision
        })
      ) {
        return {
          ok: false,
          error: {
            code: 'ENGINE_UNAVAILABLE',
            message: 'The in-app browser panel is unavailable',
            retryable: true
          },
          snapshot: outcome.snapshot
        }
      }
      return outcome
    })
  }

  notifyAppShellOpenFailed(): void {
    this.#sendEnvelope({
      sessionId: null,
      event: { type: 'appShellOpenFailed', reason: 'browserUnavailable' }
    })
  }

  async disposeSession(sessionId: string): Promise<void> {
    return this.#safe(async () => {
      const safeSessionId = boundedString(sessionId, MAX_ID_BYTES)
      await this.#getRegistry().disposeSession(safeSessionId)
    })
  }

  async #workspace(session: BrowserIpcSession): Promise<BrowserWorkspaceLike> {
    const workspace = await this.#getRegistry().getOrCreate({
      sessionId: session.sessionId,
      owner: session.owner
    })
    if (!this.#subscribedWorkspaces.has(workspace)) {
      this.#subscribedWorkspaces.add(workspace)
      workspace.subscribe((event) => this.#sendEvent(session.sessionId, event))
    }
    return workspace
  }

  #sendEvent(sessionId: string, event: BrowserWorkspaceEvent): boolean {
    return this.#sendEnvelope({ sessionId, event })
  }

  #sendEnvelope(envelope: BrowserRendererEventEnvelope): boolean {
    try {
      const renderer = this.#getTrustedRenderer()
      if (!renderer || renderer.isDestroyed()) return false
      renderer.send('browser:event', envelope)
      return true
    } catch {
      return false
    }
  }

  #assertTrustedRenderer(sender: BrowserRendererSenderLike): void {
    const trusted = this.#getTrustedRenderer()
    if (!trusted || sender !== trusted || sender.isDestroyed()) {
      throw new BrowserIpcError('Browser renderer is not authorized')
    }
  }

  async #safe<T>(run: () => T | Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof BrowserIpcError) throw error
      throw new BrowserIpcError('Browser request failed')
    }
  }
}

function safeAppShellHttpUrl(
  input: string,
  policyContext: BrowserPolicyContext = {}
): string | null {
  if (!input.trim() || Buffer.byteLength(input, 'utf8') > MAX_URL_BYTES) return null
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    return null
  }
  const canonicalOrigin = (value: URL): string => {
    const hostname = value.hostname.endsWith('.') ? value.hostname.slice(0, -1) : value.hostname
    return `${value.protocol}//${hostname}${value.port ? `:${value.port}` : ''}`
  }
  for (const applicationOrigin of policyContext.applicationOrigins ?? []) {
    try {
      if (canonicalOrigin(new URL(applicationOrigin)) === canonicalOrigin(url)) return null
    } catch {
      continue
    }
  }
  return url.toString()
}

export function routeBrowserAppShellWindowOpen(options: BrowserAppShellWindowOpenOptions): {
  action: 'deny'
} {
  if (options.details.postBody != null) return { action: 'deny' }
  const url = safeAppShellHttpUrl(options.details.url, options.policyContext)
  if (!url) return { action: 'deny' }
  const run = Promise.resolve().then(() =>
    options.details.disposition === 'background-tab'
      ? options.openExternal(url)
      : options.coordinator
          .openAppShellUrl(url)
          .then((outcome) => {
            if (!outcome.ok) options.coordinator.notifyAppShellOpenFailed()
          })
          .catch(() => options.coordinator.notifyAppShellOpenFailed())
  )
  void run.catch(() => options.coordinator.notifyAppShellOpenFailed())
  return { action: 'deny' }
}

export function registerBrowserRendererIpc(
  ipcMain: BrowserIpcMainLike,
  coordinator: BrowserIpcCoordinator
): void {
  ipcMain.handle('browser:execute', (event, input) => coordinator.executeHuman(event.sender, input))
  ipcMain.handle('browser:snapshot', (event) => coordinator.snapshotHuman(event.sender))
  ipcMain.handle('browser:setViewport', (event, input) =>
    coordinator.setViewportHuman(event.sender, input)
  )
}
