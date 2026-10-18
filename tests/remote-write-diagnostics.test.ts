import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildRemoteWriteProbeScript,
  classifyRemoteWriteFailure,
  diagnoseRemoteCommandFailure,
  parseRemoteWriteProbe
} from '../src/main/agent/remote-runtime/write-diagnostics'

function executeProbe(script: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const stdout = execFileSync('sh', ['-c', script], { encoding: 'utf8' })
  return Promise.resolve({ stdout, stderr: '', code: 0 })
}

test('remote write failure classification recognizes quota, space, and read-only errors', () => {
  assert.equal(classifyRemoteWriteFailure('Disk quota exceeded'), 'quota-exceeded')
  assert.equal(classifyRemoteWriteFailure('write failed: EDQUOT'), 'quota-exceeded')
  assert.equal(classifyRemoteWriteFailure('No space left on device'), 'no-space')
  assert.equal(classifyRemoteWriteFailure('filesystem is read-only (EROFS)'), 'read-only')
  assert.equal(classifyRemoteWriteFailure('permission denied'), 'other')
})

test('injected write probes classify capacity failures and remove their directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-write-probe-'))
  try {
    const before = readdirSync(root)
    for (const kind of ['quota-exceeded', 'no-space', 'read-only'] as const) {
      const output = execFileSync('sh', ['-c', buildRemoteWriteProbeScript(root, kind)], {
        encoding: 'utf8'
      })
      const diagnosis = parseRemoteWriteProbe(output, '', 0)

      assert.equal(diagnosis.kind, kind)
      assert.match(diagnosis.message, /Settings → Remote Hosts/u)
      assert.deepEqual(readdirSync(root), before)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a silent command failure runs the write probe and returns quota guidance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-write-diagnosis-'))
  try {
    const diagnosis = await diagnoseRemoteCommandFailure(
      { code: 1, stdout: '', stderr: '' },
      root,
      executeProbe,
      'quota-exceeded'
    )

    assert.equal(diagnosis?.kind, 'quota-exceeded')
    assert.match(diagnosis?.message ?? '', /Disk space or the file count quota is exhausted/u)
    assert.deepEqual(readdirSync(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an explicit solver failure does not run a write probe', async () => {
  let probes = 0
  const diagnosis = await diagnoseRemoteCommandFailure(
    { code: 1, stdout: 'solver failed: package is unsatisfiable', stderr: '' },
    '/runtime',
    async () => {
      probes += 1
      return { stdout: '', stderr: '', code: 1 }
    }
  )

  assert.equal(diagnosis, undefined)
  assert.equal(probes, 0)
})

test('a failed best-effort probe does not mask the original command failure', async () => {
  const diagnosis = await diagnoseRemoteCommandFailure(
    { code: 1, stdout: '', stderr: '' },
    '/runtime',
    async () => {
      throw new Error('probe transport failed')
    }
  )

  assert.equal(diagnosis, undefined)
})
