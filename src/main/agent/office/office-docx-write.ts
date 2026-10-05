import {
  officeCliEnv,
  runOfficeCli,
  type OfficeCliRunOptions,
  type OfficeCliRunResult
} from './office-driver'
import {
  assertOfficeDocxTarget,
  normalizeOfficeParaId,
  validateOfficeDocxOperation,
  type OfficeDocxBefore,
  type OfficeDocxOperation,
  type OfficeDocxParagraphSnapshot,
  type OfficeDocxSnapshot,
  type OfficeDocxWriteReceipt
} from './office-docx-contract'
import { OfficeWriteError, type OfficeWriteContext } from './office-write-contract'
import { parseOfficeDocxParagraph } from './office-docx-paragraph'

interface OfficeDocxWriterDependencies {
  readonly run?: typeof runOfficeCli
}

const COMMAND_TIMEOUT_MS = 30_000
const WRITE_ENV = { OFFICECLI_RESIDENT_FLUSH: 'each' } as const

export class OfficeDocxWriter {
  private readonly run: typeof runOfficeCli

  constructor(dependencies: OfficeDocxWriterDependencies = {}) {
    this.run = dependencies.run ?? runOfficeCli
  }

  async read(context: OfficeWriteContext): Promise<OfficeDocxSnapshot> {
    const result = await this.run(
      context.binaryPath,
      ['get', context.draftPath, '/body', '--depth', '2', '--json'],
      runOptions(context)
    )
    return parseSnapshot(result)
  }

  async apply(
    context: OfficeWriteContext,
    input: OfficeDocxOperation,
    snapshot: OfficeDocxSnapshot
  ): Promise<OfficeDocxWriteReceipt> {
    const operation = validateOfficeDocxOperation(input)
    assertOfficeDocxTarget(operation, snapshot)
    const result = await this.run(
      context.binaryPath,
      applyArgs(context, operation),
      runOptions(context)
    )
    const receipt = parseMutation(result)
    return operation.type === 'add_paragraph'
      ? parseAddReceipt(receipt)
      : parseSetReceipt(receipt, operation.paraId)
  }

  async restore(
    context: OfficeWriteContext,
    operation: OfficeDocxOperation,
    before: OfficeDocxBefore,
    receipt: OfficeDocxWriteReceipt
  ): Promise<void> {
    const args = restoreArgs(context, operation, before, receipt)
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

function applyArgs(context: OfficeWriteContext, operation: OfficeDocxOperation): string[] {
  if (operation.type === 'set_paragraph_text') {
    return [
      'set',
      context.draftPath,
      paragraphPath(operation.paraId),
      '--prop',
      textProp(operation.text),
      '--json'
    ]
  }
  const args = ['add', context.draftPath, '/body', '--type', 'paragraph']
  if (operation.position !== undefined && operation.position !== 'end') {
    args.push('--after', paragraphPath(operation.position.after))
  }
  args.push('--prop', textProp(operation.text), '--json')
  return args
}

function restoreArgs(
  context: OfficeWriteContext,
  operation: OfficeDocxOperation,
  before: OfficeDocxBefore,
  receipt: OfficeDocxWriteReceipt
): string[] {
  if (operation.type === 'add_paragraph') {
    if (before.type !== operation.type || receipt.type !== operation.type) throw invalidEvidence()
    const paraId = normalizeOfficeParaId(receipt.paraId)
    return ['remove', context.draftPath, paragraphPath(paraId), '--json']
  }
  if (
    before.type !== operation.type ||
    receipt.type !== operation.type ||
    before.paraId !== operation.paraId ||
    receipt.paraId !== operation.paraId
  ) {
    throw invalidEvidence()
  }
  return [
    'set',
    context.draftPath,
    paragraphPath(before.paraId),
    '--prop',
    textProp(before.text),
    '--json'
  ]
}

function parseSnapshot(result: OfficeCliRunResult): OfficeDocxSnapshot {
  const value = parseReadEnvelope(result)
  const data = isRecord(value.data) ? value.data : undefined
  const results = Array.isArray(data?.results) ? data.results : []
  const body = results.find((entry) => isRecord(entry) && entry.path === '/body')
  if (!isRecord(body) || !Array.isArray(body.children)) throw invalidReadback()
  const paragraphs = body.children
    .flatMap((entry) => parseParagraph(entry))
    .map((entry, index) => Object.freeze({ ...entry, index }))
  if (new Set(paragraphs.map((entry) => entry.paraId)).size !== paragraphs.length) {
    throw invalidReadback()
  }
  return Object.freeze({ paragraphs: Object.freeze(paragraphs), paragraphCount: paragraphs.length })
}

function parseParagraph(value: unknown): OfficeDocxParagraphSnapshot[] {
  try {
    const paragraph = parseOfficeDocxParagraph(value)
    return paragraph ? [{ ...paragraph, index: -1 }] : []
  } catch {
    throw invalidReadback()
  }
}

function parseReadEnvelope(result: OfficeCliRunResult): Record<string, unknown> {
  if (result.timedOut || result.spawnError || result.truncated || result.exitCode !== 0) {
    throw new OfficeWriteError('write_failed', '无法读取 Word 段落快照')
  }
  try {
    const value = JSON.parse(result.stdout) as unknown
    if (!isRecord(value) || value.success !== true || hasWarnings(value)) throw new Error('invalid')
    return value
  } catch {
    throw new OfficeWriteError('write_failed', '无法读取 Word 段落快照')
  }
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
    throw new OfficeWriteError('paragraph_not_found', '目标段落不存在，请重新读取文档')
  }
  if (result.exitCode !== 0 || value.success !== true || hasWarnings(value)) throw unknownResult()
  return value
}

function parseAddReceipt(value: Record<string, unknown>): OfficeDocxWriteReceipt {
  if (typeof value.data !== 'string') throw unknownResult()
  const match = /^Added paragraph at (\/body\/p\[@paraId=([0-9A-F]{8})\])$/iu.exec(value.data)
  if (!match) throw unknownResult()
  const paraId = match[2]!.toUpperCase()
  return Object.freeze({ type: 'add_paragraph', paraId, path: paragraphPath(paraId) })
}

function parseSetReceipt(value: Record<string, unknown>, paraId: string): OfficeDocxWriteReceipt {
  const path = paragraphPath(paraId)
  if (typeof value.data !== 'string' || !value.data.startsWith(`Updated ${path}: text=`)) {
    throw unknownResult()
  }
  return Object.freeze({ type: 'set_paragraph_text', paraId, path })
}

function hasWarnings(value: Record<string, unknown>): boolean {
  if (Array.isArray(value.warnings) ? value.warnings.length > 0 : value.warnings != null)
    return true
  const data = isRecord(value.data) ? value.data : undefined
  return Array.isArray(data?.warnings) ? data.warnings.length > 0 : data?.warnings != null
}

function paragraphPath(paraId: string): string {
  return `/body/p[@paraId=${paraId}]`
}

function textProp(text: string): string {
  return `text=${text}`
}

function invalidReadback(): OfficeWriteError {
  return new OfficeWriteError('write_failed', 'Office 返回了无效的 Word 段落快照')
}

function invalidEvidence(): OfficeWriteError {
  return new OfficeWriteError('write_unknown', 'Word 回滚证据不一致，文档已冻结等待核对')
}

function unknownResult(): OfficeWriteError {
  return new OfficeWriteError('write_unknown', 'Word 写入结果无法确认，文档已冻结等待核对')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
