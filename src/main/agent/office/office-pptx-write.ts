import { readFile } from 'node:fs/promises'

import {
  officeCliEnv,
  runOfficeCli,
  type OfficeCliRunOptions,
  type OfficeCliRunResult
} from './office-driver'
import {
  assertOfficePptxTarget,
  validateOfficePptxOperation,
  type OfficeAddSlideOperation,
  type OfficePptxBefore,
  type OfficePptxOperation,
  type OfficePptxSnapshot,
  type OfficePptxWriteReceipt
} from './office-pptx-contract'
import { officePptxStableElementPath, readOfficePptxSlideIds } from './office-pptx-identity'
import { parseOfficePptxSnapshot } from './office-pptx-snapshot'
import { OfficeWriteError, type OfficeWriteContext } from './office-write-contract'

interface OfficePptxWriterDependencies {
  readonly run?: typeof runOfficeCli
  readonly readPackage?: (path: string) => Promise<Buffer>
}

const COMMAND_TIMEOUT_MS = 30_000
const WRITE_ENV = { OFFICECLI_RESIDENT_FLUSH: 'each' } as const

export class OfficePptxWriter {
  private readonly run: typeof runOfficeCli
  private readonly readPackage: (path: string) => Promise<Buffer>

  constructor(dependencies: OfficePptxWriterDependencies = {}) {
    this.run = dependencies.run ?? runOfficeCli
    this.readPackage = dependencies.readPackage ?? readFile
  }

  async read(context: OfficeWriteContext): Promise<OfficePptxSnapshot> {
    const result = await this.run(
      context.binaryPath,
      ['get', context.draftPath, '/', '--depth', '5', '--json'],
      runOptions(context)
    )
    return parseOfficePptxSnapshot(result, await this.readPackage(context.draftPath))
  }

  async apply(
    context: OfficeWriteContext,
    input: OfficePptxOperation,
    snapshot: OfficePptxSnapshot
  ): Promise<OfficePptxWriteReceipt> {
    const operation = validateOfficePptxOperation(input)
    assertOfficePptxTarget(operation, snapshot)
    const args = applyArgs(context, operation, snapshot)
    const result = await this.run(context.binaryPath, args, runOptions(context))
    const mutation = parseMutation(result)
    if (operation.type === 'set_slide_text') {
      return parseSetReceipt(mutation, operation, args[2]!)
    }
    const index = parseAddedIndex(mutation)
    try {
      const slideIds = readOfficePptxSlideIds(await this.readPackage(context.draftPath))
      return addedReceipt(snapshot, slideIds, index)
    } catch {
      throw unknownResult()
    }
  }

  async restore(
    context: OfficeWriteContext,
    operation: OfficePptxOperation,
    before: OfficePptxBefore,
    receipt: OfficePptxWriteReceipt
  ): Promise<void> {
    const slideIds = readOfficePptxSlideIds(await this.readPackage(context.draftPath))
    const args = restoreArgs(context, operation, before, receipt, slideIds)
    parseMutation(await this.run(context.binaryPath, args, runOptions(context)))
  }
}

function runOptions(context: OfficeWriteContext): OfficeCliRunOptions {
  return {
    timeoutMs: COMMAND_TIMEOUT_MS,
    signal: context.signal,
    onSpawn: () => context.onSpawn?.(),
    env: officeCliEnv(process.env, WRITE_ENV)
  }
}

function applyArgs(
  context: OfficeWriteContext,
  operation: OfficePptxOperation,
  snapshot: OfficePptxSnapshot
): string[] {
  if (operation.type === 'set_slide_text') {
    const slide = snapshot.slides.find((entry) => entry.slideId === operation.slideId)!
    const element = slide.elements.find((entry) => entry.elementId === operation.elementId)!
    return ['set', context.draftPath, element.cliPath, '--prop', textProp(operation.text), '--json']
  }
  const args = ['add', context.draftPath, '/', '--type', 'slide']
  const position = operation.position
  if (position !== undefined && position !== 'end') {
    const index = snapshot.slides.findIndex((slide) => slide.slideId === position.after)
    args.push('--after', `/slide[${index + 1}]`)
  }
  args.push('--prop', `title=${operation.title}`)
  if (operation.body !== undefined) args.push('--prop', textProp(operation.body))
  args.push('--json')
  return args
}

