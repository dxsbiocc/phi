import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { SpawnImpl } from '../src/main/agent/wrappers/executor-local'
import { runLocalWrapperExecution } from '../src/main/agent/wrappers/executor-local'
import { createWrapperRunPlan } from '../src/main/agent/wrappers/plans'
import { readWrapperRun } from '../src/main/agent/wrappers/store'
import type { WrapperRun, WrapperRunPlan } from '../src/main/agent/wrappers/types'
import { installLegacyFastqQcWrapper } from './helpers/wrapperFixtures'

const OK_DOCTOR = (): { ok: true; checks: [] } => ({ ok: true, checks: [] })

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

/** Simulates Nextflow exiting with `exitCode`, optionally writing files as if it had run. */
function fakeSpawn(exitCode: number, onSpawn?: () => void): SpawnImpl {
  return ((): FakeChildProcess => {
    const child = new FakeChildProcess()
    setTimeout(() => {
      onSpawn?.()
      child.stdout.emit('data', Buffer.from('nextflow fixture output\n'))
      child.emit('close', exitCode)
    }, 5)
    return child
  }) as unknown as SpawnImpl
}

function withHarness<T>(
  callback: (h: { agentDir: string; projectDir: string }) => Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-executor-'))
  const agentDir = join(root, '.phi-home')
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  return callback({ agentDir, projectDir }).finally(() =>
    rmSync(root, { recursive: true, force: true })
  )
}

function writeFastqPair(projectDir: string, sample: string): void {
  mkdirSync(join(projectDir, 'data'), { recursive: true })
  writeFileSync(join(projectDir, 'data', `${sample}_R1.fastq.gz`), 'r1')
  writeFileSync(join(projectDir, 'data', `${sample}_R2.fastq.gz`), 'r2')
}

async function createSubmittablePlan(
  agentDir: string,
  projectDir: string
): Promise<WrapperRunPlan> {
  const entry = installLegacyFastqQcWrapper(agentDir, projectDir)
  writeFastqPair(projectDir, 'S1')
  return createWrapperRunPlan({
    actor: 'agent',
    wrapper: entry,
    params: { reads: 'data/*_{R1,R2}.fastq.gz' },
    cwd: projectDir,
    agentDir
  })
}

function runFromPlan(plan: WrapperRunPlan): WrapperRun {
  const now = new Date().toISOString()
  return {
    runId: `wrun_${plan.planId.replace('wplan_', '')}`,
    planId: plan.planId,
    revision: plan.revision,
    state: 'created',
    actor: plan.actor,
    wrapper: plan.wrapper,
    trustTier: plan.trustTier,
    executor: plan.executor,
    profile: plan.profile,
    cwd: plan.cwd,
    outDir: plan.outputDir,
    steps: plan.steps,
    createdAt: now,
    updatedAt: now
  }
}

test('a successful fake Nextflow run collects declared outputs and completes', async () => {
  await withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createSubmittablePlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    const absoluteOutDir = join(projectDir, plan.outputDir)

    const result = await runLocalWrapperExecution(run, plan, {
      agentDir,
      doctorImpl: OK_DOCTOR,
      spawnImpl: fakeSpawn(0, () => {
        mkdirSync(join(absoluteOutDir, 'results', 'multiqc_data'), { recursive: true })
        writeFileSync(join(absoluteOutDir, 'results', 'multiqc_report.html'), '<html></html>')
      })
    })

    assert.equal(result.state, 'completed')
    assert.equal(result.exitCode, 0)
    const report = result.outputs?.find((output) => output.id === 'report')
    assert.equal(report?.exists, true)
    const metrics = result.outputs?.find((output) => output.id === 'metrics')
    assert.equal(metrics?.exists, false)

    const persisted = readWrapperRun(run.runId, agentDir)
    assert.equal(persisted?.state, 'completed')

    const runDir = join(agentDir, 'wrappers', 'runs', run.runId)
    assert.ok(existsSync(join(runDir, 'params.json')))
    assert.ok(existsSync(join(runDir, 'outputs.json')))
    assert.ok(existsSync(join(runDir, 'summary.json')))
    assert.ok(existsSync(join(runDir, 'logs', 'stdout.log')))

    const paramsJson = JSON.parse(readFileSync(join(runDir, 'params.json'), 'utf-8'))
    assert.equal(paramsJson.outdir, absoluteOutDir)
  })
})

test('a non-zero Nextflow exit code marks the run failed without collecting outputs', async () => {
  await withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createSubmittablePlan(agentDir, projectDir)
    const run = runFromPlan(plan)

    const result = await runLocalWrapperExecution(run, plan, {
      agentDir,
      doctorImpl: OK_DOCTOR,
      spawnImpl: fakeSpawn(1)
    })

    assert.equal(result.state, 'failed')
    assert.equal(result.exitCode, 1)
    assert.equal(result.outputs, undefined)
  })
})

test('a failed local doctor check fails the run before spawning anything', async () => {
  await withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createSubmittablePlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    let spawnCalled = false

    const result = await runLocalWrapperExecution(run, plan, {
      agentDir,
      doctorImpl: () => ({ ok: false, checks: [{ id: 'nextflow', label: 'Nextflow', ok: false }] }),
      spawnImpl: ((): never => {
        spawnCalled = true
        throw new Error('should not be called')
      }) as unknown as SpawnImpl
    })

    assert.equal(result.state, 'failed')
    assert.equal(spawnCalled, false)
  })
})

test('an unknown wrapper id/version fails the run with a clear reason', async () => {
  await withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createSubmittablePlan(agentDir, projectDir)
    const run = { ...runFromPlan(plan), wrapper: { ...plan.wrapper, version: '9.9.9' } }

    const result = await runLocalWrapperExecution(run, plan, { agentDir, doctorImpl: OK_DOCTOR })
    assert.equal(result.state, 'failed')
  })
})
