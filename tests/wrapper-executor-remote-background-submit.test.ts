import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runRemoteBackgroundWrapperExecution } from '../src/main/agent/wrappers/executor-remote-background-submit'
import { createWrapperRunPlan } from '../src/main/agent/wrappers/plans'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import { getWrapperRunsDir, writeWrapperRun } from '../src/main/agent/wrappers/store'
import type { WrapperRun, WrapperRunPlan } from '../src/main/agent/wrappers/types'
import { installLegacyFastqQcWrapper } from './helpers/wrapperFixtures'
import { fakeLaunchClaimCommand } from './helpers/fakeLaunchClaims'
import type { RemoteDoctorReport } from '../src/shared/remoteDoctorTypes'

const REMOTE_RUN_DIR_PREFIX = '/data/lab/.phi/wrappers/runs'
const FAKE_CONNECTION = { host: 'lab-hpc.example.edu' }

/**
 * In-memory fake `RemoteSshSession` covering exactly what
 * `runRemoteBackgroundWrapperExecution` + `SshExecRunner` issue: the
 * composite `setsid bash ...` launch command (built by
 * `buildDetachedLaunchCommand`), `kill -0` liveness checks, and the
 * `exit_code` file `SshExecRunner.status()` reads once the process is gone.
 * Every launched process is recorded as already dead — with its outcome
 * pre-written — by the time the first `status()` poll runs, so these tests
 * are instant and deterministic, same trick as `FakeSlurmHost` in
 * wrapper-executor-slurm-submit.test.ts.
 */
class FakeDetachedHost implements RemoteSshSession {
  files = new Map<string, string>()
  claims = new Set<string>()
  launchCommands = 0
  launchFault: 'before' | 'after' | undefined
  private processes = new Map<number, boolean>()
  private nextPid = 5000
  closed = false

  constructor(
    private readonly remoteRunDir: string,
    private readonly outcome: { exitCode: number } | 'lost',
    private readonly inputProbeCode?: number
  ) {}

