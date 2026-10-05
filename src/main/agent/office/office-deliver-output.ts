import { createHash } from 'node:crypto'
import { basename } from 'node:path'

import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import type { ResolvedOfficeDeliveryTarget } from './office-deliver-target'
import type { OfficeDeliveryCheck, OfficeDeliveryOutputRecord } from './office-output-log'
import { OfficeSaveAsError } from './office-save-as-target'
import type { OfficeRunTarget } from './office-targets'

export interface OfficeDeliveryResult {
  readonly absolutePath: string
  readonly outputPath: string
  readonly fileName: string
  readonly outputId: string
  readonly kind: OfficeDocumentKind
  readonly revision: number
  readonly sha256: string
  readonly size: number
  readonly warnings: readonly string[]
  readonly checks: readonly OfficeDeliveryCheck[]
  readonly deduplicated?: true
}

export interface OfficeDeliveryOptions {
  readonly operationId: string
  readonly authorize?: () => boolean | Promise<boolean>
  readonly signal?: AbortSignal
  readonly remote?: boolean
  readonly validatePresentation?: (result: OfficeDeliveryResult) => void | Promise<void>
}

interface DeliveryRecordInput {
  readonly target: ResolvedOfficeDeliveryTarget
  readonly operationId: string
  readonly requestDigest: string
  readonly revision: number
  readonly sha256: string
  readonly size: number
  readonly checks: readonly OfficeDeliveryCheck[]
  readonly warnings: readonly string[]
  readonly outputId: string
  readonly createdAt: string
}

export function createOfficeDeliveryRecord(input: DeliveryRecordInput): OfficeDeliveryOutputRecord {
  return {
    outputId: input.outputId,
    outputPath: input.target.outputPath,
    revision: input.revision,
    sha256: input.sha256,
    size: input.size,
    createdAt: input.createdAt,
    source: 'draft',
    operationId: input.operationId,
    requestDigest: input.requestDigest,
    kind: input.target.kind,
    checks: Object.freeze([...input.checks]),
    warnings: Object.freeze([...input.warnings])
  }
}

export function deliveryRequestDigest(
  runTarget: OfficeRunTarget,
  target: ResolvedOfficeDeliveryTarget
): string {
  const request = JSON.stringify({
    artifactId: runTarget.artifactId,
    sessionId: runTarget.sessionId,
    projectId: runTarget.projectId,
    absolutePath: target.absolutePath,
    kind: target.kind
  })
  return createHash('sha256').update(request).digest('hex')
}

export function resultFromDeliveryRecord(
  record: OfficeDeliveryOutputRecord,
  absolutePath: string
): OfficeDeliveryResult {
  return Object.freeze({
    absolutePath,
    outputPath: record.outputPath,
    fileName: basename(absolutePath),
    outputId: record.outputId,
    kind: record.kind,
    revision: record.revision,
    sha256: record.sha256,
    size: record.size,
    warnings: record.warnings,
    checks: record.checks
  })
}

export async function validateDeliveryPresentation(
  options: OfficeDeliveryOptions,
  result: OfficeDeliveryResult
): Promise<void> {
  try {
    await options.validatePresentation?.(result)
  } catch {
    throw new OfficeSaveAsError(
      'presentation_validation_failed',
      'Office 交付文件未通过现有文件展示路径校验'
    )
  }
}
