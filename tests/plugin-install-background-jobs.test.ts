import assert from 'node:assert/strict'
import test from 'node:test'

import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import type { PluginInstallJob } from '../src/shared/pluginInstallJobTypes'
import {
  BACKGROUND_JOB_HISTORY_KEY,
  BackgroundJobHistory
} from '../src/renderer/src/features/jobs/lib/backgroundJobHistory'
import {
  selectBackgroundJobs,
  type LiveBackgroundJob
} from '../src/renderer/src/features/jobs/lib/backgroundJobs'
import {
  jobDetail,
  jobDetailFields,
  jobSource,
  jobStatus,
  jobSubtitle,
  jobTitle,
  pluginInstallError
} from '../src/renderer/src/features/jobs/lib/backgroundJobLabels'
import {
  backgroundJobPhase,
  newlyObservedJobs
} from '../src/renderer/src/features/jobs/hooks/useBackgroundJobArrivals'
import { groupBackgroundJobs } from '../src/renderer/src/features/jobs/lib/backgroundJobGroups'

const startedAt = '2026-10-15T10:00:00.000Z'
const finishedAt = '2026-10-15T10:01:00.000Z'

function install(overrides: Partial<PluginInstallJob> = {}): PluginInstallJob {
  return {
    id: 'plugin-install-1',
    pluginId: 'phi-demo',
    title: 'Demo Plugin',
    version: '1.2.3',
    action: 'install',
    state: 'running',
    startedAt,
    ...overrides
  }
}

function select(installs: readonly PluginInstallJob[]): ReturnType<typeof selectBackgroundJobs> {
  return selectBackgroundJobs([], [], {}, [], [], [], [], [], [], installs)
}

function livePlugin(installs: readonly PluginInstallJob[]): LiveBackgroundJob {
  const item = select(installs).recent[0] ?? select(installs).active[0]
  assert.ok(item && item.kind === 'plugin')
  return item
}

class MemoryStorage {
  value: string | null = null
  getItem(): string | null {
    return this.value
  }
  setItem(key: string, value: string): void {
    assert.equal(key, BACKGROUND_JOB_HISTORY_KEY)
    this.value = value
  }
}

function empty(): { active: LiveBackgroundJob[]; recent: LiveBackgroundJob[] } {
  return { active: [], recent: [] }
}

test('a running plugin install joins the active tray with plugin identity and labels', () => {
  setUiLanguage('zh-CN')
  const result = select([install()])
  assert.equal(result.active.length, 1)
  assert.equal(result.recent.length, 0)
  const item = result.active[0]
  assert.equal(item.kind, 'plugin')
  assert.equal(item.key, 'plugin:phi-demo')
  assert.equal(jobTitle(item), 'Demo Plugin')
  assert.equal(jobSource(item), '插件')
  assert.equal(jobSubtitle(item), 'phi-demo')
  assert.deepEqual(jobStatus(item), { label: '进行中', tone: 'running' })
  assert.equal(jobDetail(item, Date.parse(startedAt)), '安装 · v1.2.3 · 进行中')
})

test('a finished plugin install reports success or a readable failure summary', () => {
  setUiLanguage('zh-CN')
  const succeeded = select([install({ state: 'succeeded', finishedAt })])
  assert.equal(succeeded.active.length, 0)
  assert.equal(succeeded.recent.length, 1)
  assert.deepEqual(jobStatus(succeeded.recent[0]), { label: '已完成', tone: 'success' })

  const failed = livePlugin([
    install({ action: 'upgrade', state: 'failed', finishedAt, failure: 'upgrade-failed' })
  ])
  assert.deepEqual(jobStatus(failed), { label: '失败', tone: 'error' })
  assert.equal(
    pluginInstallError(install({ action: 'upgrade' })),
    '插件升级失败，详情请查看 Phi 日志。'
  )
  assert.match(jobDetail(failed, Date.parse(finishedAt)), /升级 · v1\.2\.3 · 失败 · 插件升级失败/)

  const fields = jobDetailFields(failed, Date.parse(finishedAt))
  assert.deepEqual(
    fields.map((field) => field.label),
    ['插件', '版本', '操作', '状态', '开始时间', '耗时', '结束时间', '失败原因']
  )
  assert.equal(fields.at(-1)?.value, '插件升级失败，详情请查看 Phi 日志。')
})

