import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createProject,
  updateProjectRemoteConnection,
  updateProjectRemoteDefaults
} from '../src/main/agent/projects'
import { saveRemoteHostProfile } from '../src/main/agent/remote-hosts'
import { RUNTIME_AGENT_DIR_ENV } from '../src/main/agent/runtime-paths'
import { reconcileRemoteWrapperRuns } from '../src/main/agent/wrappers/executor-slurm-reconcile'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import {
  getWrapperRunsDir,
  readWrapperRunEvents,
  readWrapperRun,
  writeWrapperRun
} from '../src/main/agent/wrappers/store'
import type { WrapperRun } from '../src/main/agent/wrappers/types'
import { installLegacyFastqQcWrapper } from './helpers/wrapperFixtures'

/**
 * In-memory fake covering exactly the commands `SbatchRunner.status()`/
 * `.cancel()` issue during reconciliation (no `submit()` here — every run
 * in these tests already has a `remote.snapshot.json`, i.e. was already
 * submitted in a prior, now-dead app session).
 */
class FakeSlurmHost implements RemoteSshSession {
  files = new Map<string, string>()
  execLog: string[] = []
  alivePolls = 0
  exitOnLastAlive?: string
  activeSlurmJob = false

  constructor(private readonly outcome: { state: string; exitCode: number } | 'untracked') {}

