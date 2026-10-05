import type { OfficeCreationFlow } from './office-service-create'
import type { OwnedOfficeDocument } from './office-service-state'
import type { OfficeTargetRegistry } from './office-targets'

interface OfficeServiceCreationFacadeState {
  readonly creation: OfficeCreationFlow
  readonly owned: Map<string, OwnedOfficeDocument>
  readonly closingArtifacts: Set<string>
  readonly targets: OfficeTargetRegistry
}

export class OfficeServiceCreationFacade {
  constructor(private readonly state: OfficeServiceCreationFacadeState) {}

  statusForCreate(
    sessionId: string,
    requestId: string
  ): ReturnType<OfficeCreationFlow['statusFor']> {
    return this.state.creation.statusFor(sessionId, requestId)
  }

  statusForImport(
    sessionId: string,
    requestId: string
  ): ReturnType<OfficeCreationFlow['importStatusFor']> {
    return this.state.creation.importStatusFor(sessionId, requestId)
  }

  create: OfficeCreationFlow['create'] = (request) => this.state.creation.create(request)

  importDocument: OfficeCreationFlow['importDocument'] = (request) =>
    this.state.creation.importDocument(request)

  cancelCreate = (requestId: string, sessionId: string): Promise<boolean> =>
    this.cancel(requestId, sessionId, 'create')

  cancelImport = (requestId: string, sessionId: string): Promise<boolean> =>
    this.cancel(requestId, sessionId, 'import')

  private async cancel(
    requestId: string,
    sessionId: string,
    kind: 'create' | 'import'
  ): Promise<boolean> {
    const status =
      kind === 'create'
        ? this.state.creation.statusFor(sessionId, requestId)
        : this.state.creation.importStatusFor(sessionId, requestId)
    const artifactId = status?.state === 'ready' ? status.document.artifactId : undefined
    const owned = artifactId ? this.state.owned.get(artifactId) : undefined
    const releasing = owned !== undefined && owned.panelReferences === 0
    if (releasing) await this.beginRelease(owned)
    try {
      return kind === 'create'
        ? await this.state.creation.cancel(requestId, sessionId)
        : await this.state.creation.cancelImport(requestId, sessionId)
    } finally {
      if (releasing && owned && !this.state.owned.has(owned.document.artifactId)) {
        this.state.closingArtifacts.delete(owned.document.artifactId)
      }
    }
  }

  private async beginRelease(owned: OwnedOfficeDocument): Promise<void> {
    this.state.closingArtifacts.add(owned.document.artifactId)
    this.state.targets.markArtifactReleased(owned.document.artifactId)
    owned.operations.cancel()
    if (!owned.operations.idle) await owned.operations.drain()
  }
}
