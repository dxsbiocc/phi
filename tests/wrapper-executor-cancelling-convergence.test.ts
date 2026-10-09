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
import { cancelWrapperRun } from '../src/main/agent/wrappers/runs'
import {
  getWrapperRunsDir,
  readWrapperRun,
  readWrapperRunEvents,
  writeWrapperRun
} from '../src/main/agent/wrappers/store'
import type { WrapperRun, WrapperRunState } from '../src/main/agent/wrappers/types'

const WORKSPACE_ROOT = '/cluster/facility/lab/WorkSpace'
const CONNECTION = { host: 'lab-hpc.example.edu' }

type SchedulerResult = { state: string; exitCode: number; exitSignal?: number } | 'untracked'

class ConvergenceSlurmHost implements RemoteSshSession {
  files = new Map<string, string>()
  commands: string[] = []
  running: boolean
  residualJobId?: string

  constructor(
    private readonly runId: string,
    private readonly remoteRunDir: string,
    private readonly result: SchedulerResult,
    running = false
  ) {
    this.running = running
    this.files.set(`${remoteRunDir}/.phi-launch-claim/run-id`, `${runId}\n`)
    this.files.set(`${remoteRunDir}/job_id`, '999\n')
  }

  async exec(command: string): Promise<RemoteExecResult> {
    this.commands.push(command)
    if (command.startsWith('squeue -h -j ')) {
      return { stdout: this.running ? 'RUNNING\n' : '', stderr: '', code: 0, signal: null }
    }
    if (command === 'squeue -u "$USER" -h -o "%i|%T|%Z"') {
      return {
        stdout: this.residualJobId
          ? `${this.residualJobId}|RUNNING|${this.remoteRunDir}/work/stubborn\n`
          : '',
        stderr: '',
        code: 0,
        signal: null
      }
    }
    if (command.startsWith('scontrol show job 999')) {
      if (this.result === 'untracked') {
        return { stdout: '', stderr: 'Invalid job id specified', code: 1, signal: null }
      }
      const state = this.running ? 'RUNNING' : this.result.state
      const exitCode = this.running ? 0 : this.result.exitCode
      const exitSignal = this.running ? 0 : (this.result.exitSignal ?? 0)
      return {
        stdout: `JobId=999 JobName=phi-${this.runId} JobState=${state} Reason=None ExitCode=${exitCode}:${exitSignal}\n`,
        stderr: '',
        code: 0,
        signal: null
      }
    }
    if (command.startsWith('sacct ')) {
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    if (command === 'scancel 999 --full --signal=TERM 2>/dev/null') {
      this.running = false
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('scancel ')) {
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    throw new Error(`ConvergenceSlurmHost: unhandled command: ${command}`)
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
    // The fake filesystem is a flat map.
  }

  async uploadFile(): Promise<void> {
    // Cancellation and reconciliation never upload files.
  }

  async exists(remotePath: string): Promise<boolean> {
    return this.files.has(remotePath)
  }

  async close(): Promise<void> {
    // No transport to close in the fake.
  }
}

async function withHarness<T>(
  callback: (harness: { agentDir: string; projectDir: string }) => Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-cancel-convergence-'))
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

function configureProjectRemote(projectDir: string): void {
  const project = createProject({
    name: 'Demo',
    workingDirectory: projectDir,
    permissionMode: 'ask'
  })
  const host = saveRemoteHostProfile({ label: 'Lab HPC', hostAlias: CONNECTION.host })
  updateProjectRemoteConnection(project.id, 'conn1', {
    id: 'conn1',
    label: 'Lab HPC',
    hostProfileId: host.id
  })
  updateProjectRemoteDefaults(project.id, {
    defaultRemoteConnectionId: 'conn1',
    remoteWorkspaceRoot: WORKSPACE_ROOT
  })
}

function writeCancellingRun(
  agentDir: string,
  projectDir: string,
  state: WrapperRunState = 'cancelling'
): { run: WrapperRun; remoteRunDir: string } {
  const now = new Date().toISOString()
  const run: WrapperRun = {
    runId: `wrun_${randomUUID()}`,
    planId: `wplan_${randomUUID()}`,
    revision: 1,
    state,
    actor: 'agent',
    wrapper: {
      canonicalId: 'phi/ngs/fastq-qc',
      namespace: 'phi/ngs',
      shortId: 'fastq-qc',
      version: '1.0.0'
    },
    trustTier: 'bundled',
    executor: 'slurm-controller',
    profile: 'slurm-controller',
    cwd: projectDir,
    outDir: 'results/phi-wrapper/fastq-qc',
    createdAt: now,
    updatedAt: now
  }
  writeWrapperRun(run, agentDir)
  const remoteRunDir = `${WORKSPACE_ROOT}/wrappers/runs/${run.runId}`
  const runDir = join(getWrapperRunsDir(agentDir), run.runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'remote.snapshot.json'),
    `${JSON.stringify({ remoteRunDir, jobId: '999' })}\n`
  )
  return { run, remoteRunDir }
}

async function waitForSettled(runId: string, agentDir: string): Promise<WrapperRun> {
  const deadline = Date.now() + 4_000
  for (;;) {
    const run = readWrapperRun(runId, agentDir)
    if (run && run.state !== 'cancelling') return run
    if (Date.now() >= deadline) throw new Error('Timed out waiting for cancellation to settle')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('successful cancellation cleanup persists cancelled instead of leaving cancelling', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const { run, remoteRunDir } = writeCancellingRun(agentDir, projectDir, 'running')
    const host = new ConvergenceSlurmHost(
      run.runId,
      remoteRunDir,
      { state: 'CANCELLED', exitCode: 0 },
      true
    )

    assert.equal(
      cancelWrapperRun(run.runId, agentDir, {
        connection: CONNECTION,
        remoteWorkspaceRoot: WORKSPACE_ROOT,
        connectImpl: async () => host
      }).state,
      'cancelling'
    )

    const saved = await waitForSettled(run.runId, agentDir)
    assert.equal(saved.state, 'cancelled')
    assert.ok(saved.cancelConfirmedAt)
    assert.ok(
      readWrapperRunEvents(run.runId, agentDir).some(
        (event) => event.type === 'run_state_changed' && event.state === 'cancelled'
      )
    )
  }))

test('residual Slurm jobs persist lost with their IDs instead of leaving cancelling', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const { run, remoteRunDir } = writeCancellingRun(agentDir, projectDir, 'running')
    const host = new ConvergenceSlurmHost(
      run.runId,
      remoteRunDir,
      { state: 'CANCELLED', exitCode: 0 },
      true
    )
    host.residualJobId = '4243'

    cancelWrapperRun(run.runId, agentDir, {
      connection: CONNECTION,
      remoteWorkspaceRoot: WORKSPACE_ROOT,
      connectImpl: async () => host
    })

    const saved = await waitForSettled(run.runId, agentDir)
    assert.equal(saved.state, 'lost')
    assert.match(saved.launchDiagnostic ?? '', /4243/)
    assert.ok(
      readWrapperRunEvents(run.runId, agentDir).some(
        (event) => event.type === 'run_state_changed' && event.state === 'lost'
      )
    )
  }))