  async exec(command: string): Promise<RemoteExecResult> {
    this.execLog.push(command)
    if (command.startsWith('kill -0 ')) {
      const alive = this.alivePolls > 0
      this.alivePolls = Math.max(0, this.alivePolls - 1)
      if (alive && this.alivePolls === 0 && this.exitOnLastAlive) {
        this.files.set(this.exitOnLastAlive, '0\n')
      }
      return { stdout: alive ? 'alive\n' : 'dead\n', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('kill -TERM -') || command.startsWith('kill -KILL -')) {
      this.alivePolls = 0
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('ps -ww -o args= -p ')) {
      const runIdFile = [...this.files.keys()].find((path) =>
        path.endsWith('/.phi-launch-claim/run-id')
      )
      const remoteRunDir = runIdFile?.slice(0, -'/.phi-launch-claim/run-id'.length)
      return {
        stdout: remoteRunDir ? `bash ${remoteRunDir}/launch.sh\n` : '',
        stderr: '',
        code: remoteRunDir ? 0 : 1,
        signal: null
      }
    }
    if (command.startsWith('squeue ')) {
      return { stdout: this.activeSlurmJob ? 'RUNNING\n' : '', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('scontrol show job ')) {
      if (this.outcome === 'untracked') {
        return {
          stdout: '',
          stderr: 'scontrol: error: Invalid job id specified\n',
          code: 1,
          signal: null
        }
      }
      return {
        stdout: `JobId=1 JobName=phi-${[...this.files.entries()].find(([path]) => path.endsWith('/.phi-launch-claim/run-id'))?.[1].trim() ?? 'test'}\n   JobState=${this.outcome.state} Reason=None\n   ExitCode=${this.outcome.exitCode}:0\n`,
        stderr: '',
        code: 0,
        signal: null
      }
    }
    if (command.startsWith('sacct ')) {
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('scancel ')) {
      this.activeSlurmJob = false
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
    // Nothing to release — no real connection was ever opened.
  }
}

async function withProjectHarness<T>(
  callback: (harness: { agentDir: string; projectDir: string }) => Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-slurm-reconcile-'))
  const agentDir = join(root, '.phi-home')
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  const previous = process.env[RUNTIME_AGENT_DIR_ENV]
  process.env[RUNTIME_AGENT_DIR_ENV] = agentDir
  try {
    return await callback({ agentDir, projectDir })
  } finally {
    if (previous === undefined) delete process.env[RUNTIME_AGENT_DIR_ENV]
    else process.env[RUNTIME_AGENT_DIR_ENV] = previous
    rmSync(root, { recursive: true, force: true })
  }
}

function configureProjectRemote(agentDir: string, projectDir: string): void {
  const project = createProject({
    name: 'Demo',
    workingDirectory: projectDir,
    permissionMode: 'ask'
  })
  const host = saveRemoteHostProfile(
    { label: 'Lab HPC', hostAlias: 'lab-hpc.example.edu' },
    agentDir
  )
  updateProjectRemoteConnection(project.id, 'conn1', {
    id: 'conn1',
    label: 'Lab HPC',
    hostProfileId: host.id
  })
  updateProjectRemoteDefaults(project.id, {
    defaultRemoteConnectionId: 'conn1',
    remoteWorkspaceRoot: '/cluster/facility/lab/WorkSpace'
  })
}

function writeSlurmControllerRun(
  agentDir: string,
  projectDir: string,
  overrides: Partial<WrapperRun> = {}
): WrapperRun {
  const entry = installLegacyFastqQcWrapper(agentDir, projectDir)
  const now = new Date().toISOString()
  const run: WrapperRun = {
    runId: `wrun_${randomUUID()}`,
    planId: `wplan_${randomUUID()}`,
    revision: 1,
    state: 'running',
    actor: 'agent',
    wrapper: {
      canonicalId: entry.manifest.id,
      namespace: entry.manifest.id.split('/').slice(0, -1).join('/'),
      shortId: entry.manifest.shortId,
      version: entry.manifest.version
    },
    trustTier: entry.trustTier,
    executor: 'slurm-controller',
    profile: 'slurm-controller',
    cwd: projectDir,
    outDir: 'results/phi-wrapper/fastq-qc',
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
  writeWrapperRun(run, agentDir)
  return run
}

function writeRemoteSnapshot(
  agentDir: string,
  runId: string,
  remoteRunDir: string,
  jobId?: string,
  launchUnknown?: true
): void {
  const runDir = join(getWrapperRunsDir(agentDir), runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'remote.snapshot.json'),
    `${JSON.stringify({ remoteRunDir, ...(jobId ? { jobId } : {}), ...(launchUnknown ? { launchUnknown } : {}) })}\n`,
    'utf-8'
  )
}

test('reconcileRemoteWrapperRuns finalizes a running run whose remote job already completed', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir)
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    writeRemoteSnapshot(agentDir, run.runId, remoteRunDir, '999')
    const cluster = new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 })
    cluster.files.set(`${remoteRunDir}/output/results/multiqc_report.html`, '<html></html>')

    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })

    const finalRun = readWrapperRun(run.runId, agentDir)
    assert.equal(finalRun?.state, 'completed')
    assert.equal(finalRun?.exitCode, 0)
    const report = finalRun?.outputs?.find((output) => output.id === 'report')
    assert.equal(report?.exists, true)
    assert.equal(report?.location, 'remote')
  }))

test('restart collects Slurm reports from the run snapshot external output root', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir)
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    const outputRoot = '/scratch/phi-restarted-reports'
    writeWrapperRun(
      {
        ...run,
        outDir: outputRoot,
        remote: {
          host: 'lab-hpc.example.edu',
          runDir: remoteRunDir,
          outputRoot,
          workspaceRoot: '/cluster/facility/lab/WorkSpace',
          externalOutputAuthorized: true
        }
      },
      agentDir
    )
    writeRemoteSnapshot(agentDir, run.runId, remoteRunDir, '999')
    const host = new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 })
    host.files.set(`${outputRoot}/results/multiqc_report.html`, '<html></html>')

    await reconcileRemoteWrapperRuns({ agentDir, connectImpl: async () => host, pollIntervalMs: 1 })

    const report = readWrapperRun(run.runId, agentDir)?.outputs?.find(
      (output) => output.id === 'report'
    )
    assert.equal(report?.path, `${outputRoot}/results/multiqc_report.html`)
    assert.equal(report?.exists, true)
  }))

