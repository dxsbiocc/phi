import { createHash } from 'node:crypto'
import { isAbsolute, normalize, parse, posix } from 'node:path'
import type { ProjectLocation } from '../../shared/projectLocation'
import type { BrowserPolicyContext } from './browser-policy'
import type { BrowserCheckpointStore } from './browser-checkpoints'
import type { BrowserEngine } from './browser-engine'
import { BrowserWorkspace, BrowserWorkspaceDisposalError } from './browser-workspace'
import type { BrowserActionApprovalRequester } from './browser-approval'

export type BrowserWorkspaceOwner =
  { kind: 'ordinary' } | { kind: 'project'; location: ProjectLocation }

export interface BrowserWorkspaceRegistration {
  sessionId: string
  owner: BrowserWorkspaceOwner
}

export interface BrowserEngineFactoryInput {
  sessionId: string
  partition: string
}

export interface BrowserWorkspaceRegistryOptions {
  engineFactory: (input: BrowserEngineFactoryInput) => BrowserEngine | Promise<BrowserEngine>
  policyContext?: BrowserPolicyContext
  checkpointStore?: BrowserCheckpointStore
  openExternal?: (url: string) => Promise<void>
  approveAgentAction?: BrowserActionApprovalRequester
}

export class BrowserWorkspaceRegistryCleanupError extends Error {
  readonly failures: { engine: boolean; checkpoint: boolean }

  constructor(error: unknown) {
    super('Browser workspace cleanup failed')
    this.name = 'BrowserWorkspaceRegistryCleanupError'
    this.failures =
      error instanceof BrowserWorkspaceDisposalError
        ? { ...error.failures }
        : { engine: true, checkpoint: false }
  }
}

export class BrowserWorkspaceRegistryPresentationError extends Error {
  constructor() {
    super('Browser presentation transition failed')
    this.name = 'BrowserWorkspaceRegistryPresentationError'
  }
}

interface RegistryEntry {
  sessionId: string
  ownerIdentity: string
  partition: string
  workspacePromise: Promise<BrowserWorkspace> | null
  engine?: BrowserEngine
  workspace?: BrowserWorkspace
  disposalRequested: boolean
  cleanupPromise?: Promise<void>
}

