import { resolve } from 'node:path'

import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import { officeCliEnv, runOfficeCli, type OfficeCliRunResult } from './office-driver'
import {
  MAX_OFFICE_ROWS,
  type OfficeArtifact,
  type OfficeDocumentInspection,
  type OfficePresentationInspection,
  type OfficeWorkbookDimensions
} from './office-files'
import { OFFICE_DOCUMENT_LIMITS } from './office-limits'
import { parseOfficePptxSlideCount } from './office-pptx-preview-check'
import { fileOwnerPids } from './office-process-discovery'

export { fileOwnerPids } from './office-process-discovery'

const COMMAND_TIMEOUT_MS = 30_000
const RESIDENT_DISCOVERY_TIMEOUT_MS = 2_000
const RESIDENT_FLUSH_ENV = { OFFICECLI_RESIDENT_FLUSH: 'each' } as const
const RESIDENT_EXIT_TIMEOUT_MS = 5_000
const RESIDENT_TERM_GRACE_MS = 2_000
const RESIDENT_EXIT_POLL_MS = 25

export class OfficeProcessError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'OfficeProcessError'
  }
}

function columnNumber(cell: string): number {
  const letters = /^([A-Z]+)\d+$/i.exec(cell)?.[1]?.toUpperCase()
  if (!letters) return 0
  let value = 0
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64
  return value
}

export function parseWorkbookDimensions(value: unknown): OfficeWorkbookDimensions {
  const envelope = value as {
    success?: unknown
    data?: { sheets?: Array<{ rows?: Array<{ row?: unknown; cells?: Record<string, unknown> }> }> }
  }
  if (envelope?.success !== true || !Array.isArray(envelope.data?.sheets)) {
    throw new OfficeProcessError('inspection-failed', 'OfficeCLI 返回了无效的工作簿检查结果')
  }
  let rows = 0
  let columns = 0
  for (const sheet of envelope.data.sheets) {
    if (!Array.isArray(sheet.rows)) continue
    for (const row of sheet.rows) {
      if (Number.isSafeInteger(row.row)) rows = Math.max(rows, Number(row.row))
      for (const cell of Object.keys(row.cells ?? {}))
        columns = Math.max(columns, columnNumber(cell))
    }
  }
  return { rows, columns }
}

export function parseDocumentInspection(value: unknown): OfficeDocumentInspection {
  const envelope = value as {
    success?: unknown
    data?: { elements?: Array<{ type?: unknown; text?: unknown }> }
  }
  if (envelope?.success !== true || !Array.isArray(envelope.data?.elements)) {
    throw new OfficeProcessError('inspection-failed', 'OfficeCLI 返回了无效的文档检查结果')
  }
  const paragraphs = envelope.data.elements.filter((element) => element.type === 'paragraph')
  const sampleTexts = paragraphs
    .flatMap((element) => (typeof element.text === 'string' && element.text ? [element.text] : []))
    .slice(0, OFFICE_DOCUMENT_LIMITS.maxPreviewParagraphSamples)
  return { paragraphs: paragraphs.length, sampleTexts }
}

function assertCliSuccess(result: OfficeCliRunResult, operation: string): unknown {
  if (result.spawnError || result.timedOut || result.truncated || result.exitCode !== 0) {
    throw new OfficeProcessError('officecli-failed', `${operation}失败`)
  }
  try {
    const parsed = JSON.parse(result.stdout) as { success?: unknown; message?: unknown }
    if (parsed.success !== true) {
      throw new OfficeProcessError(
        'officecli-failed',
        typeof parsed.message === 'string' ? parsed.message : `${operation}失败`
      )
    }
    return parsed
  } catch (error) {
    if (error instanceof OfficeProcessError) throw error
    throw new OfficeProcessError('officecli-failed', `${operation}返回无效结果`, { cause: error })
  }
}

async function runJson(binaryPath: string, args: readonly string[]): Promise<unknown> {
  const result = await runOfficeCli(binaryPath, [...args, '--json'], {
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: officeCliEnv(process.env, RESIDENT_FLUSH_ENV)
  })
  return assertCliSuccess(result, args[0] ?? 'OfficeCLI')
}

