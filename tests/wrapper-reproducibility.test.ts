import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWrapperRunPlan } from '../src/main/agent/wrappers/plans'
import { buildWrapperReproducibilityBundle } from '../src/main/agent/wrappers/reproducibility'
import { submitWrapperRunPlan } from '../src/main/agent/wrappers/runs'
import { appendWrapperRunEvent, getWrapperRunsDir } from '../src/main/agent/wrappers/store'
import { installLegacyFastqQcWrapper } from './helpers/wrapperFixtures'

function withHarness<T>(callback: (h: { agentDir: string; projectDir: string }) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-repro-'))
  const agentDir = join(root, '.phi-home')
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  try {
    return callback({ agentDir, projectDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeFastqPair(projectDir: string, sample: string): void {
  mkdirSync(join(projectDir, 'data'), { recursive: true })
  writeFileSync(join(projectDir, 'data', `${sample}_R1.fastq.gz`), 'r1')
  writeFileSync(join(projectDir, 'data', `${sample}_R2.fastq.gz`), 'r2')
}

test('buildWrapperReproducibilityBundle gathers plan, manifest, events, and run-dir artifacts', () => {
  withHarness(({ agentDir, projectDir }) => {
    const entry = installLegacyFastqQcWrapper(agentDir, projectDir)
    writeFastqPair(projectDir, 'S1')

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper: entry,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })
    const run = submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false })

    // Simulate what the local executor would have written to the run directory.
    const runDir = join(getWrapperRunsDir(agentDir), run.runId)
    writeFileSync(join(runDir, 'params.json'), JSON.stringify({ reads: 'x' }), 'utf-8')
    writeFileSync(
      join(runDir, 'outputs.json'),
      JSON.stringify({ runId: run.runId, outputs: [{ id: 'report', exists: true }] }),
      'utf-8'
    )
    appendWrapperRunEvent(
      run.runId,
      { type: 'run_state_changed', timestamp: run.createdAt },
      agentDir
    )

    const bundle = buildWrapperReproducibilityBundle(run.runId, agentDir)

    assert.equal(bundle.run.runId, run.runId)
    assert.equal(bundle.plan?.planId, plan.planId)
    assert.equal(bundle.manifest?.id, 'phi/ngs/fastq-qc')
    // submitWrapperRunPlan itself already appends a "run_created" event; the
    // manually appended one above is a second, distinct event.
    assert.equal(bundle.events.length, 2)
    assert.deepEqual(bundle.params, { reads: 'x' })
    assert.ok(bundle.outputs)
    assert.equal(bundle.summary, undefined)
    assert.ok(bundle.exportedAt)
  })
})

test('buildWrapperReproducibilityBundle throws a clear error for an unknown run', () => {
  withHarness(({ agentDir }) => {
    assert.throws(
      () => buildWrapperReproducibilityBundle('wrun_does_not_exist', agentDir),
      /run 不存在/
    )
  })
})
