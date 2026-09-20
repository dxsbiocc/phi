import assert from 'node:assert/strict'
import test from 'node:test'

import { deliverWrapperRunFinished } from '../src/main/agent/wrappers/composition/job-notify'
import {
  buildWrapperRunFinishedEvent,
  formatWrapperRunDuration,
  wrapperRunNotice,
  type WrapperRunFinishedEvent
} from '../src/shared/wrapperRunNotice'
import type { WrapperRun } from '../src/shared/wrapperTypes'

function run(overrides: Partial<WrapperRun> = {}): WrapperRun {
  return {
    runId: 'wrun_abc',
    planId: '',
    revision: 1,
    state: 'completed',
    actor: 'agent',
    wrapper: {
      canonicalId: 'nf-core/modules/fastqc',
      namespace: 'nf-core/modules',
      shortId: 'fastqc',
      version: 'unversioned'
    },
    trustTier: 'bundled',
    executor: 'local',
    profile: 'docker',
    cwd: '/repo',
    outDir: '/data/qc',
    origin: 'composition',
    originSessionId: 'runtime-1',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:02:05.000Z',
    startedAt: '2026-09-20T10:00:00.000Z',
    completedAt: '2026-09-20T10:02:05.000Z',
    exitCode: 0,
    ...overrides
  }
}

test('durations are short and human', () => {
  assert.equal(formatWrapperRunDuration(0), '0 秒')
  assert.equal(formatWrapperRunDuration(45), '45 秒')
  assert.equal(formatWrapperRunDuration(125), '2 分 5 秒')
  assert.equal(formatWrapperRunDuration(3 * 3600 + 7 * 60), '3 小时 7 分')
})

test('the finished event carries what a reader needs and nothing bulky', () => {
  const event = buildWrapperRunFinishedEvent(run(), { elapsedSeconds: 125, missingOutputs: [] })
  assert.deepEqual(event, {
    type: 'wrapper_run_finished',
    wrapperRunId: 'wrun_abc',
    wrapperId: 'nf-core/modules/fastqc',
    state: 'completed',
    exitCode: 0,
    outDir: '/data/qc',
    elapsedSeconds: 125
  })
  const failed = buildWrapperRunFinishedEvent(run({ state: 'failed', exitCode: 1 }), {
    elapsedSeconds: 3,
    missingOutputs: ['report (out/x)']
  })
  assert.deepEqual(failed.missingOutputs, ['report (out/x)'])
})

test('the notice says what happened, where the outputs are, and the run id', () => {
  const done = wrapperRunNotice(buildWrapperRunFinishedEvent(run(), { elapsedSeconds: 125 }))
  assert.equal(done.title, 'Wrapper 运行已完成')
  assert.match(done.body, /nf-core\/modules\/fastqc/)
  assert.match(done.body, /2 分 5 秒/)
  assert.match(done.body, /\/data\/qc/)
  assert.match(done.body, /wrun_abc/)

  const failed = wrapperRunNotice(
    buildWrapperRunFinishedEvent(run({ state: 'failed', exitCode: 137 }), { elapsedSeconds: 9 })
  )
  assert.equal(failed.title, 'Wrapper 运行失败')
  assert.match(failed.body, /137/)
  assert.match(failed.body, /Wrapper/)

  const missing = wrapperRunNotice(
    buildWrapperRunFinishedEvent(run({ state: 'failed', exitCode: 0 }), {
      elapsedSeconds: 9,
      missingOutputs: ['report (out/x)']
    })
  )
  assert.match(missing.body, /report \(out\/x\)/)

  const cancelled = wrapperRunNotice(
    buildWrapperRunFinishedEvent(run({ state: 'cancelled', exitCode: -1 }), { elapsedSeconds: 4 })
  )
  assert.equal(cancelled.title, 'Wrapper 运行已取消')
})

// ── delivery ──────────────────────────────────────────────────────────────

interface Deps {
  persisted: Array<{ sessionId: string; event: WrapperRunFinishedEvent }>
  sent: Array<Record<string, unknown>>
  notified: Array<{ title: string; body: string }>
  focused: boolean
  resolveSession: (
    originSessionId: string | undefined
  ) => { phiSessionId: string; cwd: string } | undefined
  failPersist: boolean
  deps: Parameters<typeof deliverWrapperRunFinished>[2]
}

function harness(
  overrides: Partial<Pick<Deps, 'focused' | 'failPersist' | 'resolveSession'>> = {}
): Deps {
  const h = {
    persisted: [] as Deps['persisted'],
    sent: [] as Deps['sent'],
    notified: [] as Deps['notified'],
    focused: false,
    failPersist: false,
    resolveSession: (id: string | undefined) =>
      id === 'runtime-1' ? { phiSessionId: 'phi-1', cwd: '/proj' } : undefined,
    ...overrides
  } as Deps
  h.deps = {
    resolveSession: (id) => h.resolveSession(id),
    appendToSession: (sessionId, event) => {
      if (h.failPersist) throw new Error('disk full')
      h.persisted.push({ sessionId, event: event as WrapperRunFinishedEvent })
      return { ...event, eventId: 'evt-1', sessionId, createdAt: '2026-09-20T10:03:00.000Z' }
    },
    sendToWindow: (payload) => h.sent.push(payload),
    isAppFocused: () => h.focused,
    showOsNotification: (n) => h.notified.push(n)
  }
  return h
}

