import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runSlurmWrapperExecution } from '../src/main/agent/wrappers/executor-slurm-submit'
import { createWrapperRunPlan } from '../src/main/agent/wrappers/plans'
import { cancelWrapperRun } from '../src/main/agent/wrappers/runs'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import {
  getWrapperRunsDir,
  readWrapperRun,
  readWrapperRunEvents
} from '../src/main/agent/wrappers/store'
import type { WrapperRun, WrapperRunPlan } from '../src/main/agent/wrappers/types'
import { installLegacyFastqQcWrapper } from './helpers/wrapperFixtures'
import { fakeLaunchClaimCommand } from './helpers/fakeLaunchClaims'
import type { RemoteDoctorReport } from '../src/shared/remoteDoctorTypes'

const REMOTE_RUN_DIR_PREFIX = '/data/lab/.phi/wrappers/runs'
const FAKE_CONNECTION = { host: 'lab-hpc.example.edu' }

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
  claims = new Set<string>()
  submitCommands = 0
  submitFault: 'before' | 'after' | undefined
  private jobOutcomes = new Map<string, { state: string; exitCode: number; exitSignal?: number }>()
  private nextJobId = 7000
  closed = false

  constructor(
    private readonly defaultOutcome:
      { state: string; exitCode: number; exitSignal?: number } | 'untracked',
    private readonly inputProbeCode?: number,
    private readonly preflightCode = 0
  ) {}

  async exec(command: string): Promise<RemoteExecResult> {
    const claim = fakeLaunchClaimCommand(command, this.claims)
    if (claim) return claim
    if (command.startsWith('bash -c ') && command.includes('#!/usr/bin/env bash')) {
      return {
        stdout: '',
        stderr: this.preflightCode ? '模块加载失败' : '',
        code: this.preflightCode,
        signal: null
      }
    }
    if (command.startsWith('bash -c ')) {
      return {
        stdout: this.inputProbeCode === undefined ? '/cluster/data\0' : '',
        stderr: '',
        code: this.inputProbeCode ?? 0,
        signal: null
      }
    }
    if (command.startsWith('sbatch ')) {
      this.submitCommands += 1
      const fault = this.submitFault
      this.submitFault = undefined
      if (fault === 'before') throw new Error('SSH closed before sbatch')
      const jobId = String(this.nextJobId++)
      if (this.defaultOutcome !== 'untracked') {
        this.jobOutcomes.set(jobId, this.defaultOutcome)
      }
      if (fault === 'after') throw new Error('SSH closed after sbatch')
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
      const runId = [...this.files.entries()]
        .find(([path]) => path.endsWith('/.phi-launch-claim/run-id'))?.[1]
        .trim()
      return {
        stdout: `JobId=${jobId} JobName=phi-${runId ?? 'test'}\n   JobState=${outcome.state} Reason=None\n   ExitCode=${outcome.exitCode}:${outcome.exitSignal ?? 0}\n`,
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
        stdout: `${jobId}|${outcome.state}|${outcome.exitCode}:${outcome.exitSignal ?? 0}\n`,
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
    return this.files.has(remotePath) || this.claims.has(remotePath)
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

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for cancellation to settle')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function writeFastqPair(projectDir: string, sample: string): void {
  mkdirSync(join(projectDir, 'data'), { recursive: true })
  writeFileSync(join(projectDir, 'data', `${sample}_R1.fastq.gz`), 'r1')
  writeFileSync(join(projectDir, 'data', `${sample}_R2.fastq.gz`), 'r2')
}

/** A remote plan with a server-side input snapshot for the fake cluster. */
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
  const reads = '/cluster/data/*_{R1,R2}.fastq.gz'
  return {
    ...localPlan,
    executor: 'slurm-controller',
    profile: 'slurm',
    params: { ...localPlan.params, reads },
    inputs: localPlan.inputs.map((input) => ({
      ...input,
      source: 'remote' as const,
      userValue: reads,
      localPaths: [],
      remotePaths: [reads]
    }))
  }
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
    assert.match(result.inputWarnings?.join('\n') ?? '', /尚未确认匹配文件/)
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
    assert.match(
      cluster.files.get(`${remoteRunDir}/nextflow.config`) ?? '',
      /process\.executor = 'slurm'/
    )
    assert.match(cluster.files.get(`${remoteRunDir}/launch.sh`) ?? '', /'-c' 'nextflow\.config'/)

    // Reconnect metadata, for a future reconciliation pass.
    const snapshotPath = join(getWrapperRunsDir(agentDir), run.runId, 'remote.snapshot.json')
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'))
    assert.equal(snapshot.remoteRunDir, remoteRunDir)
    assert.equal(typeof snapshot.jobId, 'string')

    assert.equal(cluster.closed, true)
  }))

