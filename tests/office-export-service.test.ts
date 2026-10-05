import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { OfficeExportFlow } from '../src/main/agent/office/office-export'
import { OfficeDocumentOperationQueue } from '../src/main/agent/office/office-operation-queue'
import { loadOfficeOutputLog } from '../src/main/agent/office/office-output-log'
import {
  columnName,
  parseOfficeRange,
  type OfficeReadContext,
  type OfficeReadCell,
  type OfficeReadParams,
  type OfficeReadResponse
} from '../src/main/agent/office/office-read-contract'
import type {
  OfficeServiceDependencies,
  OwnedOfficeDocument
} from '../src/main/agent/office/office-service-state'

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

async function createFixture(
  root: string,
  values: readonly (readonly (string | number | boolean | null)[])[],
  options: {
    readonly readOnly?: boolean
    readonly needsSave?: boolean
    readonly frozen?: boolean
    readonly previewFailed?: boolean
    readonly saveFails?: boolean
  } = {}
): Promise<{
  flow: OfficeExportFlow
  owned: OwnedOfficeDocument
  draftPath: string
  pauseReads: (pause: () => Promise<void>) => void
}> {
  const draftPath = join(root, '预算表.xlsx')
  const draftBytes = Buffer.from('saved-workbook')
  await writeFile(draftPath, draftBytes)
  let beforeRangeRead: (() => Promise<void>) | undefined
  const readRange = async (
    context: OfficeReadContext,
    params: OfficeReadParams
  ): Promise<OfficeReadResponse> => {
    if (!params.range) {
      return {
        revision: context.revision,
        sheets: [
          {
            name: 'Sheet1',
            usedRange:
              values.length && values[0]?.length
                ? `A1:${columnName(values[0].length)}${values.length}`
                : null,
            rowCount: values.length,
            columnCount: values[0]?.length ?? 0
          }
        ],
        complete: false,
        truncated: false,
        hint: 'select range',
        limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
      }
    }
    await beforeRangeRead?.()
    const range = parseOfficeRange(params.range)
    const cells: OfficeReadCell[] = []
    for (let row = range.startRow; row <= range.endRow; row += 1) {
      for (let column = range.startColumn; column <= range.endColumn; column += 1) {
        const value = values[row - 1]?.[column - 1] ?? null
        cells.push({
          ref: `${columnName(column)}${row}`,
          value,
          valueType:
            value === null
              ? ('empty' as const)
              : typeof value === 'number'
                ? ('number' as const)
                : typeof value === 'boolean'
                  ? ('boolean' as const)
                  : ('string' as const)
        })
      }
    }
    return {
      revision: context.revision,
      sheet: 'Sheet1',
      range: range.range,
      cells,
      rowCount: range.rowCount,
      columnCount: range.columnCount,
      complete: true,
      truncated: false,
      limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
    }
  }
  const dependencies = {
    readRange,
    saveDraft: async () => {
      if (options.saveFails) throw new Error('save failed')
    },
    verifySavedDraft: async () => ({ sha256: sha256(draftBytes), size: draftBytes.length }),
    persistOperationLog: async () => undefined,
    assertNotOfficeArtifactPath: async () => undefined,
    outputId: () => 'export-output-1',
    now: () => new Date('2026-10-06T00:00:00.000Z')
  } as unknown as OfficeServiceDependencies
  const owned = {
    key: 'session-1\0artifact-1',
    binaryPath: '/officecli',
    panelReferences: 1,
    lastActivityAt: 0,
    contentRevision: 3,
    ...(options.frozen ? { freezeState: 'unknown' as const } : {}),
    readOnly: options.readOnly === true,
    needsSave: options.needsSave === true,
    saveStatus: {
      saveState: 'saved',
      lastSavedRevision: 3,
      lastSavedAt: '2026-10-05T00:00:00.000Z',
      savedDraftHash: sha256(draftBytes)
    },
    operationLog: { version: 2, contentRevision: 3, operations: {} },
    operations: new OfficeDocumentOperationQueue(),
    document: {
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      kind: 'xlsx',
      sourcePath: join(root, 'source.xlsx'),
      sourceHash: 'a'.repeat(64),
      draftPath,
      residentPid: 100,
      watchPid: 101,
      watchPort: 31_000,
      gatewayPort: 42_000,
      previewUrl: 'http://127.0.0.1:42000/',
      previewState: options.previewFailed ? 'preview_failed' : 'ready'
    }
  } as OwnedOfficeDocument
  const flow = new OfficeExportFlow({
    dependencies,
    owned: new Map([[owned.document.artifactId, owned]]),
    closingArtifacts: new Set()
  })
  return {
    flow,
    owned,
    draftPath,
    pauseReads: (pause: () => Promise<void>) => {
      beforeRangeRead = pause
    }
  }
}

