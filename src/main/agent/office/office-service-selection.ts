import type { OfficeSelectionSummary } from '../../../shared/officeProtocol'
import { officeArtifactKind } from './office-document-kind'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'
import type { OfficePreviewPreferences } from './office-watch'

export interface OfficeServiceSelectionEvent {
  artifactId: string
  sessionId: string
  selection: OfficeSelectionSummary | null
}

interface OfficeServiceSelectionState {
  readonly dependencies: Pick<OfficeServiceDependencies, 'clearSelection' | 'setPreviewPreferences'>
  readonly owned: ReadonlyMap<string, OwnedOfficeDocument>
  readonly closingArtifacts: ReadonlySet<string>
}

export class OfficeServiceSelectionFacade {
  private readonly listeners = new Set<(event: OfficeServiceSelectionEvent) => void>()

  constructor(private readonly state: OfficeServiceSelectionState) {}

  on(listener: (event: OfficeServiceSelectionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(artifactId: string, selection: OfficeSelectionSummary | null): void {
    const owned = this.state.owned.get(artifactId)
    if (!owned || this.state.closingArtifacts.has(artifactId)) return
    const snapshot = selection
      ? Object.freeze({ ...selection, paths: Object.freeze([...selection.paths]) })
      : null
    const event = Object.freeze({
      artifactId,
      sessionId: owned.document.sessionId,
      selection: snapshot
    })
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Renderer notifications must never interrupt Office lifecycle cleanup.
      }
    }
  }

  async clear(artifactId: string, sessionId: string): Promise<boolean> {
    const owned = this.state.owned.get(artifactId)
    if (
      !owned ||
      owned.document.sessionId !== sessionId ||
      this.state.closingArtifacts.has(artifactId)
    ) {
      return false
    }
    if (officeArtifactKind(owned.document as unknown as Record<string, unknown>) !== 'xlsx') {
      this.publish(artifactId, null)
      return true
    }
    await this.state.dependencies.clearSelection(owned.document.watchPort).catch(() => undefined)
    this.publish(artifactId, null)
    return true
  }

  setPreviewPreferences(
    artifactId: string,
    sessionId: string,
    preferences: OfficePreviewPreferences
  ): boolean {
    const owned = this.state.owned.get(artifactId)
    if (
      !owned ||
      owned.document.sessionId !== sessionId ||
      this.state.closingArtifacts.has(artifactId) ||
      officeArtifactKind(owned.document as unknown as Record<string, unknown>) !== 'xlsx'
    ) {
      return false
    }
    return this.state.dependencies.setPreviewPreferences?.(artifactId, preferences) ?? false
  }

  dispose(): void {
    this.listeners.clear()
  }
}
