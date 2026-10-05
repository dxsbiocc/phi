import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { OfficeCliRunResult } from '../src/main/agent/office/office-driver'
import {
  createOfficeImportBatches,
  OfficeImportWorkbookDriver,
  OfficeImportWorkbookVerifier
} from '../src/main/agent/office/office-import-driver'

function successful(value: unknown): OfficeCliRunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: '',
    timedOut: false,
    truncated: false
  }
}

describe('Office import driver', () => {
  it('builds explicit typed commands, never formulas, and skips semantic empty cells', () => {
    const batches = createOfficeImportBatches('Sheet1', [['=SUM(A1)', '007', 3.5, '']])
    const commands = batches.flat()

    assert.equal(commands.length, 3)
    assert.deepEqual(commands, [
      { command: 'set', path: '/Sheet1/A1', props: { value: '=SUM(A1)', type: 'string' } },
      { command: 'set', path: '/Sheet1/B1', props: { value: '007', type: 'string' } },
      { command: 'set', path: '/Sheet1/C1', props: { value: 3.5, type: 'number' } }
    ])
    assert.equal(JSON.stringify(commands).includes('formula'), false)
  })

  it('splits batches at the import-specific count and byte boundaries', () => {
    const values = Array.from({ length: 3 }, () =>
      Array.from({ length: 1_000 }, (_, index) => `value-${index}`)
    )
    const batches = createOfficeImportBatches('Sheet1', values)

    assert.ok(batches.length >= 2)
    assert.equal(batches.flat().length, 3_000)
    assert.ok(batches.every((batch) => batch.length <= 2_000))
    assert.ok(
      batches.every((batch) => Buffer.byteLength(JSON.stringify(batch), 'utf8') <= 256 * 1024)
    )
  })

  it('reads every cell back and rejects formula coercion or value mismatch', async () => {
    const values = [
      ['header', '=1+2'],
      ['中文', 42]
    ] as const
    const cells = [
      { path: '/Sheet1/A1', text: 'header', format: { type: 'String' } },
      { path: '/Sheet1/B1', text: '=1+2', format: { type: 'String' } },
      { path: '/Sheet1/A2', text: '中文', format: { type: 'String' } },
      { path: '/Sheet1/B2', text: '42', format: { type: 'Number' } }
    ]
    const calls: readonly string[][] = []
    const verifier = new OfficeImportWorkbookVerifier({
      run: async (_binaryPath: string, args: readonly string[]) => {
        ;(calls as string[][]).push([...args])
        return successful({ success: true, data: { results: [{ children: cells }] } })
      }
    })

    await verifier.verify('officecli', '/tmp/import.xlsx', 'Sheet1', values)
    assert.deepEqual(calls, [['get', '/tmp/import.xlsx', '/Sheet1/A1:B2', '--json']])

    const formulaVerifier = new OfficeImportWorkbookVerifier({
      run: async () =>
        successful({
          success: true,
          data: {
            results: [
              {
                children: cells.map((cell, index) =>
                  index === 1
                    ? {
                        ...cell,
                        text: '3',
                        format: { type: 'Number', formula: '1+2', computedValue: '3' }
                      }
                    : cell
                )
              }
            ]
          }
        })
    })
    await assert.rejects(
      formulaVerifier.verify('officecli', '/tmp/import.xlsx', 'Sheet1', values),
      { code: 'import_verification_failed' }
    )
  })

  it('propagates cancellation into an in-flight CLI batch and reports its resident pid', async () => {
    const controller = new AbortController()
    let batchStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      batchStarted = resolve
    })
    const residentPids: number[] = []
    const driver = new OfficeImportWorkbookDriver({
      owners: async () => [999],
      run: async (_binaryPath, args, options) => {
        if (args[0] === 'create') return successful({ success: true })
        batchStarted?.()
        return new Promise((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () => resolve({ ...successful({ success: false }), spawnError: 'aborted' }),
            { once: true }
          )
        })
      }
    })
    const preparing = driver.prepare(
      'officecli',
      { draftPath: '/tmp/import.xlsx', sheet: 'Sheet1', values: [['value']], rows: 1, columns: 1 },
      {
        signal: controller.signal,
        onResidentPid: (pid) => residentPids.push(pid)
      }
    )
    await started
    controller.abort()

    await assert.rejects(preparing, { code: 'import-cancelled' })
    assert.deepEqual(residentPids, [999])
  })
})
