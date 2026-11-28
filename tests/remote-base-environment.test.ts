import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveRemoteBaseEnvironment } from '../src/main/agent/remote-runtime/base-environment'

test('remote base environment keeps declared conda channels and dependencies', async () => {
  const resolved = await resolveRemoteBaseEnvironment('phi:python@1', undefined, '/unused-agent')
  assert.deepEqual(resolved.channels, ['conda-forge'])
  assert.ok(resolved.packages.includes('python=3.12'))
  assert.ok(resolved.packages.includes('pandas'))

  const rResolved = await resolveRemoteBaseEnvironment('phi:r@1', undefined, '/unused-agent')
  assert.deepEqual(rResolved.channels, ['conda-forge'])
  assert.ok(rResolved.packages.includes('r-base=4.4'))
  assert.ok(rResolved.packages.includes('r-tidyverse'))
})

test('remote base environment rejects source packages instead of silently dropping them', async () => {
  const environmentsDir = mkdtempSync(join(tmpdir(), 'phi-remote-base-env-'))
  try {
    cpSync(join(process.cwd(), 'tests/fixtures/envs/r-source'), join(environmentsDir, 'phi-r'), {
      recursive: true
    })
    await assert.rejects(
      resolveRemoteBaseEnvironment('phi:r@1', undefined, '/unused-agent', { environmentsDir }),
      /additional source packages|No local fallback was used/u
    )
  } finally {
    rmSync(environmentsDir, { recursive: true, force: true })
  }
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