const STATUS = { elapsedSeconds: 125, missingOutputs: [] }

test('a finished run is added to the conversation that started it and pushed to the window', () => {
  const h = harness()
  deliverWrapperRunFinished(run(), STATUS, h.deps)

  assert.equal(h.persisted.length, 1)
  assert.equal(h.persisted[0].sessionId, 'phi-1')
  assert.equal(h.persisted[0].event.wrapperRunId, 'wrun_abc')
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].type, 'wrapper_run_finished')
  assert.equal(h.sent[0].source, 'phi')
  assert.equal(h.sent[0].phiSessionId, 'phi-1')
  assert.equal(h.sent[0].cwd, '/proj')
  assert.equal(h.sent[0].eventId, 'evt-1')
})

test('an OS notification is shown only when the app is not in the foreground', () => {
  const background = harness({ focused: false })
  deliverWrapperRunFinished(run(), STATUS, background.deps)
  assert.equal(background.notified.length, 1)
  assert.equal(background.notified[0].title, 'Wrapper 运行已完成')

  const foreground = harness({ focused: true })
  deliverWrapperRunFinished(run(), STATUS, foreground.deps)
  assert.equal(foreground.notified.length, 0)
  assert.equal(foreground.persisted.length, 1)
})

test('a run that started outside any known conversation still notifies the user', () => {
  const h = harness()
  deliverWrapperRunFinished(run({ originSessionId: undefined }), STATUS, h.deps)
  assert.deepEqual(h.persisted, [])
  assert.deepEqual(h.sent, [])
  assert.equal(h.notified.length, 1)

  const unknown = harness()
  deliverWrapperRunFinished(run({ originSessionId: 'gone' }), STATUS, unknown.deps)
  assert.equal(unknown.notified.length, 1)
})

test('a failing timeline write does not lose the OS notification', () => {
  const h = harness({ failPersist: true })
  deliverWrapperRunFinished(run(), STATUS, h.deps)
  assert.equal(h.notified.length, 1)
  assert.deepEqual(h.sent, [])
})

test('a run the user cancelled is recorded in the conversation but does not pop up a notification', () => {
  const h = harness()
  deliverWrapperRunFinished(run({ state: 'cancelled', exitCode: -1 }), STATUS, h.deps)
  assert.equal(h.persisted.length, 1)
  assert.equal(h.persisted[0].event.state, 'cancelled')
  assert.equal(h.notified.length, 0)
})

test('only runs that ended get a notice', () => {
  const h = harness()
  deliverWrapperRunFinished(run({ state: 'running' }), STATUS, h.deps)
  deliverWrapperRunFinished(run({ state: 'lost' }), STATUS, h.deps)
  assert.deepEqual(h.persisted, [])
  assert.deepEqual(h.notified, [])
})

// ── waking the conversation ───────────────────────────────────────────────

test('when the conversation is known it is also offered the chance to continue, with the run and the event', () => {
  const h = harness()
  const woken: Array<{ phiSessionId: string; state: string; runId: string }> = []
  deliverWrapperRunFinished(run(), STATUS, {
    ...h.deps,
    continueConversation: (phiSessionId, event, finishedRun) =>
      woken.push({ phiSessionId, state: event.state, runId: finishedRun.runId })
  })
  assert.deepEqual(woken, [{ phiSessionId: 'phi-1', state: 'completed', runId: 'wrun_abc' }])
})

test('a failed banner write does not stop the conversation from continuing', () => {
  const h = harness({ failPersist: true })
  let woken = 0
  deliverWrapperRunFinished(run(), STATUS, { ...h.deps, continueConversation: () => (woken += 1) })
  assert.equal(woken, 1)
})

test('an unknown conversation, or a run that has not ended, is never woken', () => {
  const h = harness()
  let woken = 0
  const deps = { ...h.deps, continueConversation: () => (woken += 1) }
  deliverWrapperRunFinished(run({ originSessionId: 'gone' }), STATUS, deps)
  deliverWrapperRunFinished(run({ originSessionId: undefined }), STATUS, deps)
  deliverWrapperRunFinished(run({ state: 'running' }), STATUS, deps)
  assert.equal(woken, 0)
})

test('a throwing continue hook never breaks notification', () => {
  const h = harness()
  deliverWrapperRunFinished(run(), STATUS, {
    ...h.deps,
    continueConversation: () => {
      throw new Error('boom')
    }
  })
  assert.equal(h.notified.length, 1)
})
