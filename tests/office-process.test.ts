import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  closeOfficeResident,
  createBlankOfficeWorkbook,
  forceTerminateTransientOfficeProcesses,
  inspectOfficeDocument,
  parseDocumentInspection,
  parseWorkbookDimensions,
  releaseTransientOfficeResident
} from '../src/main/agent/office/office-process'

test('workbook inspection finds the largest used row and column across sheets', () => {
  assert.deepEqual(
    parseWorkbookDimensions({
      success: true,
      data: {
        sheets: [
          { name: 'Sheet1', rows: [{ row: 20, cells: { A20: 'x', J20: 'y' } }] },
          { name: '汇总', rows: [{ row: 8, cells: { C8: 'z' } }] }
        ]
      }
    }),
    { rows: 20, columns: 10 }
  )
})

test('DOCX inspection counts paragraphs instead of trusting totalElements and keeps sample text', () => {
  assert.deepEqual(
    parseDocumentInspection({
      success: true,
      data: {
        totalElements: 3,
        elements: [
          { type: 'paragraph', path: '/body/p[@paraId=00100000]', text: '第一段 & <Phi>' },
          { type: 'table', path: '/body/tbl[1]', text: '表格' },
          { type: 'paragraph', path: '/body/p[@paraId=00100002]', text: '第二段' }
        ]
      }
    }),
    { paragraphs: 2, sampleTexts: ['第一段 & <Phi>', '第二段'] }
  )
})

test('DOCX inspection accepts a structurally empty document whose total includes sectPr', () => {
  assert.deepEqual(
    parseDocumentInspection({ success: true, data: { totalElements: 1, elements: [] } }),
    { paragraphs: 0, sampleTexts: [] }
  )
})