export async function inspectOfficeWorkbook(
  binaryPath: string,
  draftPath: string
): Promise<OfficeWorkbookDimensions> {
  const result = await inspectOfficeDocument(binaryPath, draftPath, 'xlsx')
  if (!('rows' in result)) throw new OfficeProcessError('inspection-failed', '工作簿检查结果无效')
  return result
}

export async function inspectOfficeDocument(
  binaryPath: string,
  draftPath: string,
  kind: OfficeDocumentKind
): Promise<OfficeWorkbookDimensions | OfficeDocumentInspection | OfficePresentationInspection> {
  try {
    return await inspectResidentOfficeDocument(binaryPath, draftPath, kind)
  } finally {
    await releaseTransientOfficeResident(binaryPath, draftPath)
  }
}

export async function inspectResidentOfficeDocument(
  binaryPath: string,
  draftPath: string,
  kind: OfficeDocumentKind
): Promise<OfficeWorkbookDimensions | OfficeDocumentInspection | OfficePresentationInspection> {
  const command =
    kind === 'xlsx'
      ? ['view', draftPath, 'text', '--max-lines', String(MAX_OFFICE_ROWS + 1)]
      : kind === 'docx'
        ? ['view', draftPath, 'text']
        : ['get', draftPath, '/']
  const value = await runJson(binaryPath, command)
  await runJson(binaryPath, ['validate', draftPath])
  if (kind === 'xlsx') return parseWorkbookDimensions(value)
  if (kind === 'docx') return parseDocumentInspection(value)
  return { slides: parseOfficePptxSlideCount(value) }
}

export async function createBlankOfficeWorkbook(
  binaryPath: string,
  draftPath: string
): Promise<void> {
  try {
    await runJson(binaryPath, ['create', draftPath])
  } catch (error) {
    await runJson(binaryPath, ['close', draftPath]).catch(() => undefined)
    throw error
  }
}

async function waitForResident(_binaryPath: string, draftPath: string): Promise<number> {
  const deadline = Date.now() + RESIDENT_DISCOVERY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const [pid] = await fileOwnerPids(resolve(draftPath))
    if (pid) return pid
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new OfficeProcessError('resident-not-found', 'Office resident 已启动但无法登记进程所有权')
}

export async function adoptCreatedOfficeResident(
  _binaryPath: string,
  artifact: OfficeArtifact
): Promise<{ residentPid: number }> {
  return { residentPid: await waitForResident(_binaryPath, artifact.draftPath) }
}

export async function startOfficeResident(
  binaryPath: string,
  artifact: OfficeArtifact
): Promise<{ residentPid: number }> {
  await runJson(binaryPath, ['open', artifact.draftPath])
  return { residentPid: await waitForResident(binaryPath, artifact.draftPath) }
}

export interface ResidentExitDependencies {
  readonly isAlive?: (pid: number) => boolean
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly sleep?: (ms: number) => Promise<void>
  readonly exitTimeoutMs?: number
  readonly termGraceMs?: number
}

export function isOfficeProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone: the exit poll below confirms it.
  }
}

async function waitForExit(
  pid: number,
  timeoutMs: number,
  dependencies: Required<Pick<ResidentExitDependencies, 'isAlive' | 'sleep'>>
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (dependencies.isAlive(pid)) {
    if (Date.now() >= deadline) return false
    await dependencies.sleep(RESIDENT_EXIT_POLL_MS)
  }
  return true
}

/**
 * `officecli close` returns once the resident has been told to stop, but the daemon flushes the
 * package afterwards. Reporting the document released before it has really exited lets a quick
 * re-open race a still-writing resident, so wait for the process itself to go.
 */
export async function closeOfficeResident(
  binaryPath: string,
  artifact: OfficeArtifact,
  residentPid: number,
  dependencies: ResidentExitDependencies = {}
): Promise<void> {
  try {
    await runJson(binaryPath, ['close', artifact.draftPath])
  } catch (error) {
    const stillOwnsDraft = (await fileOwnerPids(artifact.draftPath)).includes(residentPid)
    if (stillOwnsDraft) process.kill(residentPid, 'SIGTERM')
    throw error
  }
  if (!(residentPid > 0)) return
  const poll = {
    isAlive: dependencies.isAlive ?? isOfficeProcessAlive,
    sleep: dependencies.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  }
  if (
    await waitForExit(residentPid, dependencies.exitTimeoutMs ?? RESIDENT_EXIT_TIMEOUT_MS, poll)
  ) {
    return
  }
  ;(dependencies.kill ?? signalProcess)(residentPid, 'SIGTERM')
  if (await waitForExit(residentPid, dependencies.termGraceMs ?? RESIDENT_TERM_GRACE_MS, poll)) {
    return
  }
  throw new OfficeProcessError('resident-exit-timeout', 'Office 常驻进程未能退出')
}

