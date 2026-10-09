import type {
  McpConnectorSetupPhase,
  McpConnectorSetupProgress
} from '../../../shared/mcpConnectorCatalog'
import { randomUUID } from 'node:crypto'
import { loadConnectorSetups, saveConnectorSetups } from './connector-setup-store'

export type ConnectorSetupReporter = (
  phase: Exclude<McpConnectorSetupPhase, 'failed'>,
  details?: { toolNames?: string[] }
) => void

export class ConnectorSetupBusyError extends Error {
  constructor(readonly id: string) {
    super(`连接器 ${id} 的设置正在进行中，请稍候再试`)
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
    const report: ConnectorSetupReporter = (nextPhase, details) => {
      // An asynchronous producer from an ended attempt must not replace a retry's snapshot.
      if (this.active.get(id) !== token) return
      phase = nextPhase
      if (details?.toolNames !== undefined) toolNames = [...details.toolNames]
      this.update({
        id,
        phase,
        ...(operationId ? { operationId } : {}),
        ...(toolNames ? { toolNames } : {})
      })
    }
    try {
      const result = await task(report)
      if (phase !== finalPhase) report(finalPhase)
      return result
    } catch (error) {
      this.update({
        id,
        phase: 'failed',
        ...(operationId ? { operationId } : {}),
        ...(phase ? { failedPhase: phase } : {}),
        error: error instanceof Error ? error.message : String(error)
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

function copyProgress(progress: McpConnectorSetupProgress): McpConnectorSetupProgress {
  return { ...progress, ...(progress.toolNames ? { toolNames: [...progress.toolNames] } : {}) }
}
