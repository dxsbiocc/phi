import type { OfficeServiceDependencies } from './office-service-state'
import { officeWriteStrategy } from './office-write-operation'
import type { OfficePreviewConfirmation, OfficeWriteOperation } from './office-write-contract'

export function armOfficeWriteConfirmation(
  service: OfficeServiceDependencies,
  artifactId: string,
  operation: OfficeWriteOperation
): OfficePreviewConfirmation {
  const condition = officeWriteStrategy(operation).previewCondition(operation)
  if (condition.kind === 'document') {
    return (
      service.armDocumentPreviewConfirmation?.(artifactId, condition.text) ??
      unavailableConfirmation()
    )
  }
  if (condition.kind === 'sheet') {
    return (
      service.armSheetPreviewConfirmation?.(artifactId, condition.sheet) ??
      unavailableConfirmation()
    )
  }
  if (service.armPreviewConfirmationSet) {
    return service.armPreviewConfirmationSet(artifactId, condition.sheet, condition.cells)
  }
  if (condition.cells.length === 1) {
    return service.armPreviewConfirmation(artifactId, condition.sheet, condition.cells[0]!)
  }
  return unavailableConfirmation()
}

function unavailableConfirmation(): OfficePreviewConfirmation {
  return { promise: Promise.resolve(false), cancel: () => undefined }
}
