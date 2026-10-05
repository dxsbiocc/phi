import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import type { OfficeDocxSnapshot } from './office-docx-contract'
import type { OfficeOperationLogState } from './office-operation-log'
import type { OfficePptxSnapshot } from './office-pptx-contract'
import { officePptxLayoutWarning } from './office-pptx-element'
import type {
  OfficeReadContext,
  OfficeReadParams,
  OfficeReadResponse
} from './office-read-contract'
import type { OfficeDeliveryCheck } from './office-output-log'
import { OfficeSaveAsError } from './office-save-as-target'
import type { OfficeWriteContext, OfficeWriteResult } from './office-write-contract'

const MAX_DELIVERY_SAMPLES = 5

export interface OfficeDeliveryCheckInput {
  readonly artifactId: string
  readonly binaryPath: string
  readonly outputPath: string
  readonly kind: OfficeDocumentKind
  readonly revision: number
  readonly operationLog: OfficeOperationLogState
  readonly signal: AbortSignal
  readonly expectedPageCount?: number
}

export interface OfficeDeliveryCheckResult {
  readonly checks: readonly OfficeDeliveryCheck[]
  readonly warnings: readonly string[]
}

export interface OfficeDeliveryCheckDependencies {
  readonly readRange: (
    context: OfficeReadContext,
    params: OfficeReadParams
  ) => Promise<OfficeReadResponse>
  readonly readDocxSnapshot: (context: OfficeWriteContext) => Promise<OfficeDocxSnapshot>
  readonly readPptxSnapshot: (context: OfficeWriteContext) => Promise<OfficePptxSnapshot>
  readonly releaseTransient: (binaryPath: string, path: string) => Promise<void>
}

export async function runOfficeDeliveryChecks(
  input: OfficeDeliveryCheckInput,
  dependencies: OfficeDeliveryCheckDependencies
): Promise<OfficeDeliveryCheckResult> {
  let result: OfficeDeliveryCheckResult | undefined
  let primaryError: OfficeSaveAsError | undefined
  try {
    result =
      input.kind === 'xlsx'
        ? await checkSpreadsheet(input, dependencies)
        : input.kind === 'docx'
          ? await checkDocument(input, dependencies)
          : await checkPresentation(input, dependencies)
  } catch (error) {
    primaryError = error instanceof OfficeSaveAsError ? error : checkFailed()
  }
  try {
    await dependencies.releaseTransient(input.binaryPath, input.outputPath)
  } catch {
    primaryError ??= checkFailed()
  }
  if (primaryError) throw primaryError
  return result!
}

async function checkPresentation(
  input: OfficeDeliveryCheckInput,
  dependencies: OfficeDeliveryCheckDependencies
): Promise<OfficeDeliveryCheckResult> {
  const results = recentResults(input)
  const expectations = dedupePresentationExpectations(
    results.flatMap(presentationExpectation)
  ).slice(0, MAX_DELIVERY_SAMPLES)
  const snapshot = await dependencies.readPptxSnapshot(writeContext(input))
  if (input.expectedPageCount !== undefined && snapshot.slideCount !== input.expectedPageCount) {
    throw checkFailed('Office 交付页数与当前预览状态不一致')
  }
  expectations.forEach((expectation) => assertPresentationExpectation(snapshot, expectation))
  return {
    checks: [
      {
        name: 'pptx_content',
        status: 'passed',
        sampled: expectations.length,
        pageCount: snapshot.slideCount
      }
    ],
    warnings: deliveryWarnings(results, snapshot)
  }
}

type PresentationExpectation =
  | {
      readonly type: 'element'
      readonly slideId: string
      readonly elementId: string
      readonly kind: 'title' | 'body' | 'text'
      readonly text: string
    }
  | {
      readonly type: 'slide'
      readonly slideId: string
      readonly title?: string
      readonly body?: string
    }

function presentationExpectation(value: OfficeWriteResult): readonly PresentationExpectation[] {
  if (!('slideId' in value) || typeof value.slideId !== 'string') return []
  if (
    'elementId' in value &&
    typeof value.elementId === 'string' &&
    'after' in value &&
    'kind' in value
  ) {
    return [
      {
        type: 'element',
        slideId: value.slideId,
        elementId: value.elementId,
        kind: value.kind,
        text: value.after
      }
    ]
  }
  if ('title' in value && typeof value.title === 'string') {
    return [
      {
        type: 'slide',
        slideId: value.slideId,
        title: value.title,
        ...('body' in value && typeof value.body === 'string' ? { body: value.body } : {})
      }
    ]
  }
  return []
}

