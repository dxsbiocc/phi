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
    /源码包|没有回退到本机/u
  )
})

test('remote base environment rejects unroutable project and unbound plugin references', async () => {
  await assert.rejects(
    resolveRemoteBaseEnvironment('project:analysis', undefined, '/local/anchor'),
    /无法安全读取本机项目级环境|没有回退/u
  )
  await assert.rejects(
    resolveRemoteBaseEnvironment('plugin:python', undefined, '/local/anchor'),
    /对应插件专家会话|没有回退/u
  )
})
