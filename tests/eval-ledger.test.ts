import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createHumanInterventionLedger,
  persistTrialLedgers,
  TrialCostLedger,
  type PriceTable
} from '../scripts/eval/scientific/ledger'

const PRICE_TABLE: PriceTable = {
  version: '2026-11-v1',
  effectiveDate: '2026-11-01',
  rates: {
    'anthropic/claude-sonnet-4': {
      inputPerMillionUsd: 3.0,
      outputPerMillionUsd: 15.0
    }
  }
}

test('TrialCostLedger deduplicates calls by callId, separates run vs queue time, and computes exact cost', () => {
  const ledger = new TrialCostLedger('trial_1')
  ledger.recordCall({
    callId: 'c1',
    trialId: 'trial_1',
    role: 'main_agent',
    model: 'anthropic/claude-sonnet-4',
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    runDurationMs: 5_000,
    queueWaitMs: 12_000,
    timestamp: '2026-11-23T01:00:00.000Z'
  })
  // Duplicate callId must be ignored.
  ledger.recordCall({
    callId: 'c1',
    trialId: 'trial_1',
    role: 'main_agent',
    model: 'anthropic/claude-sonnet-4',
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    runDurationMs: 5_000,
    timestamp: '2026-11-23T01:00:00.000Z'
  })
  ledger.recordCall({
    callId: 'c2',
    trialId: 'trial_1',
    role: 'subagent',
    model: 'anthropic/claude-sonnet-4',
    inputTokens: 0,
    outputTokens: 0,
    runDurationMs: 2_000,
    timestamp: '2026-11-23T01:00:10.000Z'
  })

  const summary = ledger.summarize(PRICE_TABLE)
  assert.equal(summary.callCount, 2)
  assert.equal(summary.callsByRole.main_agent, 1)
  assert.equal(summary.callsByRole.subagent, 1)
  assert.equal(summary.totalInputTokens, 1_000_000)
  assert.equal(summary.totalOutputTokens, 100_000)
  assert.equal(summary.totalRunDurationMs, 7_000)
  assert.equal(summary.totalQueueWaitMs, 12_000)
  assert.equal(summary.estimatedCostUsd, 4.5)
  assert.equal(summary.costCompleteness, 'complete')
})

test('TrialCostLedger distinguishes missing tokens (null) from real 0 and marks cost partial/unknown', () => {
  const ledger = new TrialCostLedger('trial_2')
  ledger.recordCall({
    callId: 'c1',
    trialId: 'trial_2',
    role: 'main_agent',
    model: 'cursor/model-x',
    inputTokens: null,
    outputTokens: 500,
    unknownReason: 'provider omitted input token count',
    runDurationMs: 3_000,
    timestamp: '2026-11-23T01:00:00.000Z'
  })

  const summary = ledger.summarize(PRICE_TABLE)
  assert.equal(summary.totalInputTokens, null)
  assert.equal(summary.totalOutputTokens, 500)
  assert.equal(summary.unknownTokenCalls, 1)
  assert.equal(summary.estimatedCostUsd, null)
  assert.equal(summary.costCompleteness, 'unknown')
})

test('HumanInterventionLedger distinguishes unattended, unrecorded, and intervened trials and persists cleanly', () => {
  const unattended = createHumanInterventionLedger('t1', [])
  assert.equal(unattended.trackingStatus, 'unattended')

  const unrecorded = createHumanInterventionLedger('t2', 'unrecorded')
  assert.equal(unrecorded.trackingStatus, 'unrecorded')

  const intervened = createHumanInterventionLedger('t3', [
    {
      timestamp: '2026-11-23T01:05:00.000Z',
      durationSeconds: 45,
      reason: 'supplied donor mapping',
      action: 'answered needs_input prompt'
    }
  ])
  assert.equal(intervened.trackingStatus, 'intervened')
  assert.equal(intervened.totalDurationSeconds, 45)

  const dir = mkdtempSync(join(tmpdir(), 'phi-ledger-'))
  try {
    const usageJson = join(dir, 'usage.json')
    const interventionsJson = join(dir, 'interventions.json')
    persistTrialLedgers(
      { usageJson, interventionsJson },
      new TrialCostLedger('t3').summarize(PRICE_TABLE),
      intervened
    )
    assert.ok(existsSync(usageJson))
    assert.ok(existsSync(interventionsJson))
    assert.equal(JSON.parse(readFileSync(interventionsJson, 'utf-8')).totalDurationSeconds, 45)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
