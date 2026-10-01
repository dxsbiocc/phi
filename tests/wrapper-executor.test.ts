import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { SpawnOptions } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { describeEnvironment } from '../src/main/agent/content'
import { currentPlatform } from '../src/main/agent/envs'
import type { RunLocalWrapperOptions, SpawnImpl } from '../src/main/agent/wrappers/executor-local'
import { runLocalWrapperExecution } from '../src/main/agent/wrappers/executor-local'
import { NEXTFLOW_ENVIRONMENT_REF } from '../src/main/agent/wrappers/composition/nextflow-launch'
import { createWrapperRunPlan } from '../src/main/agent/wrappers/plans'
import { readWrapperRun } from '../src/main/agent/wrappers/store'
import type { WrapperRun, WrapperRunPlan } from '../src/main/agent/wrappers/types'
import { copyMinimal, installReady, shell } from './helpers/fakeEnvironment'
import { installLegacyFastqQcWrapper } from './helpers/wrapperFixtures'

const OK_DOCTOR = (): { ok: true; checks: [] } => ({ ok: true, checks: [] })

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

interface SpawnObservation {
  command: string
  args: readonly string[]
  options: SpawnOptions
}

/** Simulates Nextflow exiting with `exitCode`, optionally writing files as if it had run. */
function fakeSpawn(exitCode: number, onSpawn?: (observation: SpawnObservation) => void): SpawnImpl {
  return ((
    command: string,
    args: readonly string[] = [],
    options: SpawnOptions = {}
  ): FakeChildProcess => {
    const child = new FakeChildProcess()
    setTimeout(() => {
      onSpawn?.({ command, args, options })
      child.stdout.emit('data', Buffer.from('nextflow fixture output\n'))
      child.emit('close', exitCode)
    }, 5)
    return child
  }) as unknown as SpawnImpl
}

function withHarness<T>(
  callback: (h: {
    root: string
    agentDir: string
    projectDir: string
    runtimeRoot: string
    environmentsDir: string
    envId: string
    prefix: string
    nextflowLaunch: NonNullable<RunLocalWrapperOptions['nextflowLaunch']>
  }) => Promise<T>
): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-wrapper-executor-')))
  const agentDir = join(root, '.phi-home')
  const projectDir = join(root, 'project')
  const runtimeRoot = join(root, 'runtime')
  const environmentsDir = join(root, 'environments')
  const platform = currentPlatform()
  mkdirSync(projectDir, { recursive: true })
  copyMinimal(join(environmentsDir, 'phi-nextflow'), 'phi-nextflow')
  const descriptor = describeEnvironment(NEXTFLOW_ENVIRONMENT_REF, { environmentsDir, platform })
  const envId = installReady(runtimeRoot, descriptor, { nextflow: shell(['exit 0']) })
  const prefix = join(runtimeRoot, 'envs', envId)
  const nextflowLaunch = {
    runtimeRoot,
    environmentsDir,
    platform,
    hostNextflowPath: () => undefined,
    baseEnv: { HOME: root, PATH: '/host/bin' }
  }
  return callback({
    root,
    agentDir,
    projectDir,
    runtimeRoot,
    environmentsDir,
    envId,
    prefix,
    nextflowLaunch
  }).finally(() => rmSync(root, { recursive: true, force: true }))
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
  await withHarness(async ({ agentDir, projectDir, envId, prefix, nextflowLaunch }) => {
    const plan = await createSubmittablePlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    const absoluteOutDir = join(projectDir, plan.outputDir)
    let spawned: SpawnObservation | undefined

    const result = await runLocalWrapperExecution(run, plan, {
      agentDir,
      nextflowLaunch,
      doctorImpl: OK_DOCTOR,
      spawnImpl: fakeSpawn(0, (observation) => {
        spawned = observation
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
    assert.equal(spawned?.command, join(prefix, 'bin', 'nextflow'))
    assert.equal(spawned?.options.env?.PHI_ENV_ID, envId)
    assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'nextflow.json'), 'utf-8')), {
      source: 'managed',
      ref: NEXTFLOW_ENVIRONMENT_REF,
      envId,
      resolvedCommand: join(prefix, 'bin', 'nextflow')
    })
  })
})

test('a non-zero Nextflow exit code marks the run failed without collecting outputs', async () => {
  await withHarness(async ({ agentDir, projectDir, nextflowLaunch }) => {
    const plan = await createSubmittablePlan(agentDir, projectDir)
    const run = runFromPlan(plan)

    const result = await runLocalWrapperExecution(run, plan, {
      agentDir,
      nextflowLaunch,
      doctorImpl: OK_DOCTOR,
      spawnImpl: fakeSpawn(1)
    })

    assert.equal(result.state, 'failed')
    assert.equal(result.exitCode, 1)
    assert.equal(result.outputs, undefined)
  })
})

