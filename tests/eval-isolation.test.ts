import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  auditSharedCaches,
  createTrialSandbox,
  isPathContainedInTrial,
  verifyIsolationBoundary
} from '../scripts/eval/scientific/isolation'

test('trial A state and memory are physically isolated from trial B', () => {
  const base = mkdtempSync(join(tmpdir(), 'phi-iso-base-'))
  try {
    const trialA = createTrialSandbox({ trialId: 'trial_a', baseTempDir: base })
    const trialB = createTrialSandbox({ trialId: 'trial_b', baseTempDir: base })
    try {
      writeFileSync(join(trialA.memoryDir, 'secret.md'), 'answer from trial A')
      writeFileSync(join(trialA.cwd, 'result.tsv'), 'gene\tval\nG1\t1\n')

      assert.equal(existsSync(join(trialB.memoryDir, 'secret.md')), false)
      assert.equal(existsSync(join(trialB.cwd, 'result.tsv')), false)
      assert.notEqual(trialA.agentDir, trialB.agentDir)
      assert.notEqual(trialA.cwd, trialB.cwd)
    } finally {
      trialA.cleanup()
      trialB.cleanup()
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('auditSharedCaches rejects caches overlapping with hidden references or containing answer files', () => {
  const base = mkdtempSync(join(tmpdir(), 'phi-cache-audit-'))
  try {
    const hidden = join(base, 'hidden-ref')
    const cleanCache = join(base, 'conda-cache')
    const taintedCache = join(base, 'tainted-cache')
    mkdirSync(hidden, { recursive: true })
    mkdirSync(cleanCache, { recursive: true })
    mkdirSync(taintedCache, { recursive: true })
    writeFileSync(join(taintedCache, 'answers.json'), '{}')

    assert.equal(auditSharedCaches([cleanCache], hidden).ok, true)
    assert.equal(auditSharedCaches([hidden], hidden).ok, false)
    assert.equal(auditSharedCaches([taintedCache], hidden).ok, false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('verifyIsolationBoundary verifies blocked canary probes and flags leaks', async () => {
  const base = mkdtempSync(join(tmpdir(), 'phi-canary-'))
  try {
    const hidden = join(base, 'hidden-answers')
    const sandbox = createTrialSandbox({ trialId: 'trial_canary', baseTempDir: base })
    try {
      const safeReport = await verifyIsolationBoundary({
        sandbox,
        hiddenReferenceDir: hidden,
        attemptRead: async (target) => isPathContainedInTrial(sandbox.cwd, target)
      })
      assert.equal(safeReport.status, 'verified')
      assert.equal(safeReport.checks.length, 3)
      assert.ok(safeReport.checks.every((c) => c.status === 'blocked'))

      const leakyReport = await verifyIsolationBoundary({
        sandbox,
        hiddenReferenceDir: hidden,
        attemptRead: async () => true
      })
      assert.equal(leakyReport.status, 'failed')
      assert.ok(leakyReport.checks.some((c) => c.status === 'leaked'))
    } finally {
      sandbox.cleanup()
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
