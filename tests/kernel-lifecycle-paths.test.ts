import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { deriveKernelSocketPaths } from '../src/kernel/lifecycle/paths'

type PathVector = {
  runtimeRoot: string
  kernelVersion: string
  stem: string
}

const fixturePath = fileURLToPath(
  new URL('./fixtures/kernel-lifecycle-paths.json', import.meta.url)
)
const vectors = JSON.parse(readFileSync(fixturePath, 'utf8')) as PathVector[]

test('kernel socket path derivation matches the helper golden vectors', () => {
  for (const vector of vectors) {
    const result = deriveKernelSocketPaths(vector.runtimeRoot, vector.kernelVersion, 501)
    assert.deepEqual(result, {
      directory: '/tmp/phi-k-501',
      stem: vector.stem,
      socketPath: path.join('/tmp/phi-k-501', `${vector.stem}.sock`),
      tokenFilePath: path.join('/tmp/phi-k-501', `${vector.stem}.token`),
      lockFilePath: path.join('/tmp/phi-k-501', `${vector.stem}.lock`)
    })
  }
})
