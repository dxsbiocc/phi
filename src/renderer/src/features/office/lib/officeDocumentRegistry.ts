import type {
  OfficeDocumentState,
  OfficePreviewDocument,
  OfficeSelectionSummary
} from '../../../../../shared/officeProtocol'
import type { OfficeComposerTarget } from './officePromptTarget'
import { officeDocumentHumanEdit } from './officeDocumentUi'

type Listener = () => void

export interface OfficeDocumentSnapshot {
  document: OfficePreviewDocument
  selection?: OfficeSelectionSummary
  activeSheet?: string
}

export class OfficeDocumentRegistry {
  private readonly snapshots = new Map<string, OfficeDocumentSnapshot>()
  private readonly listeners = new Map<string, Set<Listener>>()

  publish(state: OfficeDocumentState, sourcePath?: string): void {
    const path =
      sourcePath ?? (state.state === 'ready' ? state.document.sourcePath : state.sourcePath)
    if (state.state === 'ready') {
      const current = this.snapshots.get(path)
      this.snapshots.set(path, {
        document: state.document,
        ...(current?.document.artifactId === state.document.artifactId && current.activeSheet
          ? { activeSheet: current.activeSheet }
          : {}),
        ...(officeDocumentHumanEdit(state.document) === 'cells' &&
        current?.document.artifactId === state.document.artifactId &&
        current.selection
          ? { selection: current.selection }
          : {})
      })
    } else this.snapshots.delete(path)
    this.emit(path)
  }

  clear(path: string, artifactId?: string): void {
    const current = this.snapshots.get(path)
    if (artifactId && current?.document.artifactId !== artifactId) return
    if (!this.snapshots.delete(path)) return
    this.emit(path)
  }

  document(path: string | null): OfficePreviewDocument | null {
    return this.snapshot(path)?.document ?? null
  }

  snapshot(path: string | null): OfficeDocumentSnapshot | null {
    return path ? (this.snapshots.get(path) ?? null) : null
  }

  activeSheet(path: string | null): string | undefined {
    return this.snapshot(path)?.activeSheet
  }

  publishSelection(artifactId: string, selection: OfficeSelectionSummary | null): void {
    for (const [path, current] of this.snapshots) {
      if (current.document.artifactId !== artifactId) continue
      if (officeDocumentHumanEdit(current.document) === 'none') {
        if (current.selection || current.activeSheet) {
          this.snapshots.set(path, { document: current.document })
          this.emit(path)
        }
        return
      }
      this.snapshots.set(path, {
        document: current.document,
        ...(selection ? { selection: { ...selection, paths: [...selection.paths] } } : {}),
        ...(selection?.sheet?.trim()
          ? { activeSheet: selection.sheet }
          : selection === null && current.activeSheet
            ? { activeSheet: current.activeSheet }
            : {})
      })
      this.emit(path)
      return
    }
  }

  target(path: string | null, label: string): OfficeComposerTarget | null {
    const snapshot = this.snapshot(path)
    const humanEdit = snapshot ? officeDocumentHumanEdit(snapshot.document) : 'cells'
    return snapshot
      ? {
          artifactId: snapshot.document.artifactId,
          label,
          ...(humanEdit === 'none' ? { humanEdit } : {}),
          ...(humanEdit === 'cells' && snapshot.selection ? { selection: snapshot.selection } : {})
        }
      : null
  }

  subscribe(path: string | null, listener: Listener): () => void {
    if (!path) return () => undefined
    const listeners = this.listeners.get(path) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(path, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(path)
    }
  }

  private emit(path: string): void {
    for (const listener of this.listeners.get(path) ?? []) listener()
  }
}

export const officeDocumentRegistry = new OfficeDocumentRegistry()