test('PPTX inspection uses get root, validates, and releases its transient resident', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office process pptx inspect '))
  const binaryPath = join(root, 'officecli')
  const callsPath = join(root, 'calls.txt')
  const draftPath = join(root, 'slides.pptx')
  writeFileSync(
    binaryPath,
    [
      '#!/bin/sh',
      `printf '%s\n' "$*" >> '${callsPath}'`,
      'if [ "$1" = "get" ]; then',
      '  printf \'%s\\n\' \'{"success":true,"data":{"results":[{"path":"/","type":"presentation","childCount":0,"children":[]}]}}\'',
      'else',
      "  printf '%s\\n' '{\"success\":true}'",
      'fi'
    ].join('\n')
  )
  chmodSync(binaryPath, 0o755)
  try {
    assert.deepEqual(await inspectOfficeDocument(binaryPath, draftPath, 'pptx'), { slides: 0 })
    assert.deepEqual(readFileSync(callsPath, 'utf8').trim().split('\n'), [
      `get ${draftPath} / --json`,
      `validate ${draftPath} --json`,
      `close ${draftPath} --json`
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blank workbook creation uses the controlled create command and resident flush environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office process create '))
  const binaryPath = join(root, 'officecli')
  const callsPath = join(root, 'calls.txt')
  const draftPath = join(root, 'draft with spaces.xlsx')
  writeFileSync(
    binaryPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*|$OFFICECLI_SKIP_UPDATE|$OFFICECLI_RESIDENT_FLUSH" > '${callsPath}'`,
      "printf '%s\\n' '{\"success\":true}'"
    ].join('\n')
  )
  chmodSync(binaryPath, 0o755)
  try {
    await createBlankOfficeWorkbook(binaryPath, draftPath)
    assert.equal(readFileSync(callsPath, 'utf8').trim(), `create ${draftPath} --json|1|each`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed create attempts to close a possibly started resident before rejecting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office process failed create '))
  const binaryPath = join(root, 'officecli')
  const callsPath = join(root, 'calls.txt')
  const draftPath = join(root, 'draft.xlsx')
  writeFileSync(
    binaryPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$1" >> '${callsPath}'`,
      'if [ "$1" = "create" ]; then exit 1; fi',
      "printf '%s\\n' '{\"success\":true}'"
    ].join('\n')
  )
  chmodSync(binaryPath, 0o755)
  try {
    await assert.rejects(createBlankOfficeWorkbook(binaryPath, draftPath), /create失败/)
    assert.deepEqual(readFileSync(callsPath, 'utf8').trim().split('\n'), ['create', 'close'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function fakeOfficeCli(root: string): string {
  const binaryPath = join(root, 'officecli')
  writeFileSync(binaryPath, ['#!/bin/sh', "printf '%s\\n' '{\"success\":true}'"].join('\n'))
  chmodSync(binaryPath, 0o755)
  return binaryPath
}

const ARTIFACT = {
  artifactId: 'a1',
  sessionId: 's1',
  projectId: null,
  origin: 'blank',
  draftPath: '/tmp/never-opened.xlsx'
} as unknown as Parameters<typeof closeOfficeResident>[1]

test('closing a resident waits until its process has exited, because close returns before the final flush', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office process close wait '))
  try {
    let polls = 0
    const kills: string[] = []
    await closeOfficeResident(fakeOfficeCli(root), ARTIFACT, 4242, {
      isAlive: () => (polls += 1) <= 3,
      kill: (_pid, signal) => kills.push(signal),
      sleep: async () => undefined
    })
    assert.ok(polls >= 4, 'the pid must be polled until it is gone')
    assert.deepEqual(kills, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a resident that ignores close is terminated, and one that survives SIGTERM is reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office process close term '))
  try {
    const binaryPath = fakeOfficeCli(root)
    let terminated = false
    const kills: string[] = []
    await closeOfficeResident(binaryPath, ARTIFACT, 4242, {
      isAlive: () => !terminated,
      kill: (_pid, signal) => {
        kills.push(signal)
        terminated = true
      },
      sleep: async () => undefined,
      exitTimeoutMs: 0
    })
    assert.deepEqual(kills, ['SIGTERM'])

    const survivorKills: string[] = []
    await assert.rejects(
      closeOfficeResident(binaryPath, ARTIFACT, 4242, {
        isAlive: () => true,
        kill: (_pid, signal) => survivorKills.push(signal),
        sleep: async () => undefined,
        exitTimeoutMs: 0,
        termGraceMs: 0
      }),
      /未能退出/
    )
    assert.deepEqual(survivorKills, ['SIGTERM'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('closing a resident that is already gone, or whose pid is unknown, does not wait', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office process close gone '))
  try {
    const binaryPath = fakeOfficeCli(root)
    let polls = 0
    await closeOfficeResident(binaryPath, ARTIFACT, 4242, {
      isAlive: () => {
        polls += 1
        return false
      },
      sleep: async () => undefined
    })
    assert.equal(polls, 1)
    await closeOfficeResident(binaryPath, ARTIFACT, 0, {
      isAlive: () => {
        throw new Error('must not poll an unknown pid')
      }
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('releasing a transient resident closes it and waits until nothing holds the file', async () => {
  const commands: string[][] = []
  let polls = 0
  await releaseTransientOfficeResident('/officecli', '/tmp/copy.tmp.xlsx', {
    run: async (_binaryPath, args) => {
      commands.push([...args])
      return { exitCode: 0, stdout: '{}', stderr: '', timedOut: false, truncated: false }
    },
    owners: async () => ((polls += 1) <= 2 ? [4242] : []),
    sleep: async () => undefined
  })
  assert.deepEqual(commands, [['close', '/tmp/copy.tmp.xlsx', '--json']])
  assert.ok(polls >= 3)

  // `close` fails when no resident was started; that is not an error here.
  await releaseTransientOfficeResident('/officecli', '/tmp/copy.tmp.xlsx', {
    run: async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false, truncated: false }),
    owners: async () => [],
    sleep: async () => undefined
  })
})

test('a transient resident that keeps the file after close is terminated, and reported if it survives', async () => {
  const closed = async (): Promise<never> => {
    throw new Error('unused')
  }
  void closed
  const base = {
    run: async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false, truncated: false }),
    sleep: async () => undefined,
    timeoutMs: 0,
    termGraceMs: 0
  }
  let killed = false
  const kills: Array<[number, string]> = []
  await releaseTransientOfficeResident('/officecli', '/tmp/c.tmp.xlsx', {
    ...base,
    owners: async () => (killed ? [] : [4242]),
    kill: (pid, signal) => {
      kills.push([pid, signal])
      killed = true
    }
  })
  assert.deepEqual(kills, [[4242, 'SIGTERM']])

  await assert.rejects(
    releaseTransientOfficeResident('/officecli', '/tmp/c.tmp.xlsx', {
      ...base,
      owners: async () => [4242],
      kill: () => undefined
    }),
    /未能释放/
  )
})

test('forced import cleanup waits for the file owner and escalates before artifact removal', async () => {
  let alive = true
  const kills: Array<[number, string]> = []
  await forceTerminateTransientOfficeProcesses('/tmp/import.xlsx', [4242], {
    owners: async () => (alive ? [4242] : []),
    isAlive: () => alive,
    kill: (pid, signal) => {
      kills.push([pid, signal])
      if (signal === 'SIGKILL') alive = false
    },
    sleep: async () => undefined,
    termGraceMs: 0,
    killGraceMs: 10
  })

  assert.deepEqual(kills, [
    [4242, 'SIGTERM'],
    [4242, 'SIGKILL']
  ])
})