function restoreArgs(
  context: OfficeWriteContext,
  operation: OfficePptxOperation,
  before: OfficePptxBefore,
  receipt: OfficePptxWriteReceipt,
  slideIds: readonly string[]
): string[] {
  if (operation.type === 'add_slide') {
    if (before.type !== operation.type || receipt.type !== operation.type) throw invalidEvidence()
    const index = slideIds.indexOf(receipt.slideId)
    if (index < 0) throw invalidEvidence()
    return ['remove', context.draftPath, `/slide[${index + 1}]`, '--json']
  }
  if (
    before.type !== operation.type ||
    receipt.type !== operation.type ||
    before.slideId !== operation.slideId ||
    before.elementId !== operation.elementId
  ) {
    throw invalidEvidence()
  }
  const index = slideIds.indexOf(before.slideId)
  if (index < 0) throw invalidEvidence()
  const path = `/slide[${index + 1}]/shape[@id=${before.elementId}]`
  return ['set', context.draftPath, path, '--prop', textProp(before.text), '--json']
}

function addedReceipt(
  before: OfficePptxSnapshot,
  currentIds: readonly string[],
  receiptIndex: number
): OfficePptxWriteReceipt {
  const oldIds = new Set(before.slides.map((slide) => slide.slideId))
  const added = currentIds.filter((slideId) => !oldIds.has(slideId))
  const slideId = currentIds[receiptIndex]
  if (currentIds.length !== before.slideCount + 1 || added.length !== 1 || slideId !== added[0]) {
    throw unknownResult()
  }
  return Object.freeze({
    type: 'add_slide',
    slideId,
    path: `/slide[@id=${slideId}]`,
    index: receiptIndex
  })
}

function parseAddedIndex(value: Record<string, unknown>): number {
  if (typeof value.data !== 'string') throw unknownResult()
  const match = /^Added slide at \/slide\[([1-9]\d*)\]$/u.exec(value.data)
  if (!match) throw unknownResult()
  return Number(match[1]) - 1
}

function parseSetReceipt(
  value: Record<string, unknown>,
  operation: Exclude<OfficePptxOperation, OfficeAddSlideOperation>,
  cliPath: string
): OfficePptxWriteReceipt {
  if (typeof value.data !== 'string' || !value.data.startsWith(`Updated ${cliPath}: text=`)) {
    throw unknownResult()
  }
  return Object.freeze({
    type: 'set_slide_text',
    slideId: operation.slideId,
    elementId: operation.elementId,
    path: officePptxStableElementPath(operation.slideId, operation.elementId)
  })
}

function parseMutation(result: OfficeCliRunResult): Record<string, unknown> {
  if (result.timedOut || result.spawnError || result.truncated) throw unknownResult()
  let value: unknown
  try {
    value = JSON.parse(result.stdout)
  } catch {
    throw unknownResult()
  }
  if (!isRecord(value)) throw unknownResult()
  const error = isRecord(value.error) ? value.error : undefined
  if (value.success === false && error?.code === 'not_found') {
    const message = typeof error.error === 'string' ? error.error : ''
    throw new OfficeWriteError(
      message.startsWith('Slide ') ? 'slide_not_found' : 'element_not_found',
      '目标幻灯片或文本元素不存在，请重新读取演示文稿'
    )
  }
  if (result.exitCode !== 0 || value.success !== true || hasWarnings(value)) throw unknownResult()
  return value
}

function hasWarnings(value: Record<string, unknown>): boolean {
  if (Array.isArray(value.warnings) ? value.warnings.length > 0 : value.warnings != null)
    return true
  const data = isRecord(value.data) ? value.data : undefined
  return Array.isArray(data?.warnings) ? data.warnings.length > 0 : data?.warnings != null
}

function textProp(text: string): string {
  return `text=${text}`
}

function invalidEvidence(): OfficeWriteError {
  return new OfficeWriteError('write_unknown', 'PowerPoint 回滚证据不一致，文档已冻结等待核对')
}

function unknownResult(): OfficeWriteError {
  return new OfficeWriteError('write_unknown', 'PowerPoint 写入结果无法确认，文档已冻结等待核对')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
