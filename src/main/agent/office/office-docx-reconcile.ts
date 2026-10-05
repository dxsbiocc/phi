import type { OfficeDocxOperation } from './office-docx-contract'
import { wrapOfficeDocxSnapshot } from './office-docx-operation'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'
import {
  OfficeWriteError,
  type OfficeWriteContext,
  type OfficeWriteSnapshot
} from './office-write-contract'

export async function readOfficeDocxReconcileSnapshot(
  service: OfficeServiceDependencies,
  owned: OwnedOfficeDocument,
  _operation: OfficeDocxOperation,
  signal: AbortSignal
): Promise<OfficeWriteSnapshot> {
  const read = service.readDocxSnapshot
  if (!read) throw new OfficeWriteError('reconcile_failed', 'Word 段落核对能力不可用')
  return wrapOfficeDocxSnapshot(await read(writeContext(owned, signal)))
}

function writeContext(owned: OwnedOfficeDocument, signal: AbortSignal): OfficeWriteContext {
  return { binaryPath: owned.binaryPath, draftPath: owned.document.draftPath, signal }
}
