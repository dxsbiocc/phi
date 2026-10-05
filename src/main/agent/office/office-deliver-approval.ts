import { createHash } from 'node:crypto'

import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import { visibleText } from './office-approval-summary'

const APPROVAL_TTL_MS = 120_000

export interface OfficeDeliverApprovalInput {
  readonly outputName?: string
}

export interface OfficeDeliverDescription {
  readonly fileName: string
  readonly kind: OfficeDocumentKind
  readonly outputPath: string
}

interface OfficeDeliverApprovalGrant {
  readonly runId: string
  readonly digest: string
  readonly expiresAt: number
}

export class OfficeDeliverApprovalRegistry {
  private readonly grants = new Map<string, OfficeDeliverApprovalGrant>()
  private readonly clock: () => number

  constructor(dependencies: { clock?: () => number } = {}) {
    this.clock = dependencies.clock ?? Date.now
  }

  grant(runId: string, toolCallId: string, digest: string): void {
    this.grants.set(keyFor(runId, toolCallId), {
      runId,
      digest,
      expiresAt: this.clock() + APPROVAL_TTL_MS
    })
  }

  consume(runId: string, toolCallId: string, input: OfficeDeliverApprovalInput): boolean {
    const key = keyFor(runId, toolCallId)
    const grant = this.grants.get(key)
    this.grants.delete(key)
    return Boolean(
      grant &&
      grant.expiresAt >= this.clock() &&
      grant.digest === officeDeliverApprovalDigest(input)
    )
  }

  clearRun(runId: string): void {
    for (const [key, grant] of this.grants) {
      if (grant.runId === runId) this.grants.delete(key)
    }
  }
}

export function officeDeliverApprovalDigest(input: OfficeDeliverApprovalInput): string {
  const value = input.outputName === undefined ? {} : { outputName: input.outputName }
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function formatOfficeDeliverApprovalSummary(description: OfficeDeliverDescription): string {
  return `将在当前工作区写入新的${kindLabel(description.kind)}「${visibleText(description.fileName)}」（相对位置：${visibleText(description.outputPath)}），并在内容检查通过后展示交付卡`
}

function kindLabel(kind: OfficeDocumentKind): string {
  if (kind === 'xlsx') return ' Excel 表格'
  if (kind === 'docx') return ' Word 文档'
  return ' PowerPoint 演示文稿'
}

function keyFor(runId: string, toolCallId: string): string {
  return `${runId}\0${toolCallId}`
}
