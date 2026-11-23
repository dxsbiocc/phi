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
    assert.equal(bundle.manifestSource, 'snapshot')
    assert.match(bundle.manifestSha256 ?? '', /^[0-9a-f]{64}$/)
    assert.equal(bundle.manifestSha256, run.manifestSha256)
    // submitWrapperRunPlan itself already appends a "run_created" event; the
    // manually appended one above is a second, distinct event.
    assert.equal(bundle.events.length, 2)
    assert.deepEqual(bundle.params, { reads: 'x' })
    assert.ok(bundle.outputs)
    assert.equal(bundle.summary, undefined)
    assert.ok(bundle.exportedAt)
  })
})

test('buildWrapperReproducibilityBundle preserves the frozen manifest snapshot after wrapper removal', () => {
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

    // Simulate uninstalling/mutating the installed wrapper after the run was created.
    rmSync(entry.installedPath, { recursive: true, force: true })

    const bundle = buildWrapperReproducibilityBundle(run.runId, agentDir)
    assert.equal(bundle.manifestSource, 'snapshot')
    assert.equal(bundle.manifestSha256, run.manifestSha256)
    assert.equal(bundle.manifest?.id, entry.manifest.id)
    assert.equal(bundle.manifest?.name, entry.manifest.name)
  })
})

test('buildWrapperReproducibilityBundle throws a clear error for an unknown run', () => {
  withHarness(({ agentDir }) => {
    assert.throws(
      () => buildWrapperReproducibilityBundle('wrun_does_not_exist', agentDir),
      /Run not found/
    )
  })
})

test('buildWrapperReproducibilityBundle audits completeness honestly and populates rerunGuide', () => {
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
    const runDir = join(getWrapperRunsDir(agentDir), run.runId)

    // Partial run directory: missing runtime.json, qc.json, params.json, outputs.json -> incomplete.
    const partial = buildWrapperReproducibilityBundle(run.runId, agentDir)
    assert.equal(partial.completeness.complete, false)
    assert.ok(partial.completeness.present.includes('manifest_snapshot'))
    const missingItems = partial.completeness.missing.map((m) => m.item)
    assert.ok(missingItems.includes('params'))
    assert.ok(missingItems.includes('host_provenance'))
    assert.ok(missingItems.includes('container_digests'))
    assert.ok(missingItems.includes('qc_summary'))
    assert.equal(partial.rerunGuide.wrapperId, 'phi/ngs/fastq-qc')
    assert.equal(partial.rerunGuide.commandHint, plan.commandPlan.command)

    // Populate all evidence files -> complete === true.
    writeFileSync(
      join(runDir, 'params.json'),
      JSON.stringify({ reads: 'data/*.fastq.gz' }),
      'utf-8'
    )
    writeFileSync(join(runDir, 'outputs.json'), JSON.stringify({ outputs: [] }), 'utf-8')
    writeFileSync(
      join(runDir, 'runtime.json'),
      JSON.stringify({
        capturedAt: '2026-11-23T00:00:00.000Z',
        host: { platform: 'darwin', arch: 'arm64', release: '24.0.0' },
        nextflow: {
          source: 'managed',
          version: '24.10.0',
          envId: 'env-nf-1',
          lockSha256: 'a'.repeat(64)
        },
        containerRuntime: {
          engine: 'docker',
          version: '27.0.0',
          images: [
            {
              ref: 'quay.io/biocontainers/fastqc:0.12.1',
              digest: 'sha256:' + 'b'.repeat(64),
              status: 'verified'
            }
          ]
        }
      }),
      'utf-8'
    )
    writeFileSync(
      join(runDir, 'qc.json'),
      JSON.stringify({
        capturedAt: '2026-11-23T00:00:01.000Z',
        entries: [
          { tool: 'fastqc', sourcePath: 'fastqc_data.txt', metrics: { totalSequences: 1000 } }
        ]
      }),
      'utf-8'
    )

    const full = buildWrapperReproducibilityBundle(run.runId, agentDir)
    assert.equal(full.completeness.complete, true)
    assert.deepEqual(full.completeness.missing, [])
    assert.equal(full.rerunGuide.nextflowVersion, '24.10.0')
    assert.equal(full.rerunGuide.nextflowLockSha256, 'a'.repeat(64))
    assert.equal(full.rerunGuide.containerEngine, 'docker')
    assert.equal(full.rerunGuide.pinnedImages.length, 1)
    assert.equal(full.rerunGuide.pinnedImages[0]?.status, 'verified')
  })
})