test('Slurm head jobs collect reports from the submitted external output scope', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createSlurmPlan(agentDir, projectDir)
    const outputRoot = '/scratch/phi-slurm-reports'
    const configured = { ...plan, params: { ...plan.params, outdir: outputRoot } }
    const run = runFromPlan(configured)
    const remoteRunDir = `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`
    run.outDir = outputRoot
    run.remote = {
      host: FAKE_CONNECTION.host,
      runDir: remoteRunDir,
      workspaceRoot: '/data/lab/.phi',
      outputRoot,
      externalOutputAuthorized: true
    }
    const cluster = new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 })
    cluster.files.set(`${outputRoot}/results/multiqc_report.html`, '<html></html>')

    const result = await runSlurmWrapperExecution(run, configured, {
      agentDir,
      remoteRunDir,
      connection: FAKE_CONNECTION,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })

    const report = result.outputs?.find((output) => output.id === 'report')
    assert.equal(result.state, 'completed')
    assert.equal(report?.path, `${outputRoot}/results/multiqc_report.html`)
    assert.equal(report?.exists, true)
  }))

test('fresh Doctor blocks missing Slurm and keeps a restored sbatch target', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const base = await createSlurmPlan(agentDir, projectDir)
    const plan: WrapperRunPlan = {
      ...base,
      profile: 'slurm-controller',
      nextflowProfile: 'slurm',
      targetSelection: {
        projectId: 'project-a',
        projectLocation: { kind: 'local', path: projectDir, realPath: projectDir },
        target: 'remote',
        reason: '已选择集群',
        hostProfileId: 'host-a',
        hostAlias: FAKE_CONNECTION.host,
        connectionId: 'connection-a',
        remoteRoot: '/data/lab/.phi',
        scheduler: 'slurm',
        controller: 'sbatch',
        runtime: 'singularity'
      }
    }
    const run = runFromPlan(plan)
    const cluster = new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 })
    const checks = [
      'ssh',
      'sftp',
      'path',
      'path_read',
      'path_write',
      'shell',
      'nextflow',
      'java',
      'slurm_submit',
      'slurm_status',
      'slurm_detail',
      'slurm_cancel'
    ].map((id) => ({
      id,
      status: id === 'slurm_submit' ? ('error' as const) : ('ok' as const),
      message: id === 'slurm_submit' ? '未找到 sbatch' : id
    }))
    const report: RemoteDoctorReport = {
      hostProfileId: 'host-a',
      checkedAt: new Date().toISOString(),
      ok: false,
      checks
    }
    const result = await runSlurmWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir: `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`,
      connection: FAKE_CONNECTION,
      hpc: { scheduler: 'slurm', controller: 'sbatch', runtime: 'singularity' },
      connectImpl: async () => cluster,
      doctorImpl: async () => report
    })
    assert.equal(result.state, 'failed')
    assert.match(result.environmentError ?? '', /sbatch/)
    assert.equal(cluster.files.size, 0, 'no upload or sbatch is allowed')
    assert.equal(cluster.closed, false, 'the execution session was never opened')

    const ready: RemoteDoctorReport = {
      ...report,
      ok: true,
      checks: checks.map((check) => ({
        ...check,
        status: ['nextflow', 'java'].includes(check.id) ? ('warning' as const) : ('ok' as const)
      }))
    }
    const restored = new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 })
    const second = runFromPlan(plan)
    const submitted = await runSlurmWrapperExecution(second, plan, {
      agentDir,
      remoteRunDir: `${REMOTE_RUN_DIR_PREFIX}/${second.runId}`,
      connection: FAKE_CONNECTION,
      hpc: {
        scheduler: 'slurm',
        controller: 'sbatch',
        runtime: 'singularity',
        queue: 'cpu',
        account: 'lab1',
        controllerOptions: '--qos=normal'
      },
      connectImpl: async () => restored,
      doctorImpl: async () => ready,
      pollIntervalMs: 1
    })
    assert.equal(submitted.state, 'completed')
    assert.match(submitted.environmentWarnings?.join('\n') ?? '', /nextflow|java/)
    assert.match(
      restored.files.get(`${REMOTE_RUN_DIR_PREFIX}/${second.runId}/nextflow.config`) ?? '',
      /process\.executor = 'slurm'/
    )
    assert.match(
      restored.files.get(`${REMOTE_RUN_DIR_PREFIX}/${second.runId}/job.sbatch`) ?? '',
      /#SBATCH --partition=cpu[\s\S]*#SBATCH --account=lab1[\s\S]*#SBATCH --qos=normal/
    )

    const unavailable = new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 }, undefined, 1)
    const third = runFromPlan(plan)
    const refused = await runSlurmWrapperExecution(third, plan, {
      agentDir,
      remoteRunDir: `${REMOTE_RUN_DIR_PREFIX}/${third.runId}`,
      connection: FAKE_CONNECTION,
      hpc: {
        scheduler: 'slurm',
        controller: 'sbatch',
        runtime: 'singularity',
        setupCommands: ['module load nextflow']
      },
      connectImpl: async () => unavailable,
      doctorImpl: async () => ready
    })
    assert.equal(refused.state, 'failed')
    assert.match(refused.environmentError ?? '', /模块加载失败/)
    assert.equal(unavailable.files.size, 0, 'failed setup stops before upload and sbatch')
  }))

