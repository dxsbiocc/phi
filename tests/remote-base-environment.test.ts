import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveRemoteBaseEnvironment } from '../src/main/agent/remote-runtime/base-environment'

test('remote base environment keeps declared conda channels and dependencies', async () => {
  const resolved = await resolveRemoteBaseEnvironment('phi:python@1', undefined, '/unused-agent')
  assert.deepEqual(resolved.channels, ['conda-forge', 'bioconda'])
  assert.ok(resolved.packages.includes('python=3.12'))
  assert.ok(resolved.packages.includes('bbknn'))
})

test('remote base environment rejects source packages instead of silently dropping them', async () => {
  await assert.rejects(
    resolveRemoteBaseEnvironment('phi:r@1', undefined, '/unused-agent'),
    /additional source packages|No local fallback was used/u
  )
})

test('remote base environment rejects unroutable project and unbound plugin references', async () => {
  await assert.rejects(
    resolveRemoteBaseEnvironment('project:analysis', undefined, '/local/anchor'),
    /cannot safely read local project environment declarations|No fallback to the local project directory/u
  )
  await assert.rejects(
    resolveRemoteBaseEnvironment('plugin:python', undefined, '/local/anchor'),
    /corresponding plugin specialist session|No local fallback was used/u
  )
})