function requiredIdentityPart(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`)
  if (/[\r\n]/.test(value) || value.includes(String.fromCharCode(0))) {
    throw new Error(`${label} contains invalid control characters`)
  }
  return value
}

function normalizedLocalPath(value: string): string {
  const result = normalize(value)
  const root = parse(result).root
  return result === root ? result : result.replace(/[\\/]+$/, '')
}

function normalizedSshRoot(value: string): string {
  const result = posix.normalize(value)
  return result === '/' ? result : result.replace(/\/+$/, '')
}

/** ProjectLocation.realPath is already symlink-resolved by the project registry. */
function projectIdentity(location: ProjectLocation): string {
  if (location.kind === 'local') {
    const realPath = requiredIdentityPart(location.realPath, 'realPath')
    if (!isAbsolute(realPath)) throw new Error('realPath must be absolute')
    return JSON.stringify(['project', 'local', normalizedLocalPath(realPath)])
  }
  const hostProfileId = requiredIdentityPart(location.hostProfileId, 'hostProfileId')
  const canonicalRoot = requiredIdentityPart(location.canonicalRoot, 'canonicalRoot')
  if (!posix.isAbsolute(canonicalRoot)) throw new Error('canonicalRoot must be absolute')
  return JSON.stringify(['project', 'ssh', hostProfileId, normalizedSshRoot(canonicalRoot)])
}

function ownerIdentity(owner: BrowserWorkspaceOwner): string {
  return owner.kind === 'ordinary' ? JSON.stringify(['ordinary']) : projectIdentity(owner.location)
}

function partitionIdentity(sessionId: string, owner: BrowserWorkspaceOwner): string {
  if (owner.kind === 'ordinary') return JSON.stringify(['ordinary-session', sessionId])
  return ownerIdentity(owner)
}

function opaquePartition(identity: string): string {
  const digest = createHash('sha256').update(identity).digest('hex')
  return `phi-browser-${digest}`
}

export class BrowserWorkspaceRegistry {
  readonly #engineFactory: BrowserWorkspaceRegistryOptions['engineFactory']
  readonly #policyContext: BrowserPolicyContext
  readonly #checkpointStore?: BrowserCheckpointStore
  readonly #openExternal?: (url: string) => Promise<void>
  readonly #approveAgentAction?: BrowserActionApprovalRequester
  readonly #entries = new Map<string, RegistryEntry>()
  #activeSessionId: string | null = null
  #presentationTicket = 0
  #presentationTail: Promise<void> = Promise.resolve()
  #disposed = false
  #disposeAllPromise: Promise<void> | null = null

  constructor(options: BrowserWorkspaceRegistryOptions) {
    this.#engineFactory = options.engineFactory
    this.#policyContext = options.policyContext?.applicationOrigins
      ? { applicationOrigins: [...options.policyContext.applicationOrigins] }
      : {}
    this.#checkpointStore = options.checkpointStore
    this.#openExternal = options.openExternal
    this.#approveAgentAction = options.approveAgentAction
  }

  async getOrCreate(registration: BrowserWorkspaceRegistration): Promise<BrowserWorkspace> {
    if (this.#disposed) throw new Error('Browser workspace registry is disposed')
    const sessionId = requiredIdentityPart(registration.sessionId, 'sessionId')
    const identity = ownerIdentity(registration.owner)
    const existing = this.#entries.get(sessionId)
    if (existing) {
      if (existing.ownerIdentity !== identity) {
        throw new Error(`Session ${sessionId} has a conflicting browser owner identity`)
      }
      if (existing.disposalRequested) {
        throw new Error(`Browser workspace for session ${sessionId} is being disposed`)
      }
      if (!existing.workspacePromise) throw new Error('Browser workspace creation did not start')
      return existing.workspacePromise
    }

    const entry: RegistryEntry = {
      sessionId,
      ownerIdentity: identity,
      partition: opaquePartition(partitionIdentity(sessionId, registration.owner)),
      workspacePromise: null,
      disposalRequested: false
    }
    this.#entries.set(sessionId, entry)
    entry.workspacePromise = this.#createWorkspace(entry)
    return entry.workspacePromise
  }

  get(sessionId: string): BrowserWorkspace | undefined {
    const entry = this.#entries.get(sessionId)
    return entry && !entry.disposalRequested ? entry.workspace : undefined
  }

  setActiveSession(sessionId: string | null): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    if (this.#activeSessionId === sessionId) return this.#presentationTail
    this.#activeSessionId = sessionId
    const ticket = ++this.#presentationTicket
    const run = this.#presentationTail.then(async () => {
      if (ticket !== this.#presentationTicket || this.#disposed) return
      const inactive = [...this.#entries.values()].filter(
        (entry) =>
          entry.sessionId !== sessionId && Boolean(entry.workspace) && !entry.disposalRequested
      )
      const hidden = await Promise.allSettled(
        inactive.map((entry) => entry.workspace?.suspendPresentation() ?? Promise.resolve())
      )
      if (hidden.some((result) => result.status === 'rejected')) {
        try {
          await this.disposeAll()
        } catch {
          // The registry remains permanently disposed even when cleanup has debt.
        }
        throw new BrowserWorkspaceRegistryPresentationError()
      }
      if (ticket !== this.#presentationTicket || this.#disposed) return
      const active = sessionId ? this.#entries.get(sessionId) : undefined
      if (!active?.workspace || active.disposalRequested) return
      try {
        await active.workspace.resumePresentation()
      } catch {
        try {
          await this.disposeAll()
        } catch {
          // The registry remains permanently disposed even when cleanup has debt.
        }
        throw new BrowserWorkspaceRegistryPresentationError()
      }
    })
    this.#presentationTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  disposeSession(sessionId: string): Promise<void> {
    const entry = this.#entries.get(sessionId)
    return entry ? this.#ensureCleanup(entry, true) : Promise.resolve()
  }

  async disposeRun(sessionId: string, runId: string): Promise<void> {
    const entry = this.#entries.get(sessionId)
    if (!entry || entry.disposalRequested) return
    const workspace =
      entry.workspace ?? (entry.workspacePromise ? await entry.workspacePromise : null)
    await workspace?.disposeRun(runId)
  }

  disposeAll(): Promise<void> {
    if (this.#disposeAllPromise) return this.#disposeAllPromise
    this.#disposed = true
    const entries = [...this.#entries.values()]
    this.#disposeAllPromise = (async () => {
      const results = await Promise.allSettled(
        entries.map((entry) => this.#ensureCleanup(entry, true))
      )
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Failed to dispose ${failures.length} browser workspace${failures.length === 1 ? '' : 's'}`
        )
      }
    })()
    return this.#disposeAllPromise
  }

  async #createWorkspace(entry: RegistryEntry): Promise<BrowserWorkspace> {
    try {
      const engine = await this.#engineFactory({
        sessionId: entry.sessionId,
        partition: entry.partition
      })
      entry.engine = engine
      if (
        this.#disposed ||
        entry.disposalRequested ||
        this.#entries.get(entry.sessionId) !== entry
      ) {
        throw new Error(
          `Browser workspace for session ${entry.sessionId} was disposed during creation`
        )
      }

      const workspace = new BrowserWorkspace({
        sessionId: entry.sessionId,
        partition: entry.partition,
        engine,
        policyContext: this.#policyContext,
        checkpointStore: this.#checkpointStore,
        ...(this.#openExternal ? { openExternal: this.#openExternal } : {}),
        ...(this.#approveAgentAction ? { approveAgentAction: this.#approveAgentAction } : {})
      })
      entry.workspace = workspace
      if (entry.sessionId === this.#activeSessionId) await workspace.resumePresentation()
      else await workspace.suspendPresentation()
      return workspace
    } catch (error) {
      if (!entry.disposalRequested) {
        entry.disposalRequested = true
        await this.#ensureCleanup(entry, false)
      }
      throw error
    }
  }

  #ensureCleanup(entry: RegistryEntry, waitForCreation: boolean): Promise<void> {
    if (entry.cleanupPromise) return entry.cleanupPromise
    entry.disposalRequested = true
    entry.cleanupPromise = (async () => {
      try {
        if (waitForCreation && entry.workspacePromise) {
          try {
            await entry.workspacePromise
          } catch {
            // Creation errors belong to getOrCreate; cleanup still owns any produced engine.
          }
        }
        if (entry.workspace) await entry.workspace.dispose()
        else if (entry.engine) await entry.engine.dispose()
        if (this.#entries.get(entry.sessionId) === entry) this.#entries.delete(entry.sessionId)
      } catch (error) {
        throw new BrowserWorkspaceRegistryCleanupError(error)
      }
    })()
    return entry.cleanupPromise
  }
}
