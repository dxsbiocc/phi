import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runSlurmWrapperExecution } from '../src/main/agent/wrappers/executor-slurm-submit'
import { createWrapperRunPlan } from '../src/main/agent/wrappers/plans'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import { getWrapperRunsDir, writeWrapperRun } from '../src/main/agent/wrappers/store'
import type { WrapperRun, WrapperRunPlan } from '../src/main/agent/wrappers/types'
import { installLegacyFastqQcWrapper } from './helpers/wrapperFixtures'

const REMOTE_RUN_DIR_PREFIX = '/data/lab/.phi/wrappers/runs'
const FAKE_CONNECTION = { host: 'lab-hpc.example.edu', username: 'agent', privateKey: 'fake' }

/**
 * In-memory fake `RemoteSshSession` covering exactly the commands
 * `runSlurmWrapperExecution` + `SbatchRunner` issue: `mkdir -p` (via
 * `mkdirp`), `sbatch`, `squeue`, `sacct`. `squeue` here never reports a job
 * as still queued — every submitted job resolves on the first `status()`
 * poll, to whatever outcome the cluster was constructed with. That keeps
 * these tests instant and deterministic instead of racing a real timer.
 */
class FakeSlurmHost implements RemoteSshSession {
  files = new Map<string, string>()
  private jobOutcomes = new Map<string, { state: string; exitCode: number }>()
  private nextJobId = 7000
  closed = false

  constructor(private readonly defaultOutcome: { state: string; exitCode: number } | 'untracked') {}

  async exec(command: string): Promise<RemoteExecResult> {
    if (command.startsWith('sbatch ')) {
      const jobId = String(this.nextJobId++)
      if (this.defaultOutcome !== 'untracked') {
        this.jobOutcomes.set(jobId, this.defaultOutcome)
      }
      return { stdout: `Submitted batch job ${jobId}\n`, stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('squeue ')) {
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('scontrol show job ')) {
      const jobId = command.match(/^scontrol show job (\S+)/)?.[1]
      const outcome = jobId !== undefined ? this.jobOutcomes.get(jobId) : undefined
      if (!outcome) {
        return {
          stdout: '',
          stderr: 'scontrol: error: Invalid job id specified\n',
          code: 1,
          signal: null
        }
      }
      return {
        stdout: `JobId=${jobId} JobName=phi-test\n   JobState=${outcome.state} Reason=None\n   ExitCode=${outcome.exitCode}:0\n`,
        stderr: '',
        code: 0,
        signal: null
      }
    }
    if (command.startsWith('sacct ')) {
      const jobId = command.match(/-j (\S+)/)?.[1]
      const outcome = jobId !== undefined ? this.jobOutcomes.get(jobId) : undefined
      if (!outcome) return { stdout: '', stderr: '', code: 0, signal: null }
      return {
        stdout: `${jobId}|${outcome.state}|${outcome.exitCode}:0\n`,
        stderr: '',
        code: 0,
        signal: null
      }
    }
    if (command.startsWith('mkdir -p')) {
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    throw new Error(`FakeSlurmHost: unhandled command: ${command}`)
  }

  async readTextFile(remotePath: string): Promise<string> {
    const content = this.files.get(remotePath)
    if (content === undefined) throw new Error(`no such file: ${remotePath}`)
    return content
  }

  async writeTextFile(remotePath: string, content: string): Promise<void> {
    this.files.set(remotePath, content)
  }

  async mkdirp(): Promise<void> {
    // Nothing to track — the fake filesystem is a flat Map, not a tree.
  }

  async exists(remotePath: string): Promise<boolean> {
    return this.files.has(remotePath)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function withHarness<T>(
  callback: (h: { agentDir: string; projectDir: string }) => Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-slurm-submit-'))
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

/** A `slurm-controller` plan — `plans.ts` always produces `executor: 'local'` (Phase 2's resolver isn't built yet), so this hand-overrides it, same as the executor-slurm.ts fixtures do. */
async function createSlurmPlan(agentDir: string, projectDir: string): Promise<WrapperRunPlan> {
  const entry = installLegacyFastqQcWrapper(agentDir, projectDir)
  writeFastqPair(projectDir, 'S1')
  const localPlan = createWrapperRunPlan({
    actor: 'agent',
    wrapper: entry,
    params: { reads: 'data/*_{R1,R2}.fastq.gz' },
    cwd: projectDir,
    agentDir
  })
  return { ...localPlan, executor: 'slurm-controller', profile: 'slurm' }
}

function runFromPlan(plan: WrapperRunPlan): WrapperRun {
  const now = new Date().toISOString()
  return {
    runId: `wrun_${randomUUID()}`,
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

test('runSlurmWrapperExecution uploads the wrapper bundle, submits via sbatch, and collects outputs on success', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createSlurmPlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    const remoteRunDir = `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`
    const cluster = new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 })
    // The primary output exists on the remote host; the secondary doesn't
    // — exercises both branches of collectRemoteOutputs' exists check.
    cluster.files.set(`${remoteRunDir}/output/results/multiqc_report.html`, '<html></html>')

    const result = await runSlurmWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir,
      connection: FAKE_CONNECTION,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })

    assert.equal(result.state, 'completed')
    assert.equal(result.exitCode, 0)
    assert.ok(result.outputs && result.outputs.length >= 2)
    const report = result.outputs?.find((o) => o.id === 'report')
    assert.equal(report?.exists, true)
    assert.equal(report?.location, 'remote')
    const metrics = result.outputs?.find((o) => o.id === 'metrics')
    assert.equal(metrics?.exists, false)

    // Bundle upload: the installed wrapper's manifest + source marker land
    // under <remoteRunDir>/wrapper/.
    assert.ok(cluster.files.has(`${remoteRunDir}/wrapper/wrapper.yaml`))
    assert.ok(cluster.files.has(`${remoteRunDir}/wrapper/.source.json`))

    // Launch bundle written by SbatchRunner.submit. Every token is shell-quoted individually.
    assert.match(cluster.files.get(`${remoteRunDir}/launch.sh`) ?? '', /'nextflow' 'run'/)
    assert.ok(cluster.files.get(`${remoteRunDir}/job.sbatch`)?.includes('bash launch.sh'))
    assert.ok(cluster.files.has(`${remoteRunDir}/params.json`))

    // Reconnect metadata, for a future reconciliation pass.
    const snapshotPath = join(getWrapperRunsDir(agentDir), run.runId, 'remote.snapshot.json')
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'))
    assert.equal(snapshot.remoteRunDir, remoteRunDir)
    assert.equal(typeof snapshot.jobId, 'string')

    assert.equal(cluster.closed, true)
  }))

test('runSlurmWrapperExecution fails the run when the wrapper is not installed', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createSlurmPlan(agentDir, projectDir)
    const run: WrapperRun = {
      ...runFromPlan(plan),
      wrapper: { ...plan.wrapper, canonicalId: 'phi/ngs/does-not-exist', version: '9.9.9' }
    }

    const result = await runSlurmWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir: `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`,
      connection: FAKE_CONNECTION,
      connectImpl: async () => new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 })
    })

    assert.equal(result.state, 'failed')
  }))

