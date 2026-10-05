import type { OfficeHumanEditAccess } from './office-human-edit'
import {
  officeArtifactKind,
  OFFICE_UNSUPPORTED_POWERPOINT_HUMAN_EDIT_MESSAGE,
  OFFICE_UNSUPPORTED_WORD_HUMAN_EDIT_MESSAGE
} from './office-document-kind'
import { failedHumanEdit, successfulHumanEdit } from './office-human-edit-status'
import {
  translateOfficeHumanCellText,
  type OfficeHumanCellTextInput,
  type OfficeHumanWriteOperation
} from './office-human-edit-translate'
import { requireOwnedOfficeDocument } from './office-service-guards'
import type { OwnedOfficeDocument } from './office-service-state'
import type { OfficeTargetRegistry } from './office-targets'
import type { OfficeWriteFlow } from './office-write'
import type {
  OfficeCellEditOptions,
  OfficeCellEditParams,
  OfficeCellEditResult,
  OfficeRangeEditParams,
  OfficeRangeEditResult,
  OfficeWriteRequest,
  OfficeWriteResult
} from './office-write-contract'
import { OfficeWriteError } from './office-write-contract'

interface OfficeServiceWriteState {
  readonly writing: OfficeWriteFlow
  readonly targets: OfficeTargetRegistry
  readonly owned: ReadonlyMap<string, OwnedOfficeDocument>
  readonly closingArtifacts: ReadonlySet<string>
}

export class OfficeServiceWriteFacade {
  constructor(private readonly state: OfficeServiceWriteState) {}

  applyCell(
    runId: string,
    params: OfficeCellEditParams,
    options: OfficeCellEditOptions
  ): Promise<OfficeCellEditResult> {
    return this.withRunSignal(runId, options, (next) =>
      this.state.writing.apply(runId, params, next)
    )
  }

  applyRange(
    runId: string,
    params: OfficeRangeEditParams,
    options: OfficeCellEditOptions
  ): Promise<OfficeRangeEditResult> {
    return this.withRunSignal(runId, options, (next) =>
      this.state.writing.applyRange(runId, params, next)
    )
  }

  applyRequest(
    runId: string,
    request: OfficeWriteRequest,
    options: OfficeCellEditOptions
  ): Promise<OfficeWriteResult> {
    return this.withRunSignal(runId, options, (next) =>
      this.state.writing.applyRequest(runId, request, next)
    )
  }

  async applyHuman(
    artifactId: string,
    input: OfficeHumanCellTextInput,
    options: Pick<OfficeCellEditOptions, 'operationId'>
  ): Promise<OfficeWriteResult> {
    const owned = requireOwnedOfficeDocument(
      this.state.owned,
      this.state.closingArtifacts,
      artifactId
    )
    const kind = officeArtifactKind(owned.document as unknown as Record<string, unknown>)
    if (kind !== 'xlsx') {
      throw new OfficeWriteError(
        'unsupported_document_kind',
        kind === 'pptx'
          ? OFFICE_UNSUPPORTED_POWERPOINT_HUMAN_EDIT_MESSAGE
          : OFFICE_UNSUPPORTED_WORD_HUMAN_EDIT_MESSAGE
      )
    }
    let operation: OfficeHumanWriteOperation | undefined
    try {
      operation = translateOfficeHumanCellText(input)
      const result = await this.state.writing.applyHuman(owned, operation, {
        operationId: options.operationId
      })
      owned.lastHumanEdit = successfulHumanEdit(operation)
      return result
    } catch (error) {
      owned.lastHumanEdit = failedHumanEdit(operation, error)
      throw error
    }
  }

  access(artifactId: string): OfficeHumanEditAccess {
    const owned = this.state.owned.get(artifactId)
    if (!owned || this.state.closingArtifacts.has(artifactId) || owned.freezeState === 'unknown') {
      return 'frozen'
    }
    if (officeArtifactKind(owned.document as unknown as Record<string, unknown>) !== 'xlsx') {
      return 'read_only'
    }
    return owned.readOnly ? 'read_only' : 'writable'
  }

  recordRejection(artifactId: string, code: string): void {
    const owned = this.state.owned.get(artifactId)
    if (!owned || this.state.closingArtifacts.has(artifactId)) return
    owned.lastHumanEdit = failedHumanEdit(undefined, { code })
  }

  private withRunSignal<T>(
    runId: string,
    options: OfficeCellEditOptions,
    apply: (options: OfficeCellEditOptions) => Promise<T>
  ): Promise<T> {
    const runSignal = this.state.targets.signalForRun(runId)
    if (!runSignal) return apply(options)
    const signal = options.signal ? AbortSignal.any([options.signal, runSignal]) : runSignal
    return apply({ ...options, signal })
  }
}
