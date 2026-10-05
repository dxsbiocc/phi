import assert from 'node:assert/strict'
import test from 'node:test'

import { runOfficeDeliveryChecks } from '../src/main/agent/office/office-deliver-checks'
import type { OfficeOperationLogState } from '../src/main/agent/office/office-operation-log'

test('delivery warnings reflect the latest revision and final PPTX layout', async () => {
  const operationLog: OfficeOperationLogState = {
    version: 2,
    contentRevision: 2,
    operations: {
      old: operation('2026-10-05T13:00:00.000Z', 1, '很长'.repeat(80), ['text_may_overflow']),
      current: operation('2026-10-05T12:00:00.000Z', 2, '短标题', [])
    }
  }
  const result = await runOfficeDeliveryChecks(
    {
      artifactId: 'artifact-1',
      binaryPath: '/officecli',
      outputPath: '/project/final.pptx',
      kind: 'pptx',
      revision: 2,
      operationLog,
      signal: new AbortController().signal,
      expectedPageCount: 1
    },
    {
      readRange: async () => {
        throw new Error('unused')
      },
      readDocxSnapshot: async () => {
        throw new Error('unused')
      },
      readPptxSnapshot: async () => ({
        slideCount: 1,
        slides: [
          {
            slideId: '256',
            index: 0,
            title: '短标题',
            elements: [
              {
                elementId: '2',
                path: '/slide[@id=256]/shape[@id=2]',
                cliPath: '/slide[1]/shape[@id=2]',
                kind: 'title',
                text: '短标题',
                editable: true
              }
            ]
          }
        ]
      }),
      releaseTransient: async () => undefined
    }
  )

  assert.equal(result.checks[0]?.sampled, 1)
  assert.deepEqual(result.warnings, [])
})

function operation(
  createdAt: string,
  revision: number,
  after: string,
  warnings: string[]
): OfficeOperationLogState['operations'][string] {
  return {
    digest: String(revision).repeat(64),
    status: 'succeeded',
    createdAt,
    receipt: {
      ok: true,
      value: {
        applied: true,
        saved: true,
        revision,
        slideId: '256',
        elementId: '2',
        path: '/slide[@id=256]/shape[@id=2]',
        index: 0,
        kind: 'title',
        before: '旧标题',
        after,
        previewConfirmed: true,
        ...(warnings.length > 0 ? { layoutWarning: 'text_may_overflow', warnings } : {})
      }
    }
  }
}
