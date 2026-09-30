import assert from 'node:assert/strict'
import test from 'node:test'

import {
  confirmedEnvironmentBuild,
  environmentBuildQuestion,
  formatDownloadBytes
} from '../src/main/agent/content/environment-build-prompt'

test('the build question names the skill, the environment, and the remaining download', () => {
  assert.equal(
    environmentBuildQuestion({
      runtimeSessionId: 's',
      ref: 'phi:python@1',
      skill: 'scanpy',
      estimate: {
        packages: 328,
        cachedPackages: 12,
        downloadBytes: 539211500,
        remainingBytes: 500 * 1024 * 1024
      }
    }),
    '技能 scanpy 需要环境 phi:python@1，尚未安装。现在构建吗？需下载约 500 MB（共 328 个包，已缓存 12）'
  )
  assert.match(
    environmentBuildQuestion({
      runtimeSessionId: 's',
      ref: 'phi:python@1',
      skill: 'scanpy',
      estimate: { packages: 3, cachedPackages: 0 }
    }),
    /下载大小未知$/
  )
})

test('an agent build question names the agent instead of a skill', () => {
  assert.equal(
    environmentBuildQuestion({
      runtimeSessionId: 's',
      ref: 'phi:python@1',
      agent: 'Scanpy',
      estimate: {
        packages: 328,
        cachedPackages: 12,
        downloadBytes: 539211500,
        remainingBytes: 500 * 1024 * 1024
      }
    }),
    '智能体 Scanpy 需要环境 phi:python@1，尚未安装。现在构建吗？需下载约 500 MB（共 328 个包，已缓存 12）'
  )
})

test('download sizes use MB below 1 GB and one decimal below 10', () => {
  assert.equal(formatDownloadBytes(1.5 * 1024 ** 3), '1.5 GB')
  assert.equal(formatDownloadBytes(12 * 1024 ** 3), '12 GB')
  assert.equal(formatDownloadBytes(2.25 * 1024 ** 2), '2.3 MB')
})

test('only an explicit 现在构建 answer confirms the build', () => {
  const answer = (value: string | null): unknown => ({
    requestId: 'r',
    answers: [{ questionIndex: 0, question: 'q', kind: 'option', answer: value }]
  })
  assert.equal(confirmedEnvironmentBuild(answer('现在构建')), true)
  assert.equal(confirmedEnvironmentBuild(answer('暂不')), false)
  assert.equal(confirmedEnvironmentBuild(answer(null)), false)
  assert.equal(confirmedEnvironmentBuild({ requestId: 'r', answers: [], cancelled: true }), false)
  assert.equal(confirmedEnvironmentBuild({ error: 'no window', answers: [] }), false)
  assert.equal(confirmedEnvironmentBuild(undefined), false)
})
