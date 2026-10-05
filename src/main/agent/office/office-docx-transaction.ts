import type {
  OfficeDocxBefore,
  OfficeDocxOperation,
  OfficeDocxWriteReceipt
} from './office-docx-contract'
import {
  OfficeDocumentTransaction,
  type OfficeDocumentTransactionAdapter,
  type OfficeDocumentTransactionDependencies
} from './office-document-transaction'
import { wrapOfficeDocxSnapshot } from './office-docx-operation'
import { OfficeWriteError, type OfficeWriteRequest } from './office-write-contract'

const adapter: OfficeDocumentTransactionAdapter<
  OfficeDocxOperation,
  OfficeDocxBefore,
  OfficeDocxWriteReceipt
> = {
  label: 'Word',
  requireOperation: requireDocxOperation,
  expectedText: (operation) => operation.text,
  async read(service, context) {
    if (!service.readDocxSnapshot) {
      throw new OfficeWriteError('write_failed', 'Word 段落读取能力不可用')
    }
    return wrapOfficeDocxSnapshot(await service.readDocxSnapshot(context))
  },
  async apply(service, context, operation, before) {
    if (!service.applyDocxOperation || !before.docx) {
      throw new OfficeWriteError('write_failed', 'Word 写入能力不可用')
    }
    return service.applyDocxOperation(context, operation, before.docx)
  },
  async restore(service, context, operation, before, receipt) {
    if (!service.restoreDocxOperation) {
      throw new OfficeWriteError('write_failed', 'Word 回滚能力不可用')
    }
    await service.restoreDocxOperation(context, operation, before, receipt)
  }
}

export class OfficeDocxTransaction extends OfficeDocumentTransaction<
  OfficeDocxOperation,
  OfficeDocxBefore,
  OfficeDocxWriteReceipt
> {
  constructor(dependencies: OfficeDocumentTransactionDependencies) {
    super(dependencies, adapter)
  }
}

function requireDocxOperation(request: OfficeWriteRequest): OfficeDocxOperation {
  const operation = request.operation
  if (operation.type !== 'add_paragraph' && operation.type !== 'set_paragraph_text') {
    throw new OfficeWriteError('operation_not_supported_for_kind', '该操作不适用于 Word 文档')
  }
  return operation
}
