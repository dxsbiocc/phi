import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { get as getHttp } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { officePlatformId } from '../../scripts/office/fetch-officecli.mjs'
import {
  officeCliEnv,
  runOfficeCli,
  type OfficeCliRunResult
} from '../../src/main/agent/office/office-driver'
import { officeBinaryCandidates } from '../../src/main/agent/office/office-runtime'
import { createOfficeService } from '../../src/main/agent/office/office-service'
import {
  createOfficeApplyHostHandler,
  createOfficeDescribeHostHandler,
  createOfficeReadHostHandler
} from '../../src/main/agent/office/office-tool-host'
import { createPhiSession } from '../../src/main/agent/session/session-store'
import type { OfficeExportFormat, OfficeExportOutputSummary } from '../../src/shared/officeProtocol'

const platformId = officePlatformId()
const bundledOfficeDir = join(process.cwd(), 'resources', 'office')
export const officeBinary = platformId
  ? officeBinaryCandidates(platformId, { bundledOfficeDir })[0]
  : undefined
export const officeRangeIntegrationEnabled =
  process.env.PHI_OFFICE_INTEGRATION === '1' && !!officeBinary && existsSync(officeBinary)
export const officeRangeIntegrationOptions = {
  skip: officeRangeIntegrationEnabled
    ? false
    : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
}

export const OFFICE_RANGE_ORIGIN_SESSION_ID = 'runtime-range-main'
const RUN_ID = 'office-range-host-run'

export interface RangeApplyInput {
  readonly operation:
    | {
        readonly type: 'set_cell'
        readonly sheet: string
        readonly cell: string
        readonly value: string | number | boolean
      }
    | {
        readonly type: 'set_range'
        readonly sheet: string
        readonly range: string
        readonly values: readonly (readonly (string | number | boolean)[])[]
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
        readonly format: {
          readonly bold?: boolean
          readonly fill?: string
          readonly horizontalAlign?: 'left' | 'center' | 'right'
          readonly numberFormat?: 'General' | '0' | '0.00' | '#,##0' | '#,##0.00'
        }
      }
    | {
        readonly type: 'add_sheet'
        readonly name: string
      }
  readonly baseRevision: number
}

interface PreviewEvents {
  readonly close: () => void
  readonly ready: Promise<void>
  readonly recent: () => string
  readonly updates: () => readonly { at: number; action: string; cells: readonly string[] }[]
}

export interface OfficeRangeHostFixture {
  readonly artifactId: string
  readonly previewUrl: string
  readonly sourcePath: string
  readonly draftPath: string
  readonly read: ReturnType<typeof createOfficeReadHostHandler>
  readonly describe: ReturnType<typeof createOfficeDescribeHostHandler>
  apply(input: RangeApplyInput, operationId: string): Promise<unknown>
  humanEdit(
    input: { readonly sheet: string; readonly cell: string; readonly text: string },
    operationId: string
  ): Promise<unknown>
  exportSheet(input: {
    readonly targetPath: string
    readonly requestId: string
    readonly sheet: string
    readonly format: OfficeExportFormat
  }): Promise<OfficeExportOutputSummary>
  preparePreview(): Promise<void>
  previewEvents(): string
  previewUpdates(): readonly { at: number; action: string; cells: readonly string[] }[]
  cleanup(): Promise<void>
}

export interface OfficeRangeHostFixtureOptions {
  readonly runOfficeCli?: typeof runOfficeCli
  readonly prepareSource?: (sourcePath: string) => Promise<void>
  readonly previewSeedCell?: string
}