test('a lost Slurm run without a local job ID recovers the remote receipt', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir, {
      state: 'lost',
      launchUnknown: true
    })
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    writeRemoteSnapshot(agentDir, run.runId, remoteRunDir, undefined, true)
    const cluster = new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 })
    cluster.files.set(`${remoteRunDir}/job_id`, '999\n')
    cluster.files.set(`${remoteRunDir}/output/results/multiqc_report.html`, '<html></html>')
    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })
    assert.equal(readWrapperRun(run.runId, agentDir)?.state, 'completed')
    assert.equal(
      cluster.execLog.some((command) => command.startsWith('sbatch ')),
      false
    )
  }))

test('a bound run ID can recover a remote receipt even when the local snapshot is missing', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir)
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    writeWrapperRun(
      {
        ...run,
        remote: { host: 'lab-hpc.example.edu', runDir: remoteRunDir }
      },
      agentDir
    )
    const cluster = new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 })
    cluster.files.set(`${remoteRunDir}/job_id`, '999\n')
    cluster.files.set(`${remoteRunDir}/output/results/multiqc_report.html`, '<html></html>')
    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })
    assert.equal(readWrapperRun(run.runId, agentDir)?.state, 'completed')
  }))

test('a detached run resumes from its PID and exit code after restart', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir, {
      executor: 'remote-background',
      profile: 'remote-background',
      state: 'lost',
      launchUnknown: true
    })
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    writeRemoteSnapshot(agentDir, run.runId, remoteRunDir, undefined, true)
    const cluster = new FakeSlurmHost('untracked')
    cluster.files.set(`${remoteRunDir}/pid`, '1234\n')
    cluster.files.set(`${remoteRunDir}/output/results/multiqc_report.html`, '<html></html>')
    cluster.alivePolls = 1
    cluster.exitOnLastAlive = `${remoteRunDir}/exit_code`
    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })
    const finished = readWrapperRun(run.runId, agentDir)
    assert.equal(finished?.state, 'completed')
    assert.equal(finished?.launchUnknown, undefined)
    assert.ok(
      readWrapperRunEvents(run.runId, agentDir).some(
        (event) => event.type === 'run_state_changed' && event.state === 'running'
      )
    )
    assert.equal(
      cluster.execLog.some((command) => /sbatch |setsid bash/.test(command)),
      false
    )
  }))

test('an unreachable host leaves a lost snapshot available for later reconciliation', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir, {
      state: 'lost',
      launchUnknown: true
    })
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    writeRemoteSnapshot(agentDir, run.runId, remoteRunDir, '999', true)
    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => {
        throw new Error('network unavailable')
      }
    })
    assert.equal(readWrapperRun(run.runId, agentDir)?.state, 'lost')
    const cluster = new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 })
    cluster.files.set(`${remoteRunDir}/output/results/multiqc_report.html`, '<html></html>')
    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })
    assert.equal(readWrapperRun(run.runId, agentDir)?.state, 'completed')
  }))

test('an unconfirmed remote launch stays lost and never becomes a definite failure', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir, {
      state: 'lost',
      launchUnknown: true
    })
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    writeRemoteSnapshot(agentDir, run.runId, remoteRunDir, undefined, true)
    const cluster = new FakeSlurmHost('untracked')
    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })
    const saved = readWrapperRun(run.runId, agentDir)
    assert.equal(saved?.state, 'lost')
    assert.equal(saved?.launchUnknown, true)
    assert.match(saved?.launchDiagnostic ?? '', /没有 PID|无法确认/)
    assert.equal(
      cluster.execLog.some((command) => /sbatch |setsid bash/.test(command)),
      false
    )
  }))

test('reconcileRemoteWrapperRuns marks a run lost when there is no remote snapshot to reconnect from', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir)
    // No remote.snapshot.json written — the run never got far enough to submit.

    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => {
        throw new Error('should not attempt to connect without a snapshot')
      }
    })

    assert.equal(readWrapperRun(run.runId, agentDir)?.state, 'lost')
  }))

