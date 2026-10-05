import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runOfficeDeliveryChecks } from '../src/main/agent/office/office-deliver-checks'
import type { OfficeOperationLogState } from '../src/main/agent/office/office-operation-log'

test('xlsx delivery checks read a recent successful cell write from the final output path', async () => {
  const reads: string[] = []
  const releases: string[] = []
  const result = await runOfficeDeliveryChecks(
    {
      artifactId: 'artifact-1',
      binaryPath: '/officecli',
      outputPath: '/project/final.xlsx',
      kind: 'xlsx',
      revision: 4,
      operationLog: operationLogWithCellWrite(),
      signal: new AbortController().signal
    },
    {
      readRange: async (context, params) => {
        reads.push(`${context.draftPath}:${params.sheet}:${params.range}`)
        return {
          revision: context.revision,
          sheet: 'Sheet1',
          range: 'B2',
          cells: [{ ref: 'B2', value: '完成', valueType: 'string' }],
          rowCount: 1,
          columnCount: 1,
          complete: true,
          truncated: false,
          limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
        }
      },
      readDocxSnapshot: async () => {
        throw new Error('unused')
      },
      readPptxSnapshot: async () => {
        throw new Error('unused')
      },
      releaseTransient: async (_binaryPath, path) => {
        releases.push(path)
      }
    }
  )

  assert.deepEqual(result, {
    checks: [{ name: 'xlsx_content', status: 'passed', sampled: 1 }],
    warnings: []
  })
  assert.deepEqual(reads, ['/project/final.xlsx:Sheet1:B2'])
  assert.deepEqual(releases, ['/project/final.xlsx'])
})

test('docx delivery checks match recent paragraph receipts by stable paraId', async () => {
  let released = false
  const operationLog: OfficeOperationLogState = {
    version: 2,
    contentRevision: 2,
    operations: {
      paragraph: {
        digest: 'b'.repeat(64),
        status: 'succeeded',
        createdAt: '2026-10-05T12:01:00.000Z',
        receipt: {
          ok: true,
          value: {
            applied: true,
            saved: true,
            revision: 2,
            paraId: '00100000',
            path: '/body/p[@paraId=00100000]',
            index: 0,
            text: '交付正文',
            previewConfirmed: true
          }
        }
      }
    }
  }
  const result = await runOfficeDeliveryChecks(
    {
      artifactId: 'artifact-1',
      binaryPath: '/officecli',
      outputPath: '/project/final.docx',
      kind: 'docx',
      revision: 2,
      operationLog,
      signal: new AbortController().signal,
      expectedPageCount: 2
    },
    {
      readRange: async () => {
        throw new Error('unused')
      },
      readDocxSnapshot: async (context) => {
        assert.equal(context.draftPath, '/project/final.docx')
        return {
          paragraphCount: 1,
          paragraphs: [{ paraId: '00100000', index: 0, text: '交付正文', editable: true }]
        }
      },
      readPptxSnapshot: async () => {
        throw new Error('unused')
      },
      releaseTransient: async () => {
        released = true
      }
    }
  )

  assert.deepEqual(result.checks, [{ name: 'docx_content', status: 'passed', sampled: 1 }])
  assert.equal(released, true)
})

test('pptx delivery checks include page count and persisted layout warnings', async () => {
  const finalTitle = '中'.repeat(72)
  const operationLog: OfficeOperationLogState = {
    version: 2,
    contentRevision: 3,
    operations: {
      slide: {
        digest: 'c'.repeat(64),
        status: 'succeeded',
        createdAt: '2026-10-05T12:02:00.000Z',
        receipt: {
          ok: true,
          value: {
            applied: true,
            saved: true,
            revision: 3,
            slideId: '256',
            elementId: '2',
            path: '/slide[@id=256]/shape[@id=2]',
            index: 0,
            kind: 'title',
            before: '旧标题',
            after: finalTitle,
            previewConfirmed: true,
            layoutWarning: 'text_may_overflow',
            warnings: []
          }
        }
      },
      'older-add': {
        digest: 'e'.repeat(64),
        status: 'succeeded',
        createdAt: '2026-10-05T11:59:00.000Z',
        receipt: {
          ok: true,
          value: {
            applied: true,
            saved: true,
            revision: 2,
            slideId: '256',
            path: '/slide[@id=256]',
            index: 0,
            title: '旧标题',
            previewConfirmed: true
          }
        }
      }
    }
  }
  const result = await runOfficeDeliveryChecks(
    {
      artifactId: 'artifact-1',
      binaryPath: '/officecli',
      outputPath: '/project/final.pptx',
      kind: 'pptx',
      revision: 3,
      operationLog,
      signal: new AbortController().signal,
      expectedPageCount: 2
    },
    {
      readRange: async () => {
        throw new Error('unused')
      },
      readDocxSnapshot: async () => {
        throw new Error('unused')
      },
      readPptxSnapshot: async () => ({
        slideCount: 2,
        slides: [
          {
            slideId: '256',
            index: 0,
            title: finalTitle,
            elements: [
              {
                elementId: '2',
                path: '/slide[@id=256]/shape[@id=2]',
                cliPath: '/slide[1]/shape[@id=2]',
                kind: 'title',
                text: finalTitle,
                editable: true
              }
            ]
          },
          { slideId: '257', index: 1, elements: [] }
        ]
      }),
      releaseTransient: async () => undefined
    }
  )

  assert.deepEqual(result, {
    checks: [{ name: 'pptx_content', status: 'passed', sampled: 2, pageCount: 2 }],
    warnings: ['text_may_overflow']
  })
})

