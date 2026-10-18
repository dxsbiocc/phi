import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { BackgroundAgentJob } from '../src/shared/backgroundJobTypes'
import { selectBackgroundJobs } from '../src/renderer/src/features/jobs/lib/backgroundJobs'
import {
  canStopJob,
  jobDetail,
  jobDetailFields,
  jobStatus
} from '../src/renderer/src/features/jobs/lib/backgroundJobLabels'

const cold: BackgroundAgentJob = {
  agentSessionId: '',
  agentRunId: 'old-child',
  sessionId: 'A',
  sessionPath: 'phi-session:A',
  sessionTitle: 'Original conversation',
  agentName: 'Researcher',
  task: '',
  state: 'interrupted',
  background: true,
  startedAt: '2026-10-01T00:00:00Z',
  canControl: false,
  historyAvailable: false
}
setUiLanguage('zh-CN')

test('cold agent jobs remain visible after restart, with stable Phi keys and no live controls', () => {
  const result = selectBackgroundJobs(
    [cold, { ...cold, sessionId: 'B', sessionPath: 'phi-session:B' }],
    [],
    { finishedAfter: '2026-10-15T00:00:00Z' }
  )
  assert.equal(result.active.length, 0)
  assert.equal(result.recent.length, 2)
  assert.deepEqual(
    result.recent.map((item) => item.key),
    ['agent:cold:A:old-child', 'agent:cold:B:old-child']
  )
  for (const item of result.recent) {
    assert.equal(canStopJob(item), false)
    assert.deepEqual(jobStatus(item), { label: '已中断', tone: 'neutral' })
    assert.match(jobDetail(item, Date.now()), /未自动重启/)
    assert.ok(
      jobDetailFields(item, Date.now()).some((field) => field.value.includes('执行历史不可用'))
    )
  }
  assert.equal(
    selectBackgroundJobs([cold], [], { dismissedKeys: new Set(['agent:cold:A:old-child']) }).recent
      .length,
    0
  )
})
test('cold completed metadata keeps its real outcome and cannot gain controls from a stale running label', () => {
  const completed = selectBackgroundJobs([{ ...cold, state: 'done' }], []).recent[0]
  assert.deepEqual(jobStatus(completed), { label: '已完成', tone: 'success' })
  const stale = selectBackgroundJobs([{ ...cold, state: 'running' }], []).recent[0]
  assert.equal(canStopJob(stale), false)
  assert.equal(stale.active, false)
})
