import assert from 'node:assert/strict'
import test from 'node:test'

import { pickTerminalScript } from '../src/main/terminal/terminal-host-process'

const asarWorker = '/App.app/Contents/Resources/app.asar/out/main/terminal/terminal-worker.ts'
const unpackedWorker =
  '/App.app/Contents/Resources/app.asar.unpacked/out/main/terminal/terminal-worker.ts'

test('packaged worker path prefers app.asar.unpacked even though Electron reports the asar copy', () => {
  // Inside Electron both paths "exist"; only the unpacked one is readable by Bun.
  const exists = (path: string): boolean => path === asarWorker || path === unpackedWorker
  assert.equal(pickTerminalScript([asarWorker], exists), unpackedWorker)
})

test('worker path outside an asar archive is used as is', () => {
  const plain = '/repo/out/main/terminal/terminal-worker.ts'
  assert.equal(
    pickTerminalScript(['/missing.ts', plain], (path) => path === plain),
    plain
  )
})

test('falls back to the last candidate when nothing exists', () => {
  assert.equal(
    pickTerminalScript(['/a.ts', '/b.ts'], () => false),
    '/b.ts'
  )
})
