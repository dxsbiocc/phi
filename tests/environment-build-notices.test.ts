import assert from 'node:assert/strict'
import test from 'node:test'

import type { EnvironmentBuild } from '../src/shared/environmentBuildTypes'
import { environmentBuildNotice } from '../src/renderer/src/features/jobs/lib/environmentBuildNotices'

function build(overrides: Partial<EnvironmentBuild> = {}): EnvironmentBuild {
  return {
    envId: 'env-1',
    ref: 'phi-python',
    state: 'building',
    phase: 'check',
    message: 'preparing',
    startedAt: '2026-09-27T10:00:00.000Z',
    estimate: { packages: 4, cachedPackages: 0 },
    progress: { packagesDone: 0, packages: 4 },
    ...overrides
  }
}

test('environment build notices fire once for each state transition', () => {
  const building = build()
  assert.deepEqual(environmentBuildNotice(undefined, building), {
    message: '正在构建环境 phi-python，可在后台任务中查看进度',
    severity: 'info'
  })
  assert.equal(
    environmentBuildNotice('building', build({ phase: 'create', message: 'micromamba create' })),
    null
  )

  const ready = build({ state: 'ready', phase: 'done', finishedAt: '2026-09-27T10:05:00.000Z' })
  assert.deepEqual(environmentBuildNotice('building', ready), {
    message: '环境 phi-python 已就绪',
    severity: 'success'
  })
  assert.equal(environmentBuildNotice('ready', ready), null)

  const failed = build({
    state: 'failed',
    phase: 'failed',
    error: 'solver failed',
    finishedAt: '2026-09-27T10:06:00.000Z'
  })
  assert.deepEqual(environmentBuildNotice('building', failed), {
    message: '环境 phi-python 构建失败：solver failed',
    severity: 'error'
  })
  assert.equal(environmentBuildNotice('failed', failed), null)

  const cancelled = build({
    state: 'cancelled',
    phase: 'cancelled',
    error: 'environment build cancelled',
    finishedAt: '2026-09-27T10:07:00.000Z'
  })
  assert.equal(environmentBuildNotice('building', cancelled), null)
  assert.equal(environmentBuildNotice(undefined, cancelled), null)
  assert.equal(environmentBuildNotice('cancelled', cancelled), null)

  assert.deepEqual(environmentBuildNotice('ready', building), {
    message: '正在构建环境 phi-python，可在后台任务中查看进度',
    severity: 'info'
  })
  assert.deepEqual(environmentBuildNotice(undefined, build({ envId: 'env-2', ref: 'phi-r' })), {
    message: '正在构建环境 phi-r，可在后台任务中查看进度',
    severity: 'info'
  })
})
