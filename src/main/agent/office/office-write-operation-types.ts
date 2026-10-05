import type { OfficeReadCell } from './office-read-contract'
import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import type { OfficeCliRunResult } from './office-driver'
import type {
  OfficeCellValue,
  OfficeWriteBefore,
  OfficeWriteDescription,
  OfficeInternalWriteOperation,
  OfficeWriteRequest,
  OfficeWriteResult,
  OfficeWriteSnapshot
} from './office-write-contract'

export type OfficeBatchCommand =
  | {
      readonly command: 'add'
      readonly parent: '/'
      readonly type: 'sheet'
      readonly props: { readonly name: string }
    }
  | {
      readonly command: 'set'
      readonly path: string
      readonly props:
        | {
            readonly value: OfficeCellValue
            readonly type: 'string' | 'number' | 'boolean'
          }
        | { readonly formula: string }
        | { readonly clear: true }
        | Readonly<{
            bold?: 'true' | 'false'
            fill?: string
            'alignment.horizontal'?: 'left' | 'center' | 'right'
            numfmt?: string
          }>
    }

export interface OfficeWriteOperationStrategy {
  readonly type: OfficeInternalWriteOperation['type']
  readonly documentKind?: OfficeDocumentKind
  validate(operation: unknown, baseRevision: unknown): OfficeWriteRequest
  digestInput(request: OfficeWriteRequest): Readonly<Record<string, unknown>>
  affectedCells(operation: OfficeInternalWriteOperation): readonly string[]
  readRange(operation: OfficeInternalWriteOperation): string
  expected(
    operation: OfficeInternalWriteOperation,
    before?: OfficeWriteSnapshot
  ): OfficeWriteSnapshot
  commands(operation: OfficeInternalWriteOperation): readonly OfficeBatchCommand[]
  assertBatchResult?(result: OfficeCliRunResult, expectedItems: number): void
  previewCondition(
    operation: OfficeInternalWriteOperation
  ):
    | { readonly kind: 'cells'; readonly sheet: string; readonly cells: readonly string[] }
    | { readonly kind: 'sheet'; readonly sheet: string }
    | { readonly kind: 'document'; readonly text: string }
  assertBefore?(operation: OfficeInternalWriteOperation, before: OfficeWriteSnapshot): void
  restoreCommands?(
    operation: OfficeInternalWriteOperation,
    before: OfficeWriteBefore
  ): readonly OfficeBatchCommand[]
  snapshot(
    operation: OfficeInternalWriteOperation,
    cells: readonly OfficeReadCell[]
  ): OfficeWriteSnapshot
  verify?(
    operation: OfficeInternalWriteOperation,
    before: OfficeWriteSnapshot,
    current: OfficeWriteSnapshot
  ): boolean
  before(operation: OfficeInternalWriteOperation, snapshot: OfficeWriteSnapshot): OfficeWriteBefore
  restoreBefore(
    operation: OfficeInternalWriteOperation,
    before: OfficeWriteBefore
  ): OfficeWriteSnapshot
  describe(
    request: OfficeWriteRequest,
    before: OfficeWriteSnapshot,
    documentName: string,
    revision: number
  ): OfficeWriteDescription
  approvalSummary(description: OfficeWriteDescription): string
  result(
    request: OfficeWriteRequest,
    before: OfficeWriteSnapshot,
    revision: number,
    saved: boolean,
    previewConfirmed: boolean,
    verified?: OfficeWriteSnapshot
  ): OfficeWriteResult
  classify(
    operation: OfficeInternalWriteOperation,
    before: OfficeWriteSnapshot,
    current: OfficeWriteSnapshot
  ): 'applied' | 'not_applied' | 'indeterminate' | 'applied_no_change'
}
