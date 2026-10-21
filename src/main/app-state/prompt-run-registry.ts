export interface PhiSessionTable<T> {
  get(phiSessionId: string): T | undefined
  set(phiSessionId: string, value: T): void
  has(phiSessionId: string): boolean
  delete(phiSessionId: string): boolean
}

export interface PhiSessionValuesTable<T> extends PhiSessionTable<T> {
  values(): IterableIterator<T>
}

export interface PhiSessionSetTable {
  has(phiSessionId: string): boolean
  add(phiSessionId: string): void
  delete(phiSessionId: string): boolean
}

function createPhiSessionTable<T>(values: Map<string, T>): PhiSessionTable<T> {
  return {
    get: (phiSessionId) => values.get(phiSessionId),
    set: (phiSessionId, value) => {
      values.set(phiSessionId, value)
    },
    has: (phiSessionId) => values.has(phiSessionId),
    delete: (phiSessionId) => values.delete(phiSessionId)
  }
}

function createPhiSessionValuesTable<T>(values: Map<string, T>): PhiSessionValuesTable<T> {
  return {
    ...createPhiSessionTable(values),
    values: () => values.values()
  }
}

function createPhiSessionSetTable(values: Set<string>): PhiSessionSetTable {
  return {
    has: (phiSessionId) => values.has(phiSessionId),
    add: (phiSessionId) => {
      values.add(phiSessionId)
    },
    delete: (phiSessionId) => values.delete(phiSessionId)
  }
}

interface RuntimeRecoveryOperation {
  controller: AbortController
  done: Promise<void>
}

interface ManualCompactionOperation {
  session?: RuntimeAgentSession
  cancelled: boolean
  done: Promise<void>
}

export class PromptRunRegistry<TPromptRun = unknown> {
  private readonly promptQueues = new Map<string, Promise<void>>()
  private readonly promptGenerations = new Map<string, number>()
  private readonly activePromptRuns = new Map<string, TPromptRun>()
  private readonly recoveryOperations = new Map<string, RuntimeRecoveryOperation>()
  private readonly recoveryFailures = new Map<string, RuntimeRecoveryIssue>()
  private readonly compactionIds = new Set<string>()
  private readonly compactionOperations = new Map<string, ManualCompactionOperation>()

  readonly runtimeRecoveryOperations = createPhiSessionValuesTable(this.recoveryOperations)
  readonly runtimeRecoveryFailures = createPhiSessionTable(this.recoveryFailures)
  readonly manualCompactionIds = createPhiSessionSetTable(this.compactionIds)
  readonly manualCompactionOperations = createPhiSessionTable(this.compactionOperations)

  constructor(private readonly canonicalize: (key: string) => string) {}

  queueFor(key: string): Promise<void> {
    return this.promptQueues.get(this.canonicalize(key)) ?? Promise.resolve()
  }

  setQueue(key: string, queue: Promise<void>): void {
    this.promptQueues.set(this.canonicalize(key), queue)
  }

  generationFor(key: string): number {
    return this.promptGenerations.get(this.canonicalize(key)) ?? 0
  }

  advanceGeneration(key: string): number {
    const canonicalKey = this.canonicalize(key)
    const next = this.generationFor(canonicalKey) + 1
    this.promptGenerations.set(canonicalKey, next)
    return next
  }

  activeRun(key: string): TPromptRun | undefined {
    return this.activePromptRuns.get(this.canonicalize(key))
  }

  hasActiveRun(key: string): boolean {
    return this.activePromptRuns.has(this.canonicalize(key))
  }

  setActiveRun(key: string, run: TPromptRun): void {
    this.activePromptRuns.set(this.canonicalize(key), run)
  }

  deleteActiveRunIfCurrent(key: string, run: TPromptRun): void {
    const canonicalKey = this.canonicalize(key)
    if (this.activePromptRuns.get(canonicalKey) === run) {
      this.activePromptRuns.delete(canonicalKey)
    }
  }

  findActiveRun(predicate: (run: TPromptRun) => boolean): TPromptRun | undefined {
    return [...this.activePromptRuns.values()].find(predicate)
  }

  activeRuns(): TPromptRun[] {
    return [...this.activePromptRuns.values()]
  }

  activeEntries(): Array<[string, TPromptRun]> {
    return [...this.activePromptRuns.entries()]
  }
}
import type { RuntimeRecoveryIssue } from '../../shared/runtimeRecoveryTypes'
import type { RuntimeAgentSession } from '../agent/runtime/runtime-adapter'