function dedupePresentationExpectations(
  values: readonly PresentationExpectation[]
): readonly PresentationExpectation[] {
  const keys = new Set<string>()
  const touchedKinds = new Set<string>()
  const result: PresentationExpectation[] = []
  for (const value of values) {
    const key =
      value.type === 'element'
        ? `element:${value.slideId}:${value.elementId}`
        : `slide:${value.slideId}`
    if (keys.has(key)) continue
    keys.add(key)
    if (value.type === 'element') {
      touchedKinds.add(`${value.slideId}:${value.kind}`)
      result.push(value)
      continue
    }
    result.push({
      ...value,
      ...(touchedKinds.has(`${value.slideId}:title`) ? { title: undefined } : {}),
      ...(touchedKinds.has(`${value.slideId}:body`) ? { body: undefined } : {})
    })
  }
  return result
}

function assertPresentationExpectation(
  snapshot: OfficePptxSnapshot,
  expectation: PresentationExpectation
): void {
  const slide = snapshot.slides.find((entry) => entry.slideId === expectation.slideId)
  if (!slide) throw checkFailed('Office 交付缺少最近写入的幻灯片')
  if (expectation.type === 'element') {
    const element = slide.elements.find((entry) => entry.elementId === expectation.elementId)
    if (!element || element.text !== expectation.text) {
      throw checkFailed('Office 交付缺少最近写入的幻灯片文本')
    }
    return
  }
  const title = slide.elements.find((entry) => entry.kind === 'title')
  const body = slide.elements.find((entry) => entry.kind === 'body')
  if (expectation.title !== undefined && title?.text !== expectation.title) {
    throw checkFailed('Office 交付缺少最近写入的幻灯片标题')
  }
  if (expectation.body !== undefined && body?.text !== expectation.body) {
    throw checkFailed('Office 交付缺少最近写入的幻灯片正文')
  }
}

async function checkDocument(
  input: OfficeDeliveryCheckInput,
  dependencies: OfficeDeliveryCheckDependencies
): Promise<OfficeDeliveryCheckResult> {
  const results = recentResults(input)
  const expectations = uniqueBy(
    results.flatMap(documentExpectation),
    (expectation) => expectation.paraId
  ).slice(0, MAX_DELIVERY_SAMPLES)
  const snapshot = await dependencies.readDocxSnapshot(writeContext(input))
  for (const expectation of expectations) {
    const paragraph = snapshot.paragraphs.find((entry) => entry.paraId === expectation.paraId)
    if (!paragraph || paragraph.text !== expectation.text) throw checkFailed()
  }
  return {
    checks: [{ name: 'docx_content', status: 'passed', sampled: expectations.length }],
    warnings: deliveryWarnings(results)
  }
}

function documentExpectation(
  value: OfficeWriteResult
): readonly { readonly paraId: string; readonly text: string }[] {
  if (!('paraId' in value) || typeof value.paraId !== 'string') return []
  if ('text' in value && typeof value.text === 'string') {
    return [{ paraId: value.paraId, text: value.text }]
  }
  if ('after' in value && typeof value.after === 'string') {
    return [{ paraId: value.paraId, text: value.after }]
  }
  return []
}

async function checkSpreadsheet(
  input: OfficeDeliveryCheckInput,
  dependencies: OfficeDeliveryCheckDependencies
): Promise<OfficeDeliveryCheckResult> {
  const results = recentResults(input)
  const expectations = uniqueBy(
    results.flatMap(spreadsheetExpectation),
    (expectation) => `${expectation.sheet}\0${expectation.cell}`
  ).slice(0, MAX_DELIVERY_SAMPLES)
  const addedSheet = expectations.length === 0 ? addedSheetExpectation(results) : undefined
  if (expectations.length === 0) {
    const overview = await dependencies.readRange(readContext(input), {})
    if (!('sheets' in overview)) throw checkFailed()
    if (addedSheet && !overview.sheets.some((sheet) => sheet.name === addedSheet)) {
      throw checkFailed()
    }
  }
  for (const expectation of expectations) {
    const result = await dependencies.readRange(readContext(input), {
      sheet: expectation.sheet,
      range: expectation.cell
    })
    if (!('cells' in result)) throw checkFailed()
    const cell = result.cells.find((candidate) => candidate.ref === expectation.cell)
    if (!cell || !Object.is(cell.value, expectation.value)) throw checkFailed()
    if (expectation.formula !== undefined && cell.formula !== expectation.formula) {
      throw checkFailed()
    }
  }
  return {
    checks: [
      {
        name: 'xlsx_content',
        status: 'passed',
        sampled: expectations.length || (addedSheet ? 1 : 0)
      }
    ],
    warnings: deliveryWarnings(results)
  }
}