test('xlsx checks read an overview when there are no successful content writes', async () => {
  let overviewReads = 0
  const result = await runOfficeDeliveryChecks(
    {
      artifactId: 'artifact-1',
      binaryPath: '/officecli',
      outputPath: '/project/blank.xlsx',
      kind: 'xlsx',
      revision: 0,
      operationLog: { version: 2, contentRevision: 0, operations: {} },
      signal: new AbortController().signal
    },
    {
      readRange: async (_context, params) => {
        assert.deepEqual(params, {})
        overviewReads += 1
        return {
          revision: 0,
          sheets: [{ name: 'Sheet1', usedRange: null, rowCount: 0, columnCount: 0 }],
          complete: false,
          truncated: false,
          hint: 'overview',
          limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
        }
      },
      readDocxSnapshot: async () => {
        throw new Error('unused')
      },
      readPptxSnapshot: async () => {
        throw new Error('unused')
      },
      releaseTransient: async () => undefined
    }
  )
  assert.equal(overviewReads, 1)
  assert.deepEqual(result.checks, [{ name: 'xlsx_content', status: 'passed', sampled: 0 }])
})

test('checks keep the latest stable target and ignore newer non-content operations', async () => {
  const current = operationLogWithCellWrite()
  const formats = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [
      `format-${index}`,
      {
        digest: String(index + 1).repeat(64),
        status: 'succeeded' as const,
        createdAt: `2026-10-05T13:0${index}:00.000Z`,
        receipt: {
          ok: true as const,
          value: {
            applied: true as const,
            saved: true,
            revision: 4,
            sheet: 'Sheet1',
            range: 'A1:A2',
            rowCount: 2,
            columnCount: 1,
            changedCells: 2,
            appliedFormat: { bold: true },
            previewConfirmed: true
          }
        }
      }
    ])
  )
  const operationLog: OfficeOperationLogState = {
    ...current,
    operations: {
      ...current.operations,
      older: {
        digest: 'd'.repeat(64),
        status: 'succeeded',
        createdAt: '2026-10-05T13:00:00.000Z',
        receipt: {
          ok: true,
          value: {
            applied: true,
            saved: true,
            revision: 3,
            sheet: 'Sheet1',
            cell: 'B2',
            before: null,
            after: '旧值',
            previewConfirmed: true
          }
        }
      },
      ...formats
    }
  }
  const result = await runOfficeDeliveryChecks(
    {
      artifactId: 'artifact-1',
      binaryPath: '/officecli',
      outputPath: '/project/final.xlsx',
      kind: 'xlsx',
      revision: 4,
      operationLog,
      signal: new AbortController().signal
    },
    {
      readRange: async (context) => ({
        revision: context.revision,
        sheet: 'Sheet1',
        range: 'B2',
        cells: [{ ref: 'B2', value: '完成', valueType: 'string' }],
        rowCount: 1,
        columnCount: 1,
        complete: true,
        truncated: false,
        limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
      }),
      readDocxSnapshot: async () => {
        throw new Error('unused')
      },
      readPptxSnapshot: async () => {
        throw new Error('unused')
      },
      releaseTransient: async () => undefined
    }
  )
  assert.equal(result.checks[0]?.sampled, 1)
})

test('a content mismatch still releases the transient output resident', async () => {
  let released = false
  await assert.rejects(
    runOfficeDeliveryChecks(
      {
        artifactId: 'artifact-1',
        binaryPath: '/officecli',
        outputPath: '/project/final.xlsx',
        kind: 'xlsx',
        revision: 4,
        operationLog: operationLogWithCellWrite(),
        signal: new AbortController().signal
      },
      {
        readRange: async (context) => ({
          revision: context.revision,
          sheet: 'Sheet1',
          range: 'B2',
          cells: [{ ref: 'B2', value: '错误内容', valueType: 'string' }],
          rowCount: 1,
          columnCount: 1,
          complete: true,
          truncated: false,
          limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
        }),
        readDocxSnapshot: async () => {
          throw new Error('unused')
        },
        readPptxSnapshot: async () => {
          throw new Error('unused')
        },
        releaseTransient: async () => {
          released = true
        }
      }
    ),
    { code: 'delivery_check_failed' }
  )
  assert.equal(released, true)
})

test('page-count or resident-release failures are delivery check failures', async () => {
  const base = {
    artifactId: 'artifact-1',
    binaryPath: '/officecli',
    outputPath: '/project/final.pptx',
    kind: 'pptx' as const,
    revision: 0,
    expectedPageCount: 2,
    operationLog: { version: 2 as const, contentRevision: 0, operations: {} },
    signal: new AbortController().signal
  }
  const dependencies = {
    readRange: async (): Promise<never> => {
      throw new Error('unused')
    },
    readDocxSnapshot: async (): Promise<never> => {
      throw new Error('unused')
    },
    readPptxSnapshot: async () => ({ slideCount: 1, slides: [] }),
    releaseTransient: async () => undefined
  }
  await assert.rejects(runOfficeDeliveryChecks(base, dependencies), {
    code: 'delivery_check_failed'
  })
  await assert.rejects(
    runOfficeDeliveryChecks(
      { ...base, expectedPageCount: 1 },
      { ...dependencies, releaseTransient: async () => Promise.reject(new Error('close failed')) }
    ),
    { code: 'delivery_check_failed' }
  )
})

function operationLogWithCellWrite(): OfficeOperationLogState {
  return {
    version: 2,
    contentRevision: 4,
    operations: {
      'write-1': {
        digest: 'a'.repeat(64),
        status: 'succeeded',
        createdAt: '2026-10-05T12:00:00.000Z',
        receipt: {
          ok: true,
          value: {
            applied: true,
            saved: true,
            revision: 4,
            sheet: 'Sheet1',
            cell: 'B2',
            before: null,
            after: '完成',
            previewConfirmed: true
          }
        }
      }
    }
  }
}
