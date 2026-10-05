import type {
  OfficePreviewOwnership,
  OfficeProcessOwnership,
  OwnedOfficeDocument
} from './office-service-state'

export interface OfficeResidentHealthState {
  readonly residentAlive: boolean
  readonly watchAlive: boolean
}

interface OfficeResidentHealthDependencies {
  readonly isAlive?: (pid: number) => boolean
  readonly recover?: (
    owned: OwnedOfficeDocument,
    state: OfficeResidentHealthState,
    signal: AbortSignal
  ) => Promise<OfficeProcessOwnership & OfficePreviewOwnership>
}

export class OfficeResidentHealth {
  private readonly inFlight = new Map<
    string,
    Promise<(OfficeProcessOwnership & OfficePreviewOwnership) | undefined>
  >()

  constructor(private readonly dependencies: OfficeResidentHealthDependencies) {}

  async ensure(owned: OwnedOfficeDocument, signal: AbortSignal): Promise<void> {
    const recover = this.dependencies.recover
    const isAlive = this.dependencies.isAlive
    if (!recover || !isAlive) return
    if (signal.aborted) throw abortError()
    const state = {
      residentAlive: isAlive(owned.document.residentPid),
      watchAlive: isAlive(owned.document.watchPid)
    }
    if (state.residentAlive && state.watchAlive) return
    const artifactId = owned.document.artifactId
    const existing = this.inFlight.get(artifactId)
    const running = existing ?? recover(owned, state, signal)
    if (!existing) this.inFlight.set(artifactId, running)
    try {
      const recovered = await running
      if (recovered) owned.document = { ...owned.document, ...recovered }
      if (signal.aborted) throw abortError()
    } finally {
      if (this.inFlight.get(artifactId) === running) this.inFlight.delete(artifactId)
    }
  }
}

function abortError(): Error {
  return Object.assign(new Error('Office 健康检查已取消'), { code: 'operation_cancelled' })
}