test('export transaction writes one sheet, records metadata, and replays durably', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-export-service-'))
  try {
    const { flow, owned, draftPath } = await createFixture(root, [
      ['a,b', '=literal'],
      [3, '中文']
    ])
    const targetPath = join(root, '预算表-Sheet1.csv')
    const request = {
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectRoot: root,
      targetPath,
      requestId: 'export-request-1',
      sheet: 'Sheet1',
      format: 'csv' as const
    }
    assert.deepEqual(flow.descriptor('artifact-1', 'session-1', 'Sheet1', 'csv'), {
      fileName: '预算表-Sheet1.csv',
      format: 'csv',
      sheet: 'Sheet1'
    })
    const first = await flow.exportSheet(request)
    assert.equal(await readFile(targetPath, 'utf8'), '"a,b",=literal\n3,中文\n')
    assert.deepEqual(first, {
      outputId: 'export-output-1',
      outputPath: '预算表-Sheet1.csv',
      fileName: '预算表-Sheet1.csv',
      revision: 3,
      sha256: sha256(Buffer.from('"a,b",=literal\n3,中文\n')),
      size: Buffer.byteLength('"a,b",=literal\n3,中文\n'),
      createdAt: '2026-10-06T00:00:00.000Z',
      source: 'draft',
      format: 'csv',
      sheet: 'Sheet1',
      rows: 2,
      columns: 2
    })
    owned.freezeState = 'unknown'
    const replay = await flow.exportSheet({ ...request, targetPath: join(root, 'unused.csv') })
    assert.equal(replay.deduplicated, true)
    assert.equal(replay.outputId, first.outputId)
    await assert.rejects(
      flow.exportSheet({
        ...request,
        targetPath: join(root, 'unused.tsv'),
        format: 'tsv'
      }),
      { code: 'operation_conflict' }
    )
    const log = await loadOfficeOutputLog(draftPath)
    assert.equal(log.version, 3)
    assert.equal(log.outputs.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('export holds the document queue so a concurrent revision cannot mix pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-export-queue-'))
  try {
    const { flow, owned, pauseReads } = await createFixture(root, [['before']])
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    pauseReads(async () => {
      entered()
      await gate
    })
    const exporting = flow.exportSheet({
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectRoot: root,
      targetPath: join(root, 'queued.csv'),
      requestId: 'queued-export',
      sheet: 'Sheet1',
      format: 'csv'
    })
    await started
    let writeStarted = false
    const writing = owned.operations.run(async () => {
      writeStarted = true
      owned.contentRevision = 4
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(writeStarted, false)
    release()
    const output = await exporting
    await writing
    assert.equal(output.revision, 3)
    assert.equal(owned.contentRevision, 4)
    assert.equal(await readFile(join(root, 'queued.csv'), 'utf8'), 'before\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an already-aborted export leaves no target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-export-abort-'))
  const targetPath = join(root, 'cancelled.csv')
  try {
    const { flow } = await createFixture(root, [['value']])
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      flow.exportSheet({
        artifactId: 'artifact-1',
        sessionId: 'session-1',
        projectRoot: root,
        targetPath,
        requestId: 'cancelled-export',
        sheet: 'Sheet1',
        format: 'csv',
        signal: controller.signal
      }),
      { code: 'export_cancelled' }
    )
    await assert.rejects(readFile(targetPath), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unsafe document states and save failure never leave an export target', async () => {
  const cases = [
    { name: 'read-only', options: { readOnly: true }, code: 'document_read_only' },
    { name: 'unsaved', options: { needsSave: true }, code: 'save_failed' },
    { name: 'frozen', options: { frozen: true }, code: 'document_frozen' },
    { name: 'preview-failed', options: { previewFailed: true }, code: 'export_failed' },
    { name: 'save-failed', options: { saveFails: true }, code: 'save_failed' }
  ] as const
  for (const entry of cases) {
    const root = await mkdtemp(join(tmpdir(), `office-export-${entry.name}-`))
    const targetPath = join(root, `${entry.name}.csv`)
    try {
      const { flow } = await createFixture(root, [['value']], entry.options)
      await assert.rejects(
        flow.exportSheet({
          artifactId: 'artifact-1',
          sessionId: 'session-1',
          projectRoot: root,
          targetPath,
          requestId: `export-${entry.name}`,
          sheet: 'Sheet1',
          format: 'csv'
        }),
        { code: entry.code }
      )
      await assert.rejects(readFile(targetPath), { code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('replacing a validated parent with a symlink cannot redirect the final export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-export-parent-swap-'))
  const outside = await mkdtemp(join(tmpdir(), 'office-export-parent-outside-'))
  const parent = join(root, 'nested')
  const movedParent = join(root, 'nested-original')
  const outsideTarget = join(outside, 'escaped.csv')
  try {
    await mkdir(parent)
    const { flow, pauseReads } = await createFixture(root, [['value']])
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    pauseReads(async () => {
      entered()
      await gate
    })
    const exporting = flow.exportSheet({
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectRoot: root,
      targetPath: join(parent, 'escaped.csv'),
      requestId: 'parent-swap',
      sheet: 'Sheet1',
      format: 'csv'
    })
    await started
    await rename(parent, movedParent)
    await symlink(outside, parent)
    release()

    await assert.rejects(exporting, { code: 'unsafe_path' })
    await assert.rejects(readFile(outsideTarget), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
