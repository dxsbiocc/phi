import type {
  McpConnectorSetupPhase,
  McpConnectorSetupProgress
} from '../../../shared/mcpConnectorCatalog'
import { randomUUID } from 'node:crypto'
import { loadConnectorSetups, saveConnectorSetups } from './connector-setup-store'

import { errorMessage } from '../../../shared/errorCodes'
export type ConnectorSetupReporter = (
  phase: Exclude<McpConnectorSetupPhase, 'failed'>,
  details?: {
    toolNames?: string[]
    kind?: 'local-stdio'
    title?: string
    startedAt?: string
    summary?: string
  }
) => void

export class ConnectorSetupBusyError extends Error {
  constructor(readonly id: string) {
    super(`Connector ${id} setup is in progress. Try again later.`)
    this.name = 'ConnectorSetupBusyError'
  }
}

/** App-owned in-memory progress remains available when a connector dialog is reopened. */
export class ConnectorSetupTracker {
  private readonly snapshots = new Map<string, McpConnectorSetupProgress>()
  private readonly active = new Map<string, object>()

  constructor(
    private readonly publish: (progress: McpConnectorSetupProgress) => void,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly storage?: { path: string }
  ) {
    if (storage) {
      for (const progress of loadConnectorSetups(storage.path, now))
        this.snapshots.set(progress.id, progress)
      if (this.snapshots.size) saveConnectorSetups(storage.path, [...this.snapshots.values()])
    }
  }

  get(id: string): McpConnectorSetupProgress | undefined {
    const snapshot = this.snapshots.get(id)
    return snapshot ? copyProgress(snapshot) : undefined
  }

  list(): McpConnectorSetupProgress[] {
    return [...this.snapshots.values()].map(copyProgress)
  }

  isActive(id: string): boolean {
    return this.active.has(id)
  }

  async run<T>(
    id: string,
    task: (report: ConnectorSetupReporter) => T | Promise<T>,
    finalPhase: 'ready' | 'installed' | 'removed' = 'ready'
  ): Promise<T> {
    if (this.active.has(id)) throw new ConnectorSetupBusyError(id)
    const token = {}
    const operationId = this.storage ? randomUUID() : undefined
    this.active.set(id, token)
    let phase: Exclude<McpConnectorSetupPhase, 'failed'> | undefined
    let toolNames: string[] | undefined
    const metadata: Pick<McpConnectorSetupProgress, 'kind' | 'title' | 'startedAt' | 'summary'> = {}
    const report: ConnectorSetupReporter = (nextPhase, details) => {
      // An asynchronous producer from an ended attempt must not replace a retry's snapshot.
      if (this.active.get(id) !== token) return
      phase = nextPhase
      if (details?.toolNames !== undefined) toolNames = [...details.toolNames]
      if (details?.kind !== undefined) metadata.kind = details.kind
      if (details?.title !== undefined) metadata.title = details.title
      if (details?.startedAt !== undefined) metadata.startedAt = details.startedAt
      if (details?.summary !== undefined) metadata.summary = details.summary
      this.update({
        id,
        phase,
        ...metadata,
        ...(operationId ? { operationId } : {}),
        ...(toolNames ? { toolNames } : {})
      })
    }
    try {
      const result = await task(report)
      if (phase !== finalPhase) report(finalPhase)
      return result
    } catch (error) {
      const detail = errorDetail(error)
      const failure = errorFailureMetadata(error)
      this.update({
        id,
        phase: 'failed',
        ...metadata,
        ...(operationId ? { operationId } : {}),
        ...(phase ? { failedPhase: phase } : {}),
        error: errorMessage(error),
        ...(detail ? { detail } : {}),
        ...failure
      })
      throw error
    } finally {
      this.active.delete(id)
    }
  }

  private update(progress: Omit<McpConnectorSetupProgress, 'revision' | 'updatedAt'>): void {
    const snapshot = {
      ...progress,
      revision: (this.snapshots.get(progress.id)?.revision ?? 0) + 1,
      updatedAt: this.now()
    }
    this.snapshots.set(progress.id, snapshot)
    if (this.storage) saveConnectorSetups(this.storage.path, [...this.snapshots.values()])
    try {
      this.publish(copyProgress(snapshot))
    } catch {
      // A closed window or failed observer cannot interrupt installation or erase its state.
    }
  }
}

function errorDetail(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return undefined
  const detail = (error as { detail?: unknown }).detail
  return typeof detail === 'string' && detail ? detail.slice(0, 4096) : undefined
}

function errorFailureMetadata(
  error: unknown
): Pick<McpConnectorSetupProgress, 'failureKind' | 'failureReason' | 'setupHint'> {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return {}
  const metadata = error as {
    failureKind?: unknown
    failureReason?: unknown
    setupHint?: unknown
  }
  const failureKind =
    metadata.failureKind === 'needs-setup' || metadata.failureKind === 'generic'
      ? metadata.failureKind
      : undefined
  const failureReason =
    typeof metadata.failureReason === 'string' && metadata.failureReason
      ? metadata.failureReason.slice(0, 200)
      : undefined
  const setupHint = copySetupHint(metadata.setupHint)
  return {
    ...(failureKind ? { failureKind } : {}),
    ...(failureReason ? { failureReason } : {}),
    ...(setupHint ? { setupHint } : {})
  }
}

function copySetupHint(value: unknown): McpConnectorSetupProgress['setupHint'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const hint = value as { readmeUrl?: unknown; commands?: unknown }
  const readmeUrl =
    typeof hint.readmeUrl === 'string' && hint.readmeUrl ? hint.readmeUrl.slice(0, 500) : undefined
  const commands = Array.isArray(hint.commands)
    ? hint.commands
        .filter((command): command is string => typeof command === 'string' && Boolean(command))
        .slice(0, 3)
        .map((command) => command.slice(0, 200))
    : undefined
  if (!readmeUrl && commands === undefined) return undefined
  return { ...(readmeUrl ? { readmeUrl } : {}), ...(commands ? { commands } : {}) }
}

function copyProgress(progress: McpConnectorSetupProgress): McpConnectorSetupProgress {
  return {
    ...progress,
    ...(progress.toolNames ? { toolNames: [...progress.toolNames] } : {}),
    ...(progress.setupHint
      ? {
          setupHint: {
            ...progress.setupHint,
            ...(progress.setupHint.commands ? { commands: [...progress.setupHint.commands] } : {})
          }
        }
      : {})
  }
}
