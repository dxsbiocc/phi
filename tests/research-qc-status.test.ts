import assert from 'node:assert/strict'
import test from 'node:test'

import { formatJobStatus } from '../src/main/agent/wrappers/composition/job-format'
import type { WrapperJobStatus } from '../src/main/agent/wrappers/composition/job-types'
import {
  RESEARCH_QC_INVALID_STATUS,
  type WrapperResearchQc
} from '../src/shared/wrapperResearchQcTypes'

const RAW_LOG = 'RAW LOG LINE nextflow secret noise'

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

function status(overrides: Partial<WrapperJobStatus> = {}): WrapperJobStatus {
  return {
    runId: 'wrun_qc',
    wrapperId: 'nf-core/workflows/deseq2',
    state: 'completed',
    profile: 'docker',
    outDir: '/data/out',
    elapsedSeconds: 120,
    progress: { started: 2, total: 2 },
    logTail: RAW_LOG,
    ...overrides
  }
}

test('an eligible run reports counts, the actual contrast and thresholds, never the log', () => {
  const text = formatJobStatus(status({ researchQc: ELIGIBLE, researchQcExpected: true }))
  assert.match(text, /Research QC eligible/)
  assert.match(text, /340 of 12000 genes passed/)
  assert.match(text, /condition_treated_vs_control/)
  assert.match(text, /padj < 0\.05/)
  assert.match(text, /\|log2fc\| >= 1/)
  assert.match(text, /gene_id/)
  assert.match(text, /MD5 verified/)
  assert.equal(text.includes(RAW_LOG), false)
  assert.equal(text.includes('Log tail'), false)
})

test('a skip run is completed and says zero genes passed, without the log', () => {
  const skip: WrapperResearchQc = { ...ELIGIBLE, disposition: 'skip', hits: 0 }
  const text = formatJobStatus(status({ researchQc: skip, researchQcExpected: true }))
  assert.match(text, /State: completed/)
  assert.match(text, /Research QC skip/)
  assert.match(text, /0 of 12000 genes passed/)
  assert.equal(text.includes(RAW_LOG), false)
})

test('an invalid verdict shows the fixed invalid status and no raw content', () => {
  const text = formatJobStatus(
    status({
      state: 'failed',
      researchQc: { disposition: 'invalid', reason: 'integrity-mismatch' },
      researchQcExpected: true
    })
  )
  assert.match(text, /State: failed/)
  assert.equal(text.includes(RESEARCH_QC_INVALID_STATUS), true)
  assert.match(text, /integrity-mismatch/)
  assert.equal(text.includes(RAW_LOG), false)
})

test('a QC-gated run without a verdict never shows the log, in any state', () => {
  const running = formatJobStatus(status({ state: 'running', researchQcExpected: true }))
  assert.match(running, /verification pending/)
  assert.equal(running.includes(RAW_LOG), false)

  const failed = formatJobStatus(status({ state: 'failed', researchQcExpected: true }))
  assert.match(failed, /not verified/)
  assert.equal(failed.includes(RAW_LOG), false)

  const lost = formatJobStatus(status({ state: 'lost', researchQcExpected: true }))
  assert.match(lost, /not verified/)
  assert.equal(lost.includes(RAW_LOG), false)
})

test('a remote research run is never presented as QC-verified', () => {
  const text = formatJobStatus(
    status({
      researchQcExpected: true,
      remote: { host: 'hpc.example', runDir: '/scratch/wruns/wrun_qc' }
    })
  )
  assert.match(text, /not verified by Phi \(remote run\)/)
  assert.equal(text.includes('MD5 verified'), false)
  assert.equal(text.includes(RAW_LOG), false)
})

test('legacy runs without research QC keep the log tail and gain no QC lines', () => {
  const text = formatJobStatus(status())
  assert.match(text, /Log tail/)
  assert.equal(text.includes(RAW_LOG), true)
  assert.equal(text.includes('Research QC'), false)
})
