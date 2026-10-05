import type { OfficeOutputRecord } from './office-output-log'
import { OfficeSaveFlow, type OfficeSaveResult } from './office-save'
import { OfficeSaveAsFlow, type OfficeSaveAsDescriptor } from './office-save-as'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'
import {
  OfficeExportFlow,
  type OfficeExportDescriptor,
  type OfficeExportRequest
} from './office-export'
import type { OfficeExportFormat, OfficeExportOutputSummary } from '../../../shared/officeProtocol'

interface OfficeServiceSaveState {
  readonly dependencies: OfficeServiceDependencies
  readonly owned: ReadonlyMap<string, OwnedOfficeDocument>
  readonly closingArtifacts: ReadonlySet<string>
}

export class OfficeServiceSaveFacade {
  private readonly save: OfficeSaveFlow
  private readonly saveAs: OfficeSaveAsFlow
  private readonly export: OfficeExportFlow

  constructor(state: OfficeServiceSaveState) {
    this.save = new OfficeSaveFlow(state)
    this.saveAs = new OfficeSaveAsFlow(state)
    this.export = new OfficeExportFlow(state)
  }

  saveDocument(artifactId: string, sessionId: string): Promise<OfficeSaveResult> {
    return this.save.saveDocument(artifactId, sessionId)
  }

  saveAsDescriptor(artifactId: string, sessionId: string): OfficeSaveAsDescriptor {
    return this.saveAs.descriptor(artifactId, sessionId)
  }

  saveAsDocument(
    artifactId: string,
    sessionId: string,
    projectRoot: string,
    targetPath: string
  ): Promise<OfficeOutputRecord & { readonly fileName: string }> {
    return this.saveAs.saveAsDocument(artifactId, sessionId, projectRoot, targetPath)
  }

  resolveOutputPath(
    artifactId: string,
    sessionId: string,
    projectRoot: string,
    outputId: string
  ): Promise<string> {
    return this.saveAs.resolveOutputPath(artifactId, sessionId, projectRoot, outputId)
  }

  exportDescriptor(
    artifactId: string,
    sessionId: string,
    sheet: string,
    format: OfficeExportFormat
  ): OfficeExportDescriptor {
    return this.export.descriptor(artifactId, sessionId, sheet, format)
  }

  exportSheet(request: OfficeExportRequest): Promise<OfficeExportOutputSummary> {
    return this.export.exportSheet(request)
  }
}