export async function createOfficeRangeHostFixture(
  options: OfficeRangeHostFixtureOptions = {}
): Promise<OfficeRangeHostFixture> {
  const root = mkdtempSync(join(tmpdir(), 'office range host '))
  const restoreAgentDir = withAgentDir(root)
  const sourcePath = join(root, 'source.xlsx')
  const service = createOfficeService(
    options.runOfficeCli ? { runOfficeCli: options.runOfficeCli } : {}
  )
  let eventStream: PreviewEvents | undefined
  try {
    if (options.prepareSource) await options.prepareSource(sourcePath)
    else {
      await runJson(['create', sourcePath])
      await runJson(['close', sourcePath])
    }
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'ask'
    })
    const opened = await service.open({
      sessionId: session.sessionId,
      projectId: null,
      sourcePath,
      allowRoots: [root]
    })
    if (opened.state !== 'ready') {
      throw new Error(
        opened.state === 'error' ? opened.message : 'Office document is still preparing'
      )
    }
    service.bindRunTarget({
      runId: RUN_ID,
      artifactId: opened.document.artifactId,
      sessionId: session.sessionId,
      projectId: null
    })
    const resolveActiveRun = (runtimeSessionId: string): { runId: string } | undefined =>
      runtimeSessionId === OFFICE_RANGE_ORIGIN_SESSION_ID ? { runId: RUN_ID } : undefined
    const read = createOfficeReadHostHandler({
      resolveActiveRun,
      readRange: (runId, params) => service.readRange(runId, params)
    })
    const describe = createOfficeDescribeHostHandler({
      resolveActiveRun,
      describeCellEdit: (runId, params) => service.describeCellEdit(runId, params),
      describeWriteRequest: (runId, request) => service.describeWriteRequest(runId, request)
    })
    const apply = createOfficeApplyHostHandler({
      resolveActiveRun,
      authorizeApply: () => true,
      authorizeWrite: () => true,
      applyCellEdit: (runId, params, applyOptions) =>
        service.applyCellEdit(runId, params, applyOptions),
      applyWriteRequest: (runId, request, applyOptions) =>
        service.applyWriteRequest(runId, request, applyOptions)
    })
    return {
      artifactId: opened.document.artifactId,
      previewUrl: opened.document.previewUrl,
      sourcePath,
      draftPath: opened.document.draftPath,
      read,
      describe,
      apply: (input, operationId) =>
        apply(input, {
          originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID,
          toolCallId: operationId
        }),
      humanEdit: (input, operationId) =>
        service.applyHumanCellEdit(opened.document.artifactId, input, { operationId }),
      exportSheet: (input) =>
        service.exportSheet({
          artifactId: opened.document.artifactId,
          sessionId: session.sessionId,
          projectRoot: root,
          ...input
        }),
      async preparePreview() {
        await (await fetch(opened.document.previewUrl)).text()
        eventStream = await connectEventStream(`${opened.document.previewUrl}events`)
        await runJson(
          [
            'set',
            opened.document.draftPath,
            `/Sheet1/${options.previewSeedCell ?? 'J10'}`,
            '--prop',
            'value=preview-ready',
            '--prop',
            'type=string'
          ],
          { OFFICECLI_RESIDENT_FLUSH: 'each' }
        )
        await waitForPreviewReady(eventStream.ready)
      },
      previewEvents: () => eventStream?.recent() ?? '',
      previewUpdates: () => eventStream?.updates() ?? [],
      async cleanup() {
        eventStream?.close()
        await service.dispose()
        assertNoOfficeCliOwner(opened.document.draftPath)
        await runOfficeCli(officeBinary!, ['close', sourcePath, '--json'], {
          timeoutMs: 15_000
        }).catch(() => undefined)
        assertNoOfficeCliOwner(sourcePath)
        restoreAgentDir()
        rmSync(root, { recursive: true, force: true })
      }
    }
  } catch (error) {
    await service.dispose().catch(() => undefined)
    restoreAgentDir()
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

export async function runJson(
  args: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {}
): Promise<OfficeCliRunResult> {
  const result = await runOfficeCli(officeBinary!, [...args, '--json'], {
    env: officeCliEnv(process.env, extraEnvironment),
    timeoutMs: 30_000
  })
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
  return result
}

export function worksheetXml(path: string): string {
  return execFileSync('/usr/bin/unzip', ['-p', path, 'xl/worksheets/sheet1.xml'], {
    encoding: 'utf8'
  })
}

export function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!
}

function connectEventStream(url: string): Promise<PreviewEvents> {
  return new Promise((resolve, reject) => {
    let body = ''
    let buffer = ''
    let markReady!: () => void
    const updates: Array<{ at: number; action: string; cells: readonly string[] }> = []
    const ready = new Promise<void>((resolveReady) => {
      markReady = resolveReady
    })
    const request = getHttp(url, (response) => {
      response.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        body = `${body}${text}`.slice(-64 * 1024)
        buffer = `${buffer}${text}`.replaceAll('\r\n', '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          const update = previewUpdate(data)
          if (update) {
            updates.push({ at: performance.now(), ...update })
            if (update.action === 'full' || update.action === 'excel-patch') markReady()
          }
          boundary = buffer.indexOf('\n\n')
        }
      })
      response.once('error', () => undefined)
      resolve({
        close: () => request.destroy(),
        ready,
        recent: () => body,
        updates: () => [...updates]
      })
    })
    request.once('error', reject)
  })
}

function previewUpdate(data: string): { action: string; cells: readonly string[] } | undefined {
  try {
    const value = JSON.parse(data) as { action?: unknown; patches?: unknown }
    if (typeof value.action !== 'string') return undefined
    if (value.action !== 'excel-patch' || !Array.isArray(value.patches)) {
      return { action: value.action, cells: [] }
    }
    const cells = new Set<string>()
    for (const patch of value.patches) {
      const html = (patch as { html?: unknown }).html
      if (typeof html !== 'string') continue
      for (const match of html.matchAll(/data-path="\/[^"<>]+\/([A-Z]+[1-9]\d*)"/gu)) {
        cells.add(match[1])
      }
    }
    return { action: value.action, cells: [...cells] }
  } catch {
    return undefined
  }
}

async function waitForPreviewReady(ready: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('preview SSE did not become ready')), 15_000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function withAgentDir(root: string): () => void {
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
}

function assertNoOfficeCliOwner(path: string): void {
  try {
    const output = execFileSync('/usr/sbin/lsof', ['-t', '-a', '-c', 'officecli', '--', path], {
      encoding: 'utf8'
    })
    if (output.trim()) throw new Error(`officecli still owns ${path}`)
  } catch (error) {
    if ((error as { status?: number }).status === 1) return
    throw error
  }
}
