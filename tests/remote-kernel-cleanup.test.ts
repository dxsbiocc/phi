import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { cleanupOldKernelsCommand } from '../src/main/agent/engine/kernel-client/remote/commands'

const HOUR = 60 * 60
const hash = (digit: string): string => digit.repeat(64)

function kernelDir(root: string, version: string, name: string, ageSeconds: number): string {
  const dir = join(root, version, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'phi-kernel'), 'binary')
  const when = Date.now() / 1000 - ageSeconds
  utimesSync(dir, when, when)
  return dir
}

test('old kernel cleanup keeps the current, previous, running and recent builds only', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'phi-kernel-cleanup-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const kernelRoot = join(base, 'kernel')
  const current = kernelDir(kernelRoot, '0.1.1', hash('a'), 0)
  const uploading = kernelDir(kernelRoot, '0.1.1', hash('b'), 60)
  const previous = kernelDir(kernelRoot, '0.1.0', hash('c'), 2 * HOUR)
  const older = kernelDir(kernelRoot, '0.1.0', hash('d'), 5 * HOUR)
  const running = kernelDir(kernelRoot, '0.1.0', hash('e'), 9 * HOUR)
  const oldest = kernelDir(kernelRoot, '0.0.9', hash('f'), 30 * HOUR)
  const foreign = kernelDir(kernelRoot, '0.1.0', 'not-a-kernel-build', 40 * HOUR)
  const linked = join(kernelRoot, '0.1.0', hash('1'))
  symlinkSync(oldest, linked)
  const proc = join(base, 'proc')
  mkdirSync(join(proc, '4242'), { recursive: true })
  symlinkSync(join(running, 'phi-kernel'), join(proc, '4242', 'exe'))

  const result = spawnSync(
    'sh',
    ['-c', cleanupOldKernelsCommand({ kernelRoot, directory: current }, proc)],
    { encoding: 'utf8' }
  )

  assert.equal(result.status, 0, result.stderr)
  for (const kept of [current, uploading, previous, running, foreign])
    assert.ok(existsSync(kept), kept)
  assert.ok(lstatSync(linked).isSymbolicLink())
  assert.equal(existsSync(older), false)
  assert.equal(existsSync(oldest), false)
  assert.deepEqual(result.stdout.trim().split('\n').sort(), [
    `removed ${hash('d')}`,
    `removed ${hash('f')}`
  ])
  assert.deepEqual(readdirSync(join(kernelRoot, '0.0.9')), [])
})

test('old kernel cleanup does nothing when the kernel root is missing', () => {
  const result = spawnSync(
    'sh',
    [
      '-c',
      cleanupOldKernelsCommand({
        kernelRoot: '/nonexistent/phi-kernel-root',
        directory: '/nonexistent/phi-kernel-root/0.1.0/x'
      })
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
})
