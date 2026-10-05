import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureOfficeDocxBefore,
  type OfficeDocxOperation,
  type OfficeDocxSnapshot,
  validateOfficeDocxOperation
} from '../src/main/agent/office/office-docx-contract'
import type { OfficeCliRunResult } from '../src/main/agent/office/office-driver'
import { OfficeDocxWriter } from '../src/main/agent/office/office-docx-write'
import {
  OfficeWriteError,
  type OfficeWriteContext
} from '../src/main/agent/office/office-write-contract'

test('DOCX operations accept bounded plain text and normalize stable paragraph ids', () => {
  assert.deepEqual(
    validateOfficeDocxOperation({
      type: 'add_paragraph',
      text: '正文\t补充',
      position: { after: 'a1b2c3d4' }
    }),
    {
      type: 'add_paragraph',
      text: '正文\t补充',
      position: { after: 'A1B2C3D4' }
    }
  )
  assert.deepEqual(
    validateOfficeDocxOperation({
      type: 'set_paragraph_text',
      paraId: '0010abcd',
      text: '替换',
      expectedText: '原文'
    }),
    {
      type: 'set_paragraph_text',
      paraId: '0010ABCD',
      text: '替换',
      expectedText: '原文'
    }
  )
})

test('DOCX operation validation rejects line breaks, controls, empty text, and unstable ids', () => {
  const invalid: unknown[] = [
    { type: 'add_paragraph', text: '' },
    { type: 'add_paragraph', text: 'a\nb' },
    { type: 'add_paragraph', text: 'a\rb' },
    { type: 'add_paragraph', text: 'a\u0000b' },
    { type: 'add_paragraph', text: 'a\u0085b' },
    { type: 'add_paragraph', text: 'x'.repeat(4_001) },
    { type: 'add_paragraph', text: 'x', position: { after: '1' } },
    { type: 'set_paragraph_text', paraId: '0010000Z', text: 'x' },
    { type: 'set_paragraph_text', paraId: '00100000', text: 'x', extra: true }
  ]
  for (const value of invalid) {
    assert.throws(
      () => validateOfficeDocxOperation(value),
      (error) => error instanceof OfficeWriteError && error.code === 'invalid_value'
    )
  }
})

test('DOCX writer reads direct paragraphs and adds at the document end', async () => {
  const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = []
  const writer = new OfficeDocxWriter({
    run: async (_binaryPath, args, options) => {
      calls.push({ args, env: options?.env })
      if (args[0] === 'get') return cliJson(body([paragraph('00100000', '第一段')]))
      return cliJson({
        success: true,
        data: 'Added paragraph at /body/p[@paraId=00100002]',
        message: 'Added paragraph at /body/p[@paraId=00100002]'
      })
    }
  })
  const operation = validateOfficeDocxOperation({ type: 'add_paragraph', text: '第二段' })

  const snapshot = await writer.read(writeContext())
  const receipt = await writer.apply(writeContext(), operation, snapshot)

  assert.deepEqual(snapshot, {
    paragraphs: [{ paraId: '00100000', index: 0, text: '第一段', style: 'Normal', editable: true }],
    paragraphCount: 1
  })
  assert.deepEqual(captureOfficeDocxBefore(operation, snapshot), {
    type: 'add_paragraph',
    paragraphCount: 1,
    previousParaId: '00100000'
  })
  assert.deepEqual(receipt, {
    type: 'add_paragraph',
    paraId: '00100002',
    path: '/body/p[@paraId=00100002]'
  })
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['get', '/private/secret.docx', '/body', '--depth', '2', '--json'],
      [
        'add',
        '/private/secret.docx',
        '/body',
        '--type',
        'paragraph',
        '--prop',
        'text=第二段',
        '--json'
      ]
    ]
  )
  assert.equal(calls[1]?.env?.OFFICECLI_RESIDENT_FLUSH, 'each')
})

test('DOCX writer inserts after a stable paragraph path and captures its anchor', async () => {
  const calls: string[][] = []
  const writer = writerReturning(calls, {
    success: true,
    data: 'Added paragraph at /body/p[@paraId=00100009]'
  })
  const { operation, snapshot } = operationSnapshot(
    validateOfficeDocxOperation({
      type: 'add_paragraph',
      text: '插入',
      position: { after: '00100000' }
    }),
    [{ paraId: '00100000', index: 0, text: '原文', editable: true }]
  )

  const receipt = await writer.apply(writeContext(), operation, snapshot)

  assert.deepEqual(captureOfficeDocxBefore(operation, snapshot), {
    type: 'add_paragraph',
    paragraphCount: 1,
    anchorParaId: '00100000',
    previousParaId: '00100000'
  })
  assert.deepEqual(receipt, {
    type: 'add_paragraph',
    paraId: '00100009',
    path: '/body/p[@paraId=00100009]'
  })
  assert.deepEqual(calls[0], [
    'add',
    '/private/secret.docx',
    '/body',
    '--type',
    'paragraph',
    '--after',
    '/body/p[@paraId=00100000]',
    '--prop',
    'text=插入',
    '--json'
  ])
})

test('DOCX writer sets text through a stable path after plainness and stale checks', async () => {
  const calls: string[][] = []
  const writer = writerReturning(calls, {
    success: true,
    data: 'Updated /body/p[@paraId=00100000]: text=新文'
  })
  const { operation, snapshot } = operationSnapshot(
    validateOfficeDocxOperation({
      type: 'set_paragraph_text',
      paraId: '00100000',
      text: '新文',
      expectedText: '原文'
    }),
    [{ paraId: '00100000', index: 0, text: '原文', editable: true }]
  )

  const receipt = await writer.apply(writeContext(), operation, snapshot)

  assert.deepEqual(captureOfficeDocxBefore(operation, snapshot), {
    type: 'set_paragraph_text',
    paraId: '00100000',
    text: '原文'
  })
  assert.deepEqual(receipt, {
    type: 'set_paragraph_text',
    paraId: '00100000',
    path: '/body/p[@paraId=00100000]'
  })
  assert.deepEqual(calls[0], [
    'set',
    '/private/secret.docx',
    '/body/p[@paraId=00100000]',
    '--prop',
    'text=新文',
    '--json'
  ])
})

