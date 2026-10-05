import type {
  OfficeCellValue,
  OfficeRangeFormat,
  OfficeWriteDescription
} from './office-write-contract'
import { officeWriteDigest } from './office-write-digest'
import { officeWriteStrategy } from './office-write-operation'

export interface OfficeApplyApprovalInput {
  readonly operation:
    | {
        readonly type: 'set_cell'
        readonly sheet: string
        readonly cell: string
        readonly value: OfficeCellValue
      }
    | {
        readonly type: 'set_range'
        readonly sheet: string
        readonly range: string
        readonly values: readonly (readonly OfficeCellValue[])[]
      }
    | {
        readonly type: 'set_formula'
        readonly sheet: string
        readonly cell: string
        readonly formula: string
      }
    | {
        readonly type: 'format_range'
        readonly sheet: string
        readonly range: string
        readonly format: OfficeRangeFormat
      }
    | {
        readonly type: 'add_sheet'
        readonly name: string
      }
    | {
        readonly type: 'add_paragraph'
        readonly text: string
        readonly position?: 'end' | { readonly after: string }
      }
    | {
        readonly type: 'set_paragraph_text'
        readonly paraId: string
        readonly text: string
        readonly expectedText?: string
      }
    | {
        readonly type: 'add_slide'
        readonly title: string
        readonly body?: string
        readonly position?: 'end' | { readonly after: string }
      }
    | {
        readonly type: 'set_slide_text'
        readonly slideId: string
        readonly elementId: string
        readonly text: string
        readonly expectedText?: string
      }
  readonly baseRevision: number
}

const APPROVAL_TTL_MS = 120_000

interface OfficeApplyApprovalGrant {
  readonly runId: string
  readonly digest: string
  readonly expiresAt: number
}

export class OfficeApplyApprovalRegistry {
  private readonly grants = new Map<string, OfficeApplyApprovalGrant>()
  private readonly clock: () => number

  constructor(dependencies: { clock?: () => number } = {}) {
    this.clock = dependencies.clock ?? Date.now
  }

  grant(runId: string, toolCallId: string, digest: string): void {
    this.grants.set(approvalKey(runId, toolCallId), {
      runId,
      digest,
      expiresAt: this.clock() + APPROVAL_TTL_MS
    })
  }

  consume(runId: string, toolCallId: string, input: OfficeApplyApprovalInput): boolean {
    const key = approvalKey(runId, toolCallId)
    const grant = this.grants.get(key)
    this.grants.delete(key)
    return Boolean(
      grant && grant.expiresAt >= this.clock() && grant.digest === officeApplyApprovalDigest(input)
    )
  }

  clearRun(runId: string): void {
    for (const [key, grant] of this.grants) {
      if (grant.runId === runId) this.grants.delete(key)
    }
  }
}

export function officeApplyApprovalDigest(input: OfficeApplyApprovalInput): string {
  return officeWriteDigest(input)
}

export function formatOfficeApplyApprovalSummary(description: OfficeWriteDescription): string {
  const type =
    'type' in description &&
    (description.type === 'set_formula' ||
      description.type === 'format_range' ||
      description.type === 'add_sheet' ||
      description.type === 'add_paragraph' ||
      description.type === 'set_paragraph_text' ||
      description.type === 'add_slide' ||
      description.type === 'set_slide_text')
      ? description.type
      : 'range' in description
        ? 'set_range'
        : 'set_cell'
  return officeWriteStrategy(type).approvalSummary(description)
}

function approvalKey(runId: string, toolCallId: string): string {
  return `${runId}\0${toolCallId}`
}