test('reconcileRemoteWrapperRuns marks a run lost when the project remote config is missing', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    // configureProjectRemote intentionally not called.
    const run = writeSlurmControllerRun(agentDir, projectDir)
    writeRemoteSnapshot(agentDir, run.runId, '/some/remote/dir', '999')

    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => {
        throw new Error('should not attempt to connect without a resolvable remote config')
      }
    })

    assert.equal(readWrapperRun(run.runId, agentDir)?.state, 'lost')
  }))

test('reconcileRemoteWrapperRuns accepts a cancelled scheduler result without reissuing scancel', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir, { state: 'cancelling' })
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    writeRemoteSnapshot(agentDir, run.runId, remoteRunDir, '999')
    const cluster = new FakeSlurmHost({ state: 'CANCELLED', exitCode: 0 })
    cluster.files.set(`${remoteRunDir}/.phi-launch-claim/run-id`, `${run.runId}\n`)
    cluster.files.set(`${remoteRunDir}/job_id`, '999\n')

    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })

    const finalRun = readWrapperRun(run.runId, agentDir)
    assert.equal(finalRun?.state, 'cancelled')
    assert.ok(
      !cluster.execLog.some((command) => command.startsWith('scancel 999')),
      'an already cancelled job does not need another signal'
    )
  }))

test('restart reissues cancellation only for the bound running Slurm job', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir, { state: 'cancelling' })
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    writeRemoteSnapshot(agentDir, run.runId, remoteRunDir, '999')
    const host = new FakeSlurmHost({ state: 'CANCELLED', exitCode: 1 })
    host.activeSlurmJob = true
    host.files.set(`${remoteRunDir}/.phi-launch-claim/run-id`, `${run.runId}\n`)
    host.files.set(`${remoteRunDir}/job_id`, '999\n')

    await reconcileRemoteWrapperRuns({ agentDir, connectImpl: async () => host, pollIntervalMs: 1 })

    assert.equal(readWrapperRun(run.runId, agentDir)?.state, 'cancelled')
    assert.equal(host.execLog.filter((command) => command.startsWith('scancel 999')).length, 1)
  }))

test('restart confirms a detached process group stopped after a bound cancel signal', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir, {
      state: 'cancelling',
      executor: 'remote-background'
    })
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    const runDir = join(getWrapperRunsDir(agentDir), run.runId)
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'remote.snapshot.json'), JSON.stringify({ remoteRunDir, pid: 4242 }))
    const host = new FakeSlurmHost('untracked')
    host.alivePolls = 4
    host.files.set(`${remoteRunDir}/.phi-launch-claim/run-id`, `${run.runId}\n`)
    host.files.set(`${remoteRunDir}/pid`, '4242\n')

    await reconcileRemoteWrapperRuns({ agentDir, connectImpl: async () => host, pollIntervalMs: 1 })

    assert.equal(readWrapperRun(run.runId, agentDir)?.state, 'cancelled')
    assert.equal(host.execLog.filter((command) => command.startsWith('kill -TERM -4242')).length, 1)
  }))

test('reconcileRemoteWrapperRuns leaves already-terminal and non-slurm-controller runs untouched', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const completedRun = writeSlurmControllerRun(agentDir, projectDir, {
      state: 'completed',
      completedAt: new Date().toISOString()
    })
    const localRun = writeSlurmControllerRun(agentDir, projectDir, {
      executor: 'local',
      profile: 'local',
      state: 'running'
    })
    const compositionRun = writeSlurmControllerRun(agentDir, projectDir, {
      origin: 'composition',
      state: 'running'
    })

    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => {
        throw new Error('should not attempt to connect for skipped runs')
      }
    })

    assert.equal(readWrapperRun(completedRun.runId, agentDir)?.state, 'completed')
    assert.equal(readWrapperRun(localRun.runId, agentDir)?.state, 'running')
    assert.equal(readWrapperRun(compositionRun.runId, agentDir)?.state, 'running')
  }))