function addedSheetExpectation(results: readonly OfficeWriteResult[]): string | undefined {
  const result = results.find(
    (value) =>
      'sheetNames' in value &&
      Array.isArray(value.sheetNames) &&
      'sheet' in value &&
      typeof value.sheet === 'string'
  )
  return result && 'sheet' in result ? result.sheet : undefined
}

interface SpreadsheetExpectation {
  readonly sheet: string
  readonly cell: string
  readonly value: unknown
  readonly formula?: string
}

function spreadsheetExpectation(value: OfficeWriteResult): readonly SpreadsheetExpectation[] {
  if (!('sheet' in value) || typeof value.sheet !== 'string') return []
  if ('formula' in value && 'computedValue' in value && typeof value.cell === 'string') {
    return [
      {
        sheet: value.sheet,
        cell: value.cell,
        value: value.computedValue,
        formula: value.formula
      }
    ]
  }
  if ('cell' in value && 'after' in value && typeof value.cell === 'string') {
    return [{ sheet: value.sheet, cell: value.cell, value: value.after }]
  }
  if ('preview' in value && Array.isArray(value.preview)) {
    const sample = value.preview.find(
      (entry): entry is { cell: string; after: unknown } =>
        isRecord(entry) && typeof entry.cell === 'string' && Object.hasOwn(entry, 'after')
    )
    return sample ? [{ sheet: value.sheet, cell: sample.cell, value: sample.after }] : []
  }
  return []
}

function recentResults(input: OfficeDeliveryCheckInput): readonly OfficeWriteResult[] {
  return Object.entries(input.operationLog.operations)
    .filter(([, record]) => record.status === 'succeeded' && record.receipt?.ok === true)
    .toSorted(
      ([leftId, left], [rightId, right]) =>
        receiptRevision(right) - receiptRevision(left) ||
        right.createdAt.localeCompare(left.createdAt) ||
        rightId.localeCompare(leftId)
    )
    .flatMap(([, record]) => (record.receipt?.ok ? [record.receipt.value] : []))
    .filter((value): value is OfficeWriteResult => value.revision <= input.revision && value.saved)
}

function receiptRevision(record: OfficeOperationLogState['operations'][string]): number {
  return record.receipt?.ok ? record.receipt.value.revision : -1
}

function deliveryWarnings(
  results: readonly OfficeWriteResult[],
  snapshot?: OfficePptxSnapshot
): readonly string[] {
  const latest = uniqueBy(results, warningTargetKey)
  const warnings = latest.flatMap(
    (result) =>
      result.warnings?.filter(
        (warning) => warning !== 'preview_not_confirmed' && warning !== 'text_may_overflow'
      ) ?? []
  )
  if (snapshot && presentationMayOverflow(snapshot)) warnings.push('text_may_overflow')
  return Object.freeze(
    [...new Set(warnings.filter((warning) => typeof warning === 'string'))].slice(0, 20)
  )
}

function presentationMayOverflow(snapshot: OfficePptxSnapshot): boolean {
  return snapshot.slides.some((slide) =>
    slide.elements.some((element) =>
      officePptxLayoutWarning(element.text, element.kind, element.geometry)
    )
  )
}

function warningTargetKey(result: OfficeWriteResult): string {
  if ('paraId' in result) return `paragraph:${result.paraId}`
  if ('slideId' in result && 'elementId' in result) {
    return `element:${result.slideId}:${result.elementId}`
  }
  if ('slideId' in result) return `slide:${result.slideId}`
  if ('sheet' in result && 'cell' in result) return `cell:${result.sheet}:${result.cell}`
  if ('sheet' in result && 'range' in result) return `range:${result.sheet}:${result.range}`
  if ('sheet' in result) return `sheet:${result.sheet}`
  return 'other'
}

function uniqueBy<T>(values: readonly T[], keyFor: (value: T) => string): readonly T[] {
  const keys = new Set<string>()
  return values.filter((value) => {
    const key = keyFor(value)
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })
}

function readContext(input: OfficeDeliveryCheckInput): OfficeReadContext {
  return {
    artifactId: `delivery:${input.artifactId}`,
    binaryPath: input.binaryPath,
    draftPath: input.outputPath,
    revision: input.revision,
    signal: input.signal
  }
}

function writeContext(input: OfficeDeliveryCheckInput): OfficeWriteContext {
  return {
    binaryPath: input.binaryPath,
    draftPath: input.outputPath,
    signal: input.signal
  }
}

function checkFailed(message = 'Office 交付内容读回检查失败'): OfficeSaveAsError {
  return new OfficeSaveAsError('delivery_check_failed', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