  async exec(command: string): Promise<RemoteExecResult> {
    const claim = fakeLaunchClaimCommand(command, this.claims)
    if (claim) return claim
    if (command.startsWith('bash -c ') && command.includes('#!/usr/bin/env bash')) {
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('bash -c ')) {
      return {
        stdout: this.inputProbeCode === undefined ? '/cluster/data\0' : '',
        stderr: '',
        code: this.inputProbeCode ?? 0,
        signal: null
      }
    }
    // Checked first: the composite launch line also *starts with* `mkdir -p`
    // — a plain startsWith check below would shadow it.
    if (command.includes('setsid bash')) {
      this.launchCommands += 1
      const fault = this.launchFault
      this.launchFault = undefined
      if (fault === 'before') throw new Error('SSH closed before detached launch')
      const pid = this.nextPid++
      this.processes.set(pid, false)
      if (this.outcome !== 'lost') {
        this.files.set(`${this.remoteRunDir}/exit_code`, `${this.outcome.exitCode}`)
      }
      this.files.set(`${this.remoteRunDir}/pid`, `${pid}`)
      if (fault === 'after') throw new Error('SSH closed after detached launch')
      return { stdout: `${pid}\n`, stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('mkdir -p')) {
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('kill -0 ')) {
      const pid = Number.parseInt(command.split(' ')[2], 10)
      const alive = this.processes.get(pid) === true
      return { stdout: alive ? 'alive\n' : 'dead\n', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('kill -TERM -')) {
      const pid = Number.parseInt(command.slice('kill -TERM -'.length), 10)
      this.processes.set(pid, false)
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    throw new Error(`FakeDetachedHost: unhandled command: ${command}`)
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
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-remote-bg-submit-'))
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

/** A `remote-background` plan — `plans.ts` never resolves to this executor (only `slurm-controller`), so this hand-overrides it, same as the slurm-controller fixtures do. */
async function createRemoteBackgroundPlan(
  agentDir: string,
  projectDir: string
): Promise<WrapperRunPlan> {
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
    executor: 'remote-background',
    profile: 'remote-background',
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

test('runRemoteBackgroundWrapperExecution uploads the wrapper bundle, launches under setsid, and collects outputs on success', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createRemoteBackgroundPlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    const remoteRunDir = `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`
    const cluster = new FakeDetachedHost(remoteRunDir, { exitCode: 0 })
    // The primary output exists on the remote host; the secondary doesn't
    // — exercises both branches of collectRemoteOutputs' exists check.
    cluster.files.set(`${remoteRunDir}/output/results/multiqc_report.html`, '<html></html>')

    const result = await runRemoteBackgroundWrapperExecution(run, plan, {
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

    // launch.sh is the raw nextflow command wrapped with an exit-code trap
    // (unlike sbatch's launch.sh, which doesn't need one — Slurm itself
    // tracks exit status).
    const launchScript = cluster.files.get(`${remoteRunDir}/launch.sh`) ?? ''
    assert.match(launchScript, /'nextflow' 'run'/)
    assert.match(launchScript, /echo "\$rc" > 'exit_code'/)
    assert.ok(cluster.files.has(`${remoteRunDir}/params.json`))
    assert.match(
      cluster.files.get(`${remoteRunDir}/nextflow.config`) ?? '',
      /process\.executor = 'local'/
    )
    assert.match(cluster.files.get(`${remoteRunDir}/launch.sh`) ?? '', /'-c' 'nextflow\.config'/)

    // Reconnect metadata, for a future reconciliation pass.
    const snapshotPath = join(getWrapperRunsDir(agentDir), run.runId, 'remote.snapshot.json')
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'))
    assert.equal(snapshot.remoteRunDir, remoteRunDir)
    assert.equal(typeof snapshot.pid, 'number')

    assert.equal(cluster.closed, true)
  }))

test('a saved external output root is used to collect remote reports', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createRemoteBackgroundPlan(agentDir, projectDir)
    const outputRoot = '/scratch/phi-run-reports'
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
    const cluster = new FakeDetachedHost(remoteRunDir, { exitCode: 0 })
    cluster.files.set(`${outputRoot}/results/multiqc_report.html`, '<html></html>')

    const result = await runRemoteBackgroundWrapperExecution(run, configured, {
      agentDir,
      remoteRunDir,
      connection: FAKE_CONNECTION,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })

    assert.equal(result.state, 'completed')
    const report = result.outputs?.find((output) => output.id === 'report')
    assert.equal(report?.path, `${outputRoot}/results/multiqc_report.html`)
    assert.equal(report?.exists, true)
  }))

test('permission-denied remote input stops detached launch before any bundle upload', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createRemoteBackgroundPlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    run.inputReferences = [
      {
        id: 'reads',
        kind: 'path',
        source: 'remote',
        userValue: '/cluster/denied.fq',
        localPaths: [],
        remotePaths: ['/cluster/denied.fq']
      }
    ]
    const remoteRunDir = `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`
    const cluster = new FakeDetachedHost(remoteRunDir, { exitCode: 0 }, 42)
    const result = await runRemoteBackgroundWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir,
      connection: FAKE_CONNECTION,
      connectImpl: async () => cluster
    })
    assert.equal(result.state, 'failed')
    assert.match(
      result.inputErrors?.join('\n') ?? '',
      /reads.*无读取或进入权限.*\/cluster\/denied\.fq/
    )
    assert.equal(cluster.files.size, 0)
    assert.equal(cluster.closed, true)
  }))

test('an uncertain detached launch is persisted without a second process', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createRemoteBackgroundPlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    const remoteRunDir = `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`
    const cluster = new FakeDetachedHost(remoteRunDir, { exitCode: 0 })
    cluster.launchFault = 'before'
    const result = await runRemoteBackgroundWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir,
      connection: FAKE_CONNECTION,
      connectImpl: async () => cluster
    })
    assert.equal(result.state, 'lost')
    assert.equal(result.launchUnknown, true)
    const snapshot = JSON.parse(
      readFileSync(join(getWrapperRunsDir(agentDir), run.runId, 'remote.snapshot.json'), 'utf8')
    )
    assert.equal(snapshot.launchUnknown, true)
    assert.equal(cluster.launchCommands, 1)
    assert.equal(cluster.processes.size, 0)
  }))