test('DOCX writer rejects missing, stale, and complex targets before running a mutation', async () => {
  let mutationCalls = 0
  const writer = new OfficeDocxWriter({
    run: async () => {
      mutationCalls += 1
      return cliJson({ success: true })
    }
  })
  const paragraphSnapshot = (text: string, editable: boolean): OfficeDocxSnapshot => ({
    paragraphs: [{ paraId: '00100000', index: 0, text, editable }],
    paragraphCount: 1
  })
  const cases: Array<{
    operation: OfficeDocxOperation
    snapshot: OfficeDocxSnapshot
    code: string
  }> = [
    {
      operation: { type: 'add_paragraph', text: 'x', position: { after: '00100009' } },
      snapshot: paragraphSnapshot('原文', true),
      code: 'paragraph_not_found'
    },
    {
      operation: { type: 'set_paragraph_text', paraId: '00100009', text: 'x' },
      snapshot: paragraphSnapshot('原文', true),
      code: 'paragraph_not_found'
    },
    {
      operation: { type: 'set_paragraph_text', paraId: '00100000', text: 'x' },
      snapshot: paragraphSnapshot('原文', false),
      code: 'paragraph_not_plain'
    },
    {
      operation: {
        type: 'set_paragraph_text',
        paraId: '00100000',
        text: 'x',
        expectedText: '旧文'
      },
      snapshot: paragraphSnapshot('原文', true),
      code: 'stale_target'
    }
  ]
  for (const item of cases) {
    await assert.rejects(writer.apply(writeContext(), item.operation, item.snapshot), {
      code: item.code
    })
  }
  assert.equal(mutationCalls, 0)
})

test('DOCX writer rolls back an added paragraph and restores prior text by receipt paraId', async () => {
  const calls: string[][] = []
  const writer = writerReturning(calls, { success: true, data: 'Restored' })
  const add: OfficeDocxOperation = { type: 'add_paragraph', text: '新增' }
  const set: OfficeDocxOperation = {
    type: 'set_paragraph_text',
    paraId: '00100000',
    text: '新文'
  }

  await writer.restore(
    writeContext(),
    add,
    { type: 'add_paragraph', paragraphCount: 1, previousParaId: '00100000' },
    { type: 'add_paragraph', paraId: '00100002', path: '/body/p[@paraId=00100002]' }
  )
  await writer.restore(
    writeContext(),
    set,
    { type: 'set_paragraph_text', paraId: '00100000', text: '原文' },
    { type: 'set_paragraph_text', paraId: '00100000', path: '/body/p[@paraId=00100000]' }
  )

  assert.deepEqual(calls, [
    ['remove', '/private/secret.docx', '/body/p[@paraId=00100002]', '--json'],
    ['set', '/private/secret.docx', '/body/p[@paraId=00100000]', '--prop', 'text=原文', '--json']
  ])
})

test('DOCX writer maps explicit missing targets without leaking CLI paths', async () => {
  const writer = new OfficeDocxWriter({
    run: async () =>
      cliJson(
        {
          success: false,
          error: { code: 'not_found', error: 'Path not found: /private/secret.docx' }
        },
        1
      )
  })
  const operation: OfficeDocxOperation = {
    type: 'set_paragraph_text',
    paraId: '00100000',
    text: '新文'
  }
  const snapshot: OfficeDocxSnapshot = {
    paragraphs: [{ paraId: '00100000', index: 0, text: '原文', editable: true }],
    paragraphCount: 1
  }

  await assert.rejects(
    writer.apply(writeContext(), operation, snapshot),
    (error) =>
      error instanceof OfficeWriteError &&
      error.code === 'paragraph_not_found' &&
      !error.message.includes('/private/')
  )
})

function writeContext(): OfficeWriteContext {
  return { binaryPath: '/Applications/officecli', draftPath: '/private/secret.docx' }
}

function cliJson(value: unknown, exitCode = 0): OfficeCliRunResult {
  return {
    exitCode,
    stdout: JSON.stringify(value),
    stderr: '',
    timedOut: false,
    truncated: false
  }
}

function body(children: readonly unknown[]): unknown {
  return {
    success: true,
    data: {
      matches: 1,
      results: [{ path: '/body', type: 'body', children }]
    }
  }
}

function paragraph(paraId: string, text: string): Record<string, unknown> {
  return {
    path: `/body/p[@paraId=${paraId}]`,
    type: 'paragraph',
    text,
    style: 'Normal',
    childCount: 1,
    format: { paraId },
    children: [{ type: 'run', text, childCount: 0, format: {}, children: [] }]
  }
}

function operationSnapshot(
  operation: OfficeDocxOperation,
  paragraphs: OfficeDocxSnapshot['paragraphs']
): { operation: OfficeDocxOperation; snapshot: OfficeDocxSnapshot } {
  return { operation, snapshot: { paragraphs, paragraphCount: paragraphs.length } }
}

function writerReturning(calls: string[][], value: unknown): OfficeDocxWriter {
  return new OfficeDocxWriter({
    run: async (_binaryPath, args) => {
      calls.push([...args])
      return cliJson(value)
    }
  })
}