test('a failed local doctor check fails the run before spawning anything', async () => {
  await withHarness(async ({ agentDir, projectDir, nextflowLaunch }) => {
    const plan = await createSubmittablePlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    let spawnCalled = false

    const result = await runLocalWrapperExecution(run, plan, {
      agentDir,
      nextflowLaunch,
      doctorImpl: () => ({ ok: false, checks: [{ id: 'docker', label: 'Docker', ok: false }] }),
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
  await withHarness(async ({ agentDir, projectDir, nextflowLaunch }) => {
    const plan = await createSubmittablePlan(agentDir, projectDir)
    const run = { ...runFromPlan(plan), wrapper: { ...plan.wrapper, version: '9.9.9' } }

    const result = await runLocalWrapperExecution(run, plan, {
      agentDir,
      nextflowLaunch,
      doctorImpl: OK_DOCTOR
    })
    assert.equal(result.state, 'failed')
  })
})

test('an explicit supported host nextflow is used and an old one is rejected', async () => {
  await withHarness(async ({ root, agentDir, projectDir, runtimeRoot }) => {
    const acceptedPlan = await createSubmittablePlan(agentDir, projectDir)
    const acceptedRun = runFromPlan(acceptedPlan)
    let command: string | undefined
    const accepted = await runLocalWrapperExecution(acceptedRun, acceptedPlan, {
      agentDir,
      doctorImpl: OK_DOCTOR,
      nextflowLaunch: {
        runtimeRoot,
        hostNextflowPath: () => process.execPath,
        readVersion: () => Promise.resolve('25.10.0'),
        baseEnv: { HOME: root, PATH: '/host/bin' }
      },
      spawnImpl: fakeSpawn(0, (observation) => {
        command = observation.command
      })
    })
    assert.equal(accepted.state, 'completed')
    assert.equal(command, process.execPath)
    const acceptedRecord = JSON.parse(
      readFileSync(join(agentDir, 'wrappers', 'runs', acceptedRun.runId, 'nextflow.json'), 'utf-8')
    )
    assert.equal(acceptedRecord.source, 'host')
    assert.equal(acceptedRecord.version, '25.10.0')

    const rejectedPlan = await createSubmittablePlan(agentDir, projectDir)
    const rejectedRun = runFromPlan(rejectedPlan)
    let spawned = false
    const rejected = await runLocalWrapperExecution(rejectedRun, rejectedPlan, {
      agentDir,
      doctorImpl: OK_DOCTOR,
      nextflowLaunch: {
        runtimeRoot,
        hostNextflowPath: () => process.execPath,
        readVersion: () => Promise.resolve('22.10.6')
      },
      spawnImpl: fakeSpawn(0, () => {
        spawned = true
      })
    })
    assert.equal(rejected.state, 'failed')
    assert.match(rejected.environmentError ?? '', /22\.10\.6/)
    assert.match(rejected.environmentError ?? '', /25\.04\.0/)
    assert.equal(spawned, false)
  })
})

test('a not-ready managed environment fails with the gate message before spawn', async () => {
  await withHarness(async ({ root, agentDir, projectDir, environmentsDir }) => {
    const plan = await createSubmittablePlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    let spawned = false
    const result = await runLocalWrapperExecution(run, plan, {
      agentDir,
      doctorImpl: OK_DOCTOR,
      nextflowLaunch: {
        runtimeRoot: join(root, 'not-ready-runtime'),
        environmentsDir,
        platform: currentPlatform(),
        hostNextflowPath: () => undefined
      },
      spawnImpl: fakeSpawn(0, () => {
        spawned = true
      })
    })
    assert.equal(result.state, 'failed')
    assert.equal(
      result.environmentError,
      `environment ${NEXTFLOW_ENVIRONMENT_REF} is not ready; the user must build it first`
    )
    assert.equal(spawned, false)
  })
})

test('the plan runner applies the shared conda-profile config and environment', async () => {
  await withHarness(async ({ agentDir, projectDir, runtimeRoot, prefix, nextflowLaunch }) => {
    const original = await createSubmittablePlan(agentDir, projectDir)
    const plan = { ...original, nextflowProfile: 'conda' }
    const run = runFromPlan(plan)
    let spawned: SpawnObservation | undefined
    const result = await runLocalWrapperExecution(run, plan, {
      agentDir,
      nextflowLaunch,
      micromambaPath: process.execPath,
      doctorImpl: OK_DOCTOR,
      spawnImpl: fakeSpawn(0, (observation) => {
        spawned = observation
      })
    })
    assert.equal(result.state, 'completed')
    const configIndex = spawned?.args.indexOf('-c') ?? -1
    assert.ok(configIndex >= 0)
    const configPath = spawned?.args[configIndex + 1]
    assert.equal(typeof configPath, 'string')
    assert.match(readFileSync(configPath as string, 'utf-8'), /useMicromamba = true/)
    assert.match(
      readFileSync(configPath as string, 'utf-8'),
      new RegExp(`cacheDir = '${join(runtimeRoot, 'nextflow-conda')}'`)
    )
    assert.equal(spawned?.options.env?.MAMBA_ROOT_PREFIX, runtimeRoot)
    assert.equal(spawned?.options.env?.MAMBARC, join(runtimeRoot, 'mambarc'))
    assert.equal(spawned?.options.env?.CONDA_PREFIX, undefined)
    assert.equal(spawned?.options.env?.PATH?.startsWith(`${dirname(process.execPath)}:`), true)
    assert.match(spawned?.options.env?.PATH ?? '', new RegExp(`${prefix}/bin`))
    assert.ok(existsSync(join(runtimeRoot, 'nextflow-conda')))
    assert.ok(existsSync(join(runtimeRoot, 'mambarc')))
  })
})
