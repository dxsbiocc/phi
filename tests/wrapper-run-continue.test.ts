import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_AUTOMATIC_CONTINUATIONS,
  shouldContinueConversation,
  wrapperRunContinuationPrompt
} from '../src/main/agent/wrappers/composition/job-continue'
import type { WrapperRunFinishedEvent } from '../src/shared/wrapperRunNotice'
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
    ...overrides
  }
}

function event(overrides: Partial<WrapperRunFinishedEvent> = {}): WrapperRunFinishedEvent {
  return {
    type: 'wrapper_run_finished',
    wrapperRunId: 'wrun_abc',
    wrapperId: 'nf-core/modules/fastqc',
    state: 'completed',
    exitCode: 0,
    outDir: '/data/qc',
    elapsedSeconds: 125,
    ...overrides
  }
}

// ── the decision ──────────────────────────────────────────────────────────

test('a run that ended on its own continues the conversation by default', () => {
  assert.deepEqual(
    shouldContinueConversation({ run: run(), state: 'completed', automaticCount: 0 }),
    {
      continue: true
    }
  )
  assert.deepEqual(shouldContinueConversation({ run: run(), state: 'failed', automaticCount: 0 }), {
    continue: true
  })
})

test('a cancelled run never wakes the conversation: the user knows', () => {
  assert.deepEqual(
    shouldContinueConversation({ run: run(), state: 'cancelled', automaticCount: 0 }),
    {
      continue: false,
      reason: 'cancelled'
    }
  )
})

test('a run started with continue_when_done false only notifies', () => {
  assert.deepEqual(
    shouldContinueConversation({
      run: run({ continueWhenDone: false }),
      state: 'completed',
      automaticCount: 0
    }),
    { continue: false, reason: 'disabled' }
  )
  assert.equal(
    shouldContinueConversation({
      run: run({ continueWhenDone: true }),
      state: 'completed',
      automaticCount: 0
    }).continue,
    true
  )
})

test('chained automatic continuations are capped so a loop of runs cannot go on unattended', () => {
  assert.equal(MAX_AUTOMATIC_CONTINUATIONS >= 2 && MAX_AUTOMATIC_CONTINUATIONS <= 10, true)
  assert.equal(
    shouldContinueConversation({
      run: run(),
      state: 'completed',
      automaticCount: MAX_AUTOMATIC_CONTINUATIONS - 1
    }).continue,
    true
  )
  assert.deepEqual(
    shouldContinueConversation({
      run: run(),
      state: 'completed',
      automaticCount: MAX_AUTOMATIC_CONTINUATIONS
    }),
    { continue: false, reason: 'limit' }
  )
})

// ── what the model is told ────────────────────────────────────────────────

test('the continuation message is clearly from Phi and carries the outcome and where the results are', () => {
  const text = wrapperRunContinuationPrompt([event()])
  assert.match(text, /^<phi_wrapper_run_finished>/)
  assert.match(text, /<\/phi_wrapper_run_finished>$/)
  assert.match(text, /from Phi, not from the user/i)
  assert.match(text, /wrun_abc/)
  assert.match(text, /nf-core\/modules\/fastqc/)
  assert.match(text, /completed/)
  assert.match(text, /took 2 m 5 s/)
  assert.doesNotMatch(text, /[\u4e00-\u9fff]/, 'the model message is English')
  assert.match(text, /\/data\/qc/)
  assert.match(text, /continue/i)
  assert.match(text, /language the user/i)
})

test('a failed run is described with its cause and the model is told not to blindly retry', () => {
  const text = wrapperRunContinuationPrompt([event({ state: 'failed', exitCode: 137 })])
  assert.match(text, /failed/)
  assert.match(text, /137/)
  assert.match(text, /do not start (it|the same run) again/i)

  const missing = wrapperRunContinuationPrompt([
    event({ state: 'failed', exitCode: 0, missingOutputs: ['report (out/x)'] })
  ])
  assert.match(missing, /report \(out\/x\)/)
})

test('several runs that ended while the conversation was busy are reported together in one message', () => {
  const text = wrapperRunContinuationPrompt([
    event(),
    event({
      wrapperRunId: 'wrun_def',
      wrapperId: 'nf-core/modules/fastp',
      state: 'failed',
      exitCode: 1
    })
  ])
  assert.equal(text.match(/<phi_wrapper_run_finished>/g)?.length, 1)
  assert.match(text, /wrun_abc/)
  assert.match(text, /wrun_def/)
  assert.match(text, /nf-core\/modules\/fastp/)
})
