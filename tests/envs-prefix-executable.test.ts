import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { prefixExecutable } from '../src/main/agent/envs/prefix-executable'

test('Unix prefixes keep executables in bin/', () => {
  assert.equal(prefixExecutable('/env', 'jupyter', 'darwin'), join('/env', 'bin', 'jupyter'))
  assert.equal(prefixExecutable('/env', 'python', 'linux'), join('/env', 'bin', 'python'))
})

test('Windows prefixes prefer python.exe at the root and jupyter.exe in Scripts/', () => {
  assert.equal(prefixExecutable('C:\\env', 'python', 'win32'), join('C:\\env', 'python.exe'))
  assert.equal(
    prefixExecutable('C:\\env', 'jupyter', 'win32'),
    join('C:\\env', 'Scripts', 'jupyter.exe')
  )
  assert.equal(prefixExecutable('C:\\env', 'R', 'win32'), join('C:\\env', 'Scripts', 'R.exe'))
})

test('Windows prefixes use the first existing conda location', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'phi-prefix-exe-'))
  try {
    mkdirSync(join(prefix, 'Scripts'), { recursive: true })
    mkdirSync(join(prefix, 'Library', 'bin'), { recursive: true })
    writeFileSync(join(prefix, 'Scripts', 'jupyter.exe'), 'MZ')
    writeFileSync(join(prefix, 'Library', 'bin', 'R.exe'), 'MZ')
    writeFileSync(join(prefix, 'python.exe'), 'MZ')
    assert.equal(prefixExecutable(prefix, 'python', 'win32'), join(prefix, 'python.exe'))
    assert.equal(
      prefixExecutable(prefix, 'jupyter', 'win32'),
      join(prefix, 'Scripts', 'jupyter.exe')
    )
    assert.equal(prefixExecutable(prefix, 'R', 'win32'), join(prefix, 'Library', 'bin', 'R.exe'))
  } finally {
    rmSync(prefix, { recursive: true, force: true })
  }
})