test('fresh Doctor blocks direct host execution when its selected runtime is unavailable', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const base = await createRemoteBackgroundPlan(agentDir, projectDir)
    const plan: WrapperRunPlan = {
      ...base,
      targetSelection: {
        projectId: 'project-a',
        projectLocation: { kind: 'local', path: projectDir, realPath: projectDir },
        target: 'remote',
        reason: '已选择服务器',
        hostProfileId: 'host-a',
        hostAlias: FAKE_CONNECTION.host,
        connectionId: 'connection-a',
        remoteRoot: '/data/lab/.phi',
        scheduler: 'local',
        controller: 'login',
        runtime: 'docker'
      }
    }
    const run = runFromPlan(plan)
    const remoteRunDir = `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`
    const cluster = new FakeDetachedHost(remoteRunDir, { exitCode: 0 })
    const checks = [
      'ssh',
      'sftp',
      'path',
      'path_read',
      'path_write',
      'shell',
      'nextflow',
      'java',
      'runtime'
    ].map((id) => ({
      id,
      status: id === 'runtime' ? ('error' as const) : ('ok' as const),
      message: id === 'runtime' ? 'Docker 不可用' : id
    }))
    const report: RemoteDoctorReport = {
      hostProfileId: 'host-a',
      checkedAt: new Date().toISOString(),
      ok: false,
      checks
    }
    const result = await runRemoteBackgroundWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir,
      connection: FAKE_CONNECTION,
      hpc: { scheduler: 'local', controller: 'login', runtime: 'docker' },
      connectImpl: async () => cluster,
      doctorImpl: async () => report
    })
    assert.equal(result.state, 'failed')
    assert.match(result.environmentError ?? '', /Docker 不可用/)
    assert.equal(cluster.files.size, 0)
    assert.equal(cluster.closed, false)
  }))

test('runRemoteBackgroundWrapperExecution fails the run when the wrapper is not installed', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createRemoteBackgroundPlan(agentDir, projectDir)
    const run: WrapperRun = {
      ...runFromPlan(plan),
      wrapper: { ...plan.wrapper, canonicalId: 'phi/ngs/does-not-exist', version: '9.9.9' }
    }

    const result = await runRemoteBackgroundWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir: `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`,
      connection: FAKE_CONNECTION,
      connectImpl: async () =>
        new FakeDetachedHost(`${REMOTE_RUN_DIR_PREFIX}/${run.runId}`, {
          exitCode: 0
        })
    })

    assert.equal(result.state, 'failed')
  }))

test('runRemoteBackgroundWrapperExecution fails the run when the remote host cannot be reached', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createRemoteBackgroundPlan(agentDir, projectDir)
    const run = runFromPlan(plan)

    const result = await runRemoteBackgroundWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir: `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`,
      connection: FAKE_CONNECTION,
      connectImpl: async () => {
        throw new Error('ECONNREFUSED')
      }
    })

    assert.equal(result.state, 'failed')
  }))

test('runRemoteBackgroundWrapperExecution fails the run and records the exit code when the remote process fails', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createRemoteBackgroundPlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    const remoteRunDir = `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`

    const result = await runRemoteBackgroundWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir,
      connection: FAKE_CONNECTION,
      connectImpl: async () => new FakeDetachedHost(remoteRunDir, { exitCode: 1 }),
      pollIntervalMs: 1
    })

    assert.equal(result.state, 'failed')
    assert.equal(result.exitCode, 1)
  }))

test('runRemoteBackgroundWrapperExecution marks the run lost when the process vanishes without recording an exit code', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createRemoteBackgroundPlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    const remoteRunDir = `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`

    const result = await runRemoteBackgroundWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir,
      connection: FAKE_CONNECTION,
      connectImpl: async () => new FakeDetachedHost(remoteRunDir, 'lost'),
      pollIntervalMs: 1
    })

    assert.equal(result.state, 'lost')
  }))

test('runRemoteBackgroundWrapperExecution finalizes as cancelled, not failed, when cancelWrapperRun raced the poll loop', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const plan = await createRemoteBackgroundPlan(agentDir, projectDir)
    const run = runFromPlan(plan)
    const remoteRunDir = `${REMOTE_RUN_DIR_PREFIX}/${run.runId}`
    // A non-zero exit is what a `kill -TERM` typically produces — the point
    // here is that the orchestrator must tell that apart from an ordinary
    // failure by re-checking the run's own persisted state.
    const cluster = new FakeDetachedHost(remoteRunDir, { exitCode: 143 })
    const realExec = cluster.exec.bind(cluster)
    cluster.exec = async (command: string): Promise<RemoteExecResult> => {
      const result = await realExec(command)
      if (command.includes('setsid bash')) {
        // Simulate cancelWrapperRun landing concurrently, right after this
        // app session's own launch — before the first status() poll.
        writeWrapperRun(
          { ...run, state: 'cancelling', updatedAt: new Date().toISOString() },
          agentDir
        )
      }
      return result
    }

    const result = await runRemoteBackgroundWrapperExecution(run, plan, {
      agentDir,
      remoteRunDir,
      connection: FAKE_CONNECTION,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })

    assert.equal(result.state, 'cancelled')
  }))