export interface TransientReleaseDependencies {
  readonly run?: typeof runOfficeCli
  readonly owners?: (path: string) => Promise<number[]>
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly sleep?: (ms: number) => Promise<void>
  readonly timeoutMs?: number
  readonly termGraceMs?: number
}

export interface ForcedTransientTerminationDependencies {
  readonly owners?: (path: string) => Promise<number[]>
  readonly isAlive?: (pid: number) => boolean
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly sleep?: (ms: number) => Promise<void>
  readonly termGraceMs?: number
  readonly killGraceMs?: number
}

export async function forceTerminateTransientOfficeProcesses(
  path: string,
  knownPids: readonly number[],
  dependencies: ForcedTransientTerminationDependencies = {}
): Promise<void> {
  const target = resolve(path)
  const owners = dependencies.owners ?? fileOwnerPids
  const isAlive = dependencies.isAlive ?? isOfficeProcessAlive
  const kill = dependencies.kill ?? signalProcess
  const sleep =
    dependencies.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const initial = new Set([...knownPids, ...(await owners(target))])
  for (const pid of initial) if (pid > 0) kill(pid, 'SIGTERM')
  if (
    await waitForForcedExit(
      target,
      initial,
      owners,
      isAlive,
      sleep,
      dependencies.termGraceMs ?? 100
    )
  ) {
    return
  }
  const remaining = new Set([...initial, ...(await owners(target))])
  for (const pid of remaining) if (pid > 0 && isAlive(pid)) kill(pid, 'SIGKILL')
  if (
    await waitForForcedExit(
      target,
      remaining,
      owners,
      isAlive,
      sleep,
      dependencies.killGraceMs ?? 50
    )
  ) {
    return
  }
  throw new OfficeProcessError('resident-release-timeout', 'Office 导入进程未能在退出期限内释放')
}

async function waitForForcedExit(
  path: string,
  knownPids: ReadonlySet<number>,
  owners: (path: string) => Promise<number[]>,
  isAlive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await owners(path)).length === 0 && [...knownPids].every((pid) => !isAlive(pid)))
      return true
    if (Date.now() >= deadline) return false
    await sleep(10)
  }
}

/**
 * Commands such as `validate` start a background resident for the file they touch. For a
 * transient copy nobody owns that resident, and once the copy is renamed or deleted the daemon
 * would otherwise live on and could write the copy's path back into the user's project.
 */
export async function releaseTransientOfficeResident(
  binaryPath: string,
  path: string,
  dependencies: TransientReleaseDependencies = {}
): Promise<void> {
  const target = resolve(path)
  // `close` fails when no resident was started, which is the desired end state anyway.
  await (dependencies.run ?? runOfficeCli)(binaryPath, ['close', target, '--json'], {
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: officeCliEnv(process.env, RESIDENT_FLUSH_ENV)
  }).catch(() => undefined)
  const owners = dependencies.owners ?? fileOwnerPids
  const sleep =
    dependencies.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  if (
    await waitForNoOwners(target, owners, sleep, dependencies.timeoutMs ?? RESIDENT_EXIT_TIMEOUT_MS)
  ) {
    return
  }
  for (const pid of await owners(target)) (dependencies.kill ?? signalProcess)(pid, 'SIGTERM')
  if (
    await waitForNoOwners(target, owners, sleep, dependencies.termGraceMs ?? RESIDENT_TERM_GRACE_MS)
  ) {
    return
  }
  throw new OfficeProcessError('resident-release-timeout', 'Office 临时进程未能释放')
}

async function waitForNoOwners(
  path: string,
  owners: (path: string) => Promise<number[]>,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await owners(path)).length === 0) return true
    if (Date.now() >= deadline) return false
    await sleep(RESIDENT_EXIT_POLL_MS)
  }
}
