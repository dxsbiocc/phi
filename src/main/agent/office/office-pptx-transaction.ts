import type {
  OfficePptxBefore,
  OfficePptxOperation,
  OfficePptxWriteReceipt
} from './office-pptx-contract'
import {
  OfficeDocumentTransaction,
  type OfficeDocumentTransactionAdapter,
  type OfficeDocumentTransactionDependencies
} from './office-document-transaction'
import { wrapOfficePptxSnapshot } from './office-pptx-operation'
import { OfficeWriteError, type OfficeWriteRequest } from './office-write-contract'

const adapter: OfficeDocumentTransactionAdapter<
  OfficePptxOperation,
  OfficePptxBefore,
  OfficePptxWriteReceipt
> = {
  label: 'PowerPoint',
  requireOperation: requirePptxOperation,
  expectedText: (operation) => (operation.type === 'add_slide' ? operation.title : operation.text),
  async read(service, context) {
    if (!service.readPptxSnapshot) {
      throw new OfficeWriteError('write_failed', 'PowerPoint 文本读取能力不可用')
    }
    return wrapOfficePptxSnapshot(await service.readPptxSnapshot(context))
  },
  async apply(service, context, operation, before) {
    if (!service.applyPptxOperation || !before.pptx) {
      throw new OfficeWriteError('write_failed', 'PowerPoint 写入能力不可用')
    }
    return service.applyPptxOperation(context, operation, before.pptx)
  },
  async restore(service, context, operation, before, receipt) {
    if (!service.restorePptxOperation) {
      throw new OfficeWriteError('write_failed', 'PowerPoint 回滚能力不可用')
    }
    await service.restorePptxOperation(context, operation, before, receipt)
  }
}

export class OfficePptxTransaction extends OfficeDocumentTransaction<
  OfficePptxOperation,
  OfficePptxBefore,
  OfficePptxWriteReceipt
> {
  constructor(dependencies: OfficeDocumentTransactionDependencies) {
    super(dependencies, adapter)
  }
}

function requirePptxOperation(request: OfficeWriteRequest): OfficePptxOperation {
  const operation = request.operation
  if (operation.type !== 'add_slide' && operation.type !== 'set_slide_text') {
    throw new OfficeWriteError(
      'operation_not_supported_for_kind',
      '该操作不适用于 PowerPoint 演示文稿'
    )
  }
  return operation
}