test('runSlurmWrapperExecution fails the run when the remote host cannot be reached', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createSlurmPlan(agentDir, projectDir)
    const run = runFromPlan(plan)

    const result = await runSlurmWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir: `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`,
      connection: FAKE_CONNECTION,
      connectImpl: async () => {
        throw new Error('ECONNREFUSED')
      }
    })

    assert.equal(result.state, 'failed')
  }))

test('runSlurmWrapperExecution fails the run and records the exit code when the Slurm job fails', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createSlurmPlan(agentDir, projectDir)
    const run = runFromPlan(plan)

    const result = await runSlurmWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir: `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`,
      connection: FAKE_CONNECTION,
      connectImpl: async () => new FakeSlurmHost({ state: 'FAILED', exitCode: 1 }),
      pollIntervalMs: 1
    })

    assert.equal(result.state, 'failed')
    assert.equal(result.exitCode, 1)
  }))

test('runSlurmWrapperExecution finalizes as cancelled, not failed, when cancelWrapperRun raced the poll loop', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createSlurmPlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    // Slurm reports a scancel'd job the same way it reports any other
    // non-zero-exit job (a FAILED_STATES entry) — runSlurmWrapperExecution
    // has to re-check the run's live state to tell the two apart.
    const cluster = new FakeSlurmHost({ state: 'CANCELLED', exitCode: 0 })
    const realExec = cluster.exec.bind(cluster)
    cluster.exec = async (command: string): Promise<RemoteExecResult> => {
      const result = await realExec(command)
      if (command.startsWith('sbatch ')) {
        // Simulate cancelWrapperRun landing concurrently, right after this
        // app session's own submit — before the first status() poll.
        writeWrapperRun(
          { ...run, state: 'cancelling', updatedAt: new Date().toISOString() },
          agentDir
        )
      }
      return result
    }

    const result = await runSlurmWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir: `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`,
      connection: FAKE_CONNECTION,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })

    assert.equal(result.state, 'cancelled')
  }))

test('runSlurmWrapperExecution marks the run lost when Slurm loses track of the job', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createSlurmPlan(agentDir, projectDir)
    const run = runFromPlan(plan)

    const result = await runSlurmWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir: `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`,
      connection: FAKE_CONNECTION,
      connectImpl: async () => new FakeSlurmHost('untracked'),
      pollIntervalMs: 1
    })

    assert.equal(result.state, 'lost')
  }))
