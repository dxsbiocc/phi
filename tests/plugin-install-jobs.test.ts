import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PluginInstallJobs,
  type PluginInstallJobHandle
} from '../src/main/agent/plugins/plugin-install-jobs'

function jobsAt(maxFinished?: number): PluginInstallJobs {
  let tick = 0
  return new PluginInstallJobs({
    ...(maxFinished === undefined ? {} : { maxFinished }),
    now: () => {
      tick += 1
      return new Date(Date.UTC(2026, 9, 15, 10, 0, 0) + tick * 1000)
    }
  })
}

function start(
  jobs: PluginInstallJobs,
  pluginId = 'phi-demo',
  overrides: Partial<{ title: string; version: string; action: 'install' | 'upgrade' }> = {}
): PluginInstallJobHandle {
  const handle = jobs.begin({
    pluginId,
    title: overrides.title ?? 'Demo plugin',
    version: overrides.version ?? '1.2.3',
    action: overrides.action ?? 'install'
  })
  assert.ok(handle, 'the first attempt for a plugin is tracked')
  return handle
}

test('starting a plugin install records the plugin, version, action and start time', () => {
  const jobs = jobsAt()
  const handle = start(jobs, 'phi-demo', { title: 'Demo plugin', version: '1.2.3' })

  assert.deepEqual(jobs.list(), [
    {
      id: 'plugin-install-1',
      pluginId: 'phi-demo',
      title: 'Demo plugin',
      version: '1.2.3',
      action: 'install',
      state: 'running',
      startedAt: '2026-10-15T10:00:01.000Z'
    }
  ])
  assert.equal(handle.job.state, 'running')
})

test('a successful install records its finish time and clears the running state', () => {
  const jobs = jobsAt()
  const handle = start(jobs, 'phi-demo', { action: 'upgrade', version: '2.0.0' })
  handle.succeed()

  const [job] = jobs.list()
  assert.equal(job.state, 'succeeded')
  assert.equal(job.finishedAt, '2026-10-15T10:00:02.000Z')
  assert.equal(job.failure, undefined)
  assert.equal(job.action, 'upgrade')
  assert.equal(job.version, '2.0.0')
})

test('a failed install keeps a stable failure code instead of the raw error', () => {
  const jobs = jobsAt()
  const handle = start(jobs, 'phi-demo', { action: 'upgrade' })
  handle.fail('upgrade-failed')

  const [job] = jobs.list()
  assert.equal(job.state, 'failed')
  assert.equal(job.failure, 'upgrade-failed')
  assert.equal(job.finishedAt, '2026-10-15T10:00:02.000Z')
  // Late calls cannot flip a terminal attempt.
  handle.succeed()
  assert.equal(jobs.list()[0].state, 'failed')
})

test('concurrent attempts for the same plugin are de-duplicated', () => {
  const jobs = jobsAt()
  const first = start(jobs, 'phi-demo')
  const duplicate = jobs.begin({
    pluginId: 'phi-demo',
    title: 'Demo plugin',
    version: '9.9.9',
    action: 'upgrade'
  })

  assert.equal(duplicate, undefined)
  assert.equal(jobs.list().length, 1)
  assert.equal(jobs.list()[0].state, 'running')
  assert.equal(jobs.list()[0].version, '1.2.3')

  first.succeed()
  const next = start(jobs, 'phi-demo', { action: 'upgrade', version: '2.0.0' })
  assert.equal(next.job.id, 'plugin-install-2')
  assert.deepEqual(
    jobs.list().map((job) => `${job.pluginId}:${job.action}`),
    ['phi-demo:upgrade']
  )
})

test('different plugins install concurrently and finished records stay capped', () => {
  const jobs = jobsAt(2)
  const first = start(jobs, 'plugin-a')
  const second = start(jobs, 'plugin-b')
  assert.equal(jobs.list().filter((job) => job.state === 'running').length, 2)

  first.succeed()
  second.fail('install-failed')
  const third = start(jobs, 'plugin-c')
  third.succeed()

  assert.deepEqual(
    jobs.list().map((job) => job.pluginId),
    ['plugin-c', 'plugin-b']
  )
})
