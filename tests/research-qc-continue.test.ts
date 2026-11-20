import assert from 'node:assert/strict'
import test from 'node:test'

import { wrapperRunContinuationPrompt } from '../src/main/agent/wrappers/composition/job-continue'
import {
  buildWrapperRunFinishedEvent,
  wrapperRunNotice,
  type WrapperRunFinishedEvent
} from '../src/shared/wrapperRunNotice'
import {
  RESEARCH_QC_INVALID_STATUS,
  type WrapperResearchQc
} from '../src/shared/wrapperResearchQcTypes'
import type { WrapperRun } from '../src/shared/wrapperTypes'

const ELIGIBLE: WrapperResearchQc = {
  schemaVersion: 1,
  disposition: 'eligible',
  contrast: 'condition_treated_vs_control',
  geneIdColumn: 'gene_id',
  padjThreshold: 0.05,
  log2fcThreshold: 1,
  evaluated: 12000,
  hits: 340,
  resultMd5: 'a'.repeat(32),
  integrityVerified: true
}

function event(overrides: Partial<WrapperRunFinishedEvent> = {}): WrapperRunFinishedEvent {
  return {
    type: 'wrapper_run_finished',
    wrapperRunId: 'wrun_qc',
    wrapperId: 'nf-core/workflows/deseq2',
    state: 'completed',
    exitCode: 0,
    outDir: '/data/out',
    elapsedSeconds: 120,
    ...overrides
  }
}

function run(overrides: Partial<WrapperRun> = {}): WrapperRun {
  return {
    runId: 'wrun_qc',
    planId: '',
    revision: 1,
    state: 'completed',
    actor: 'agent',
    wrapper: {
      canonicalId: 'nf-core/workflows/deseq2',
      namespace: 'nf-core/workflows',
      shortId: 'deseq2',
      version: 'unversioned'
    },
    trustTier: 'bundled',
    executor: 'local',
    profile: 'docker',
    cwd: '/repo',
    outDir: '/data/out',
    origin: 'composition',
    createdAt: '2026-11-19T10:00:00.000Z',
    updatedAt: '2026-11-19T10:02:00.000Z',
    ...overrides
  }
}

// ── the continuation prompt ───────────────────────────────────────────────

test('an eligible result carries counts, the actual contrast and thresholds, and stays in scope', () => {
  const text = wrapperRunContinuationPrompt([
    event({ researchQc: ELIGIBLE, researchQcExpected: true })
  ])
  assert.match(text, /340 of 12000 genes passed/)
  assert.match(text, /condition_treated_vs_control/)
  assert.match(text, /padj < 0\.05/)
  assert.match(text, /\|log2fc\| >= 1/)
  assert.match(text, /MD5 verified/)
  assert.match(text, /scope the user already approved/)
  assert.match(text, /ask the user before starting any new or broader analysis/)
  assert.equal(text.includes(RESEARCH_QC_INVALID_STATUS), false)
})

test('a skip result is honest about zero hits and delivers when it answers the original goal', () => {
  const text = wrapperRunContinuationPrompt([
    event({
      researchQc: { ...ELIGIBLE, disposition: 'skip', hits: 0 },
      researchQcExpected: true
    })
  ])
  assert.match(text, /Research QC skip/)
  assert.match(text, /no genes passed the thresholds/)
  assert.match(text, /Skip candidate-list enrichment/)
  assert.match(text, /Deliver the zero-hit result/)
  assert.match(text, /only if an unresolved aim/)
})

test('a QC-invalid failure gives the fixed status and never sends the agent to the raw log', () => {
  const text = wrapperRunContinuationPrompt([
    event({
      state: 'failed',
      researchQc: { disposition: 'invalid', reason: 'integrity-mismatch' },
      researchQcExpected: true
    })
  ])
  assert.equal(text.includes(RESEARCH_QC_INVALID_STATUS), true)
  assert.match(text, /Do not request or read the raw run log/)
  assert.match(text, /do not use or interpret its outputs/)
  assert.match(text, /Do not start it again unless the user asked for retries/)
  assert.equal(/report the log/i.test(text), false)
  assert.equal(/using these results/.test(text), false)
})

test('a QC-gated run that failed before verification also never sends the agent to the raw log', () => {
  const text = wrapperRunContinuationPrompt([
    event({ state: 'failed', exitCode: 1, researchQcExpected: true })
  ])
  assert.equal(/report the log/i.test(text), false)
  assert.match(text, /Do not request or read the raw run log/)
  assert.match(text, /not verified by Phi/)
})