test('the plugin kind survives a real history storage round-trip', () => {
  setUiLanguage('zh-CN')
  const storage = new MemoryStorage()
  const live = select([
    install({
      action: 'upgrade',
      state: 'failed',
      finishedAt,
      failure: 'upgrade-failed'
    })
  ])
  const history = new BackgroundJobHistory(storage)
  history.observe(live.recent)
  assert.match(storage.value ?? '', /"sourceKind":"plugin"/)
  assert.match(storage.value ?? '', /"key":"plugin:phi-demo"/)
  assert.doesNotMatch(storage.value ?? '', /upgrade-failed/)

  const restored = new BackgroundJobHistory(storage).select(empty())
  assert.equal(restored.recent.length, 1)
  const [item] = restored.recent
  assert.ok(item.kind === 'history')
  assert.equal(item.snapshot.sourceKind, 'plugin')
  assert.equal(item.snapshot.title, 'Demo Plugin')
  assert.equal(item.snapshot.source, '插件')
  assert.equal(item.snapshot.status.label, '失败')
  assert.ok(item.snapshot.fields.some((field) => field.label === '版本' && field.value === '1.2.3'))
  assert.ok(
    item.snapshot.fields.some(
      (field) => field.label === '失败原因' && field.value === '插件升级失败，详情请查看 Phi 日志。'
    )
  )
})

test('history accepts plugin snapshots with both dictionaries but rejects invalid identity', () => {
  const snapshot = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    key: 'plugin:phi-demo',
    sourceKind: 'plugin',
    timestamp: finishedAt,
    title: 'Demo Plugin',
    source: 'Plugin',
    status: { label: 'Completed', tone: 'success' },
    fields: [
      { label: 'Plugin', value: 'Demo Plugin' },
      { label: 'Version', value: '1.2.3' },
      { label: 'Action', value: 'Install' }
    ],
    ...overrides
  })
  const storage = new MemoryStorage()
  storage.value = JSON.stringify({
    schema: 1,
    records: [
      snapshot({}),
      snapshot({
        key: 'plugin:phi-zh',
        source: '插件',
        status: { label: '已完成', tone: 'success' },
        fields: [{ label: '版本', value: '2.0.0' }]
      }),
      snapshot({ key: 'other:phi-demo' }),
      snapshot({ sourceKind: 'unknown' }),
      snapshot({ status: { label: 'In progress', tone: 'running' } })
    ],
    clearedBefore: null,
    dismissed: {}
  })

  const restored = new BackgroundJobHistory(storage).select(empty()).recent
  assert.equal(restored.length, 2)
  assert.deepEqual(
    restored.map((item) => item.kind === 'history' && item.snapshot.key),
    ['plugin:phi-demo', 'plugin:phi-zh']
  )
})

test('a plugin install reports its completion or failure as an arrival phase', () => {
  setUiLanguage('zh-CN')
  const running = groupBackgroundJobs([livePlugin([install()])])
  const succeeded = groupBackgroundJobs([livePlugin([install({ state: 'succeeded', finishedAt })])])
  const failed = groupBackgroundJobs([
    livePlugin([install({ state: 'failed', finishedAt, failure: 'install-failed' })])
  ])
  assert.equal(backgroundJobPhase(running[0]), 'running')
  assert.equal(backgroundJobPhase(succeeded[0]), 'completed')
  assert.equal(backgroundJobPhase(failed[0]), 'failed')

  const known = new Set<string>()
  assert.equal(newlyObservedJobs(running, known).length, 1)
  assert.deepEqual(newlyObservedJobs(succeeded, known), [])
})

test('English plugin labels and the failure summary follow the active language', () => {
  setUiLanguage('en')
  try {
    const item = livePlugin([install({ action: 'upgrade', state: 'failed', finishedAt })])
    assert.equal(jobSource(item), 'Plugin')
    assert.equal(
      pluginInstallError(install({ action: 'upgrade' })),
      'Plugin upgrade failed. Check the Phi log for details.'
    )
    assert.deepEqual(
      jobDetailFields(item, Date.parse(finishedAt)).map((field) => field.label),
      ['Plugin', 'Version', 'Action', 'Status', 'Started', 'Duration', 'Finished', 'Failure']
    )
  } finally {
    setUiLanguage('zh-CN')
  }
})