test('a cancellation connection failure persists lost instead of leaving cancelling', () =>
  withHarness(async ({ agentDir, projectDir }) => {
    const { run } = writeCancellingRun(agentDir, projectDir, 'running')
    cancelWrapperRun(run.runId, agentDir, {
      connection: CONNECTION,
      remoteWorkspaceRoot: WORKSPACE_ROOT,
      connectImpl: async () => {
        throw new Error('connection dropped during cancellation')
      }
    })

    const saved = await waitForSettled(run.runId, agentDir)
    assert.equal(saved.state, 'lost')
    assert.match(saved.launchDiagnostic ?? '', /connection dropped during cancellation/)
  }))

for (const scenario of [
  {
    title: 'restart reconciles persisted cancelling plus CANCELLED to cancelled without scancel',
    result: { state: 'CANCELLED', exitCode: 0 } as SchedulerResult,
    expected: 'cancelled' as const
  },
  {
    title: 'restart reconciles persisted cancelling plus FAILED 0:15 to cancelled',
    result: { state: 'FAILED', exitCode: 0, exitSignal: 15 } as SchedulerResult,
    expected: 'cancelled' as const
  },
  {
    title: 'restart reconciles persisted cancelling plus FAILED 1:0 to failed',
    result: { state: 'FAILED', exitCode: 1 } as SchedulerResult,
    expected: 'failed' as const
  },
  {
    title: 'restart reconciles a vanished persisted cancelling run to lost',
    result: 'untracked' as SchedulerResult,
    expected: 'lost' as const
  }
]) {
  test(scenario.title, () =>
    withHarness(async ({ agentDir, projectDir }) => {
      configureProjectRemote(projectDir)
      const { run, remoteRunDir } = writeCancellingRun(agentDir, projectDir)
      const host = new ConvergenceSlurmHost(run.runId, remoteRunDir, scenario.result)

      await reconcileRemoteWrapperRuns({
        agentDir,
        connectImpl: async () => host,
        pollIntervalMs: 1
      })

      assert.equal(readWrapperRun(run.runId, agentDir)?.state, scenario.expected)
      if (scenario.result !== 'untracked' && scenario.result.state === 'CANCELLED') {
        assert.equal(
          host.commands.some((command) => command.startsWith('scancel 999')),
          false
        )
      }
    })
  )
}