test('a remote research completion never implies verified QC', () => {
  const text = wrapperRunContinuationPrompt([event({ researchQcExpected: true })])
  assert.match(text, /not verified by Phi/)
  assert.match(text, /do not claim these results are QC-verified/)
  assert.equal(text.includes('MD5 verified'), false)
})

test('mixed endings: only the plain failure may point at the log', () => {
  const text = wrapperRunContinuationPrompt([
    event({
      state: 'failed',
      researchQc: { disposition: 'invalid', reason: 'malformed' },
      researchQcExpected: true
    }),
    event({ wrapperRunId: 'wrun_plain', wrapperId: 'nf-core/modules/fastqc', state: 'failed' })
  ])
  assert.match(text, /Wrapper can report the log for its run id/)
  assert.match(text, /Do not request or read the raw run log/)
})

test('legacy failures keep their existing guidance untouched', () => {
  const text = wrapperRunContinuationPrompt([event({ state: 'failed', exitCode: 137 })])
  assert.match(text, /Wrapper can report the log for its run id/)
  assert.match(text, /do not start it again/i)
  assert.equal(text.includes('Research QC'), false)
})

// ── the finished event and the user notice ────────────────────────────────

test('the finished event carries the sanitized verdict and the QC expectation', () => {
  const built = buildWrapperRunFinishedEvent(
    run({ researchQc: ELIGIBLE, researchQcExpected: true }),
    { elapsedSeconds: 120 }
  )
  assert.deepEqual(built.researchQc, ELIGIBLE)
  assert.equal(built.researchQcExpected, true)
  const legacy = buildWrapperRunFinishedEvent(run(), { elapsedSeconds: 120 })
  assert.equal('researchQc' in legacy, false)
  assert.equal('researchQcExpected' in legacy, false)
})

test('a QC-invalid failure notice never suggests inspecting logs (zh and en)', () => {
  const invalidRun = run({
    state: 'failed',
    exitCode: 0,
    researchQc: { disposition: 'invalid', reason: 'integrity-mismatch' },
    researchQcExpected: true
  })
  const zh = wrapperRunNotice(buildWrapperRunFinishedEvent(invalidRun, { elapsedSeconds: 9 }))
  assert.equal(zh.body.includes('日志'), false)
  assert.match(zh.body, /科研 QC 无效/)
  const en = wrapperRunNotice(buildWrapperRunFinishedEvent(invalidRun, { elapsedSeconds: 9 }), 'en')
  assert.equal(/logs/i.test(en.body), false)
  assert.match(en.body, /Research QC invalid/)
})

test('a QC-gated failure without a verdict also drops the log suggestion', () => {
  const failedRun = run({ state: 'failed', exitCode: 1, researchQcExpected: true })
  const zh = wrapperRunNotice(buildWrapperRunFinishedEvent(failedRun, { elapsedSeconds: 9 }))
  assert.equal(zh.body.includes('日志'), false)
  assert.match(zh.body, /未经 Phi 校验/)
})

test('eligible and skip completions tell the user the counts compactly', () => {
  const eligible = wrapperRunNotice(
    buildWrapperRunFinishedEvent(run({ researchQc: ELIGIBLE }), { elapsedSeconds: 120 })
  )
  assert.match(eligible.body, /科研 QC 合格：340\/12000/)
  const skip = wrapperRunNotice(
    buildWrapperRunFinishedEvent(
      run({ researchQc: { ...ELIGIBLE, disposition: 'skip', hits: 0 } }),
      { elapsedSeconds: 120 }
    )
  )
  assert.match(skip.body, /科研 QC 跳过：0\/12000/)
})

test('legacy failure notices keep the log suggestion', () => {
  const zh = wrapperRunNotice(
    buildWrapperRunFinishedEvent(run({ state: 'failed', exitCode: 1 }), { elapsedSeconds: 9 })
  )
  assert.match(zh.body, /日志/)
  const en = wrapperRunNotice(
    buildWrapperRunFinishedEvent(run({ state: 'failed', exitCode: 1 }), { elapsedSeconds: 9 }),
    'en'
  )
  assert.match(en.body, /inspect the logs/)
})

test('a damaged replayed event cannot inject a raw log into a scientific continuation', () => {
  const invalid = event({ researchQc: { ...ELIGIBLE, contrast: 'BAD_LOG\nraw table line' } })
  const prompt = wrapperRunContinuationPrompt([invalid])
  assert.doesNotMatch(prompt, /BAD_LOG|raw table line/)
  assert.match(prompt, /Research QC invalid/)
})
