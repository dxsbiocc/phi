import type { OfficePptxOperation } from './office-pptx-contract'
import { wrapOfficePptxSnapshot } from './office-pptx-operation'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'
import {
  OfficeWriteError,
  type OfficeWriteContext,
  type OfficeWriteSnapshot
} from './office-write-contract'

export async function readOfficePptxReconcileSnapshot(
  service: OfficeServiceDependencies,
  owned: OwnedOfficeDocument,
  _operation: OfficePptxOperation,
  signal: AbortSignal
): Promise<OfficeWriteSnapshot> {
  const read = service.readPptxSnapshot
  if (!read) throw new OfficeWriteError('reconcile_failed', 'PowerPoint 文本核对能力不可用')
  return wrapOfficePptxSnapshot(await read(writeContext(owned, signal)))
}

function writeContext(owned: OwnedOfficeDocument, signal: AbortSignal): OfficeWriteContext {
  return { binaryPath: owned.binaryPath, draftPath: owned.document.draftPath, signal }
}