test('missing remote input stops Slurm submission before any bundle upload', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createSlurmPlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    run.inputReferences = [
      {
        id: 'reads',
        kind: 'path',
        source: 'remote',
        userValue: '/cluster/missing.fq',
        localPaths: [],
        remotePaths: ['/cluster/missing.fq']
      }
    ]
    const cluster = new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 }, 41)
    const result = await runSlurmWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir: `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`,
      connection: FAKE_CONNECTION,
      connectImpl: async () => cluster
    })
    assert.equal(result.state, 'failed')
    assert.match(result.inputErrors?.join('\n') ?? '', /reads.*不存在.*\/cluster\/missing\.fq/)
    assert.equal(cluster.files.size, 0)
    assert.equal(cluster.closed, true)
  }))

test('an uncertain Slurm receipt is recorded as lost with a recoverable run snapshot', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createSlurmPlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    const remoteRunDir = `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`
    const cluster = new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 })
    cluster.submitFault = 'after'
    const result = await runSlurmWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir,
      connection: FAKE_CONNECTION,
      connectImpl: async () => cluster
    })
    assert.equal(result.state, 'lost')
    assert.equal(result.launchUnknown, true)
    assert.match(result.launchDiagnostic ?? '', /请勿重复提交/)
    const snapshot = JSON.parse(
      readFileSync(join(getWrapperRunsDir(agentDir), run.runId, 'remote.snapshot.json'), 'utf8')
    )
    assert.equal(snapshot.remoteRunDir, remoteRunDir)
    assert.equal(snapshot.launchUnknown, true)
    assert.equal(cluster.submitCommands, 1)
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

for (const cancellation of [
  {
    title:
      'runSlurmWrapperExecution finalizes as cancelled, not failed, when cancelWrapperRun raced the poll loop',
    outcome: { state: 'CANCELLED', exitCode: 0 }
  },
  {
    title: 'runSlurmWrapperExecution accepts FAILED 0:15 after a persisted cancel request',
    outcome: { state: 'FAILED', exitCode: 0, exitSignal: 15 }
  }
]) {
  test(cancellation.title, () =>
    withHarness(async ({ agentDir, projectDir }) => {
      const plan = await createSlurmPlan(agentDir, projectDir)
      const run = runFromPlan(plan)
      const remoteRunDir = `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`
      const cluster = new FakeSlurmHost(cancellation.outcome)
      const realExec = cluster.exec.bind(cluster)
      let cancelRequested = false
      let signalDelivered = false
      let releaseCleanup!: () => void
      const cleanupBlocked = new Promise<void>((resolve) => {
        releaseCleanup = resolve
      })
      cluster.exec = async (command: string): Promise<RemoteExecResult> => {
        if (command.startsWith('squeue -h -j ') && !signalDelivered) {
          if (!cancelRequested) {
            cancelRequested = true
            const requested = cancelWrapperRun(run.runId, agentDir, {
              connection: FAKE_CONNECTION,
              remoteWorkspaceRoot: '/data/lab/.phi',
              connectImpl: async () => cluster
            })
            assert.equal(requested.state, 'cancelling')
          }
          return { stdout: 'RUNNING\n', stderr: '', code: 0, signal: null }
        }
        if (command.includes(' --full --signal=TERM ')) {
          signalDelivered = true
          return { stdout: '', stderr: '', code: 0, signal: null }
        }
        const result = await realExec(command)
        if (command === 'squeue -u "$USER" -h -o "%i|%T|%Z"') await cleanupBlocked
        return result
      }

      const pollingResult = await runSlurmWrapperExecution(run, plan, {
        agentDir,
        remoteRunDir,
        connection: FAKE_CONNECTION,
        connectImpl: async () => cluster,
        pollIntervalMs: 1
      })

      assert.equal(pollingResult.state, 'cancelling')
      assert.equal(readWrapperRun(run.runId, agentDir)?.state, 'cancelling')
      releaseCleanup()
      await waitFor(() => readWrapperRun(run.runId, agentDir)?.state !== 'cancelling')
      assert.equal(readWrapperRun(run.runId, agentDir)?.state, 'cancelled')
      assert.ok(
        readWrapperRunEvents(run.runId, agentDir).some(
          (event) => event.type === 'run_state_changed' && event.state === 'cancelled'
        )
      )
    })
  )
}

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
