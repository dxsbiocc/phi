import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  startRemoteWrapperComposition,
  type RemoteJobSnapshot,
  type RemoteTarget
} from '../src/main/agent/wrappers/composition/remote-job'
import { readSlurmJobStatus } from '../src/main/agent/wrappers/executor-slurm'
import { isRequestedCancellationStatus } from '../src/main/agent/wrappers/remote-cancel'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import { installFakeSlurm, type FakeSlurm } from './helpers/fakeSlurm'
import { createLocalShellSession } from './helpers/localShellSession'
import { bundledEntry, waitFor, withSandbox, type Sandbox } from './helpers/wrapperSandbox'

interface RunHarness {
  output: string[]
  snapshots: RemoteJobSnapshot[]
  target: RemoteTarget
}

interface SlurmHarness extends RunHarness {
  fake: FakeSlurm
}

async function withSlurm(
  sandbox: Sandbox,
  behavior: 'cancelled' | 'failed',
  run: (harness: SlurmHarness) => Promise<void>
): Promise<void> {
  sandbox.useFake()
  const remoteRoot = join(sandbox.root, 'remote')
  mkdirSync(remoteRoot, { recursive: true })
  const fake = installFakeSlurm(join(sandbox.root, 'fake-slurm'))
  fake.setFullTermBehavior(behavior)
  const session = createLocalShellSession(remoteRoot)
  const output: string[] = []
  const snapshots: RemoteJobSnapshot[] = []
  try {
    await run({
      fake,
      output,
      snapshots,
      target: {
        connection: { host: 'fake-slurm' },
        workspaceRoot: remoteRoot,
        hpc: {
          scheduler: 'slurm',
          controller: 'sbatch',
          nextflowBin: process.env.NEXTFLOW_BIN
        },
        connectImpl: async () => session,
        pollIntervalMs: 20,
        skipPreflight: true
      }
    })
  } finally {
    fake.restore()
  }
}

function start(
  sandbox: Sandbox,
  harness: RunHarness
): ReturnType<typeof startRemoteWrapperComposition> {
  return startRemoteWrapperComposition({
    runId: 'wrun_signal_cancel',
    entry: bundledEntry(),
    params: { gff: 'tests/data/genome.gff3', outdir: 'results' },
    profile: 'docker',
    target: harness.target,
    wrappersRoot: sandbox.wrappersRoot,
    onOutput: (chunk) => harness.output.push(chunk),
    onSnapshot: (snapshot) => harness.snapshots.push(snapshot),
    killGraceMs: 500
  })
}

type TerminalOutcome = { state: 'FAILED'; exitCode: number; exitSignal: number } | 'lost'

class TerminalSlurmState {
  private tracked = true

  constructor(
    private readonly outcome: TerminalOutcome,
    private running: boolean,
    private readonly localExec: RemoteSshSession['exec']
  ) {}

  private detail(): string {
    if (this.running) return 'JobState=RUNNING ExitCode=0:0'
    if (this.outcome === 'lost') return 'JobState=FAILED ExitCode=0:0'
    return `JobState=${this.outcome.state} ExitCode=${this.outcome.exitCode}:${this.outcome.exitSignal}`
  }

  async exec(command: string): Promise<RemoteExecResult> {
    if (command.startsWith('sbatch '))
      return { stdout: 'Submitted batch job 6001\n', stderr: '', code: 0, signal: null }
    if (command === 'squeue -h -j 6001 -o %T 2>/dev/null')
      return { stdout: this.running ? 'RUNNING\n' : '', stderr: '', code: 0, signal: null }
    if (command.startsWith('scontrol show job 6001')) {
      if (!this.tracked) return { stdout: '', stderr: 'Invalid job id\n', code: 1, signal: null }
      return {
        stdout: `JobId=6001 JobName=phi-wrun_signal_cancel ${this.detail()}\n`,
        stderr: '',
        code: 0,
        signal: null
      }
    }
    if (command.startsWith('sacct ')) return { stdout: '', stderr: '', code: 0, signal: null }
    if (command === 'scancel 6001 --full --signal=TERM 2>/dev/null') {
      this.running = false
      if (this.outcome === 'lost') this.tracked = false
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    if (command === 'squeue -u "$USER" -h -o "%i|%T|%Z"')
      return { stdout: '', stderr: '', code: 0, signal: null }
    return this.localExec(command)
  }
}

function terminalControllerHarness(
  sandbox: Sandbox,
  outcome: TerminalOutcome,
  initiallyRunning: boolean
): RunHarness {
  sandbox.useFake()
  const remoteRoot = join(sandbox.root, 'terminal-remote')
  mkdirSync(remoteRoot, { recursive: true })
  const session = createLocalShellSession(remoteRoot)
  const state = new TerminalSlurmState(outcome, initiallyRunning, session.exec)
  session.exec = (command) => state.exec(command)
  return {
    output: [],
    snapshots: [],
    target: {
      connection: { host: 'fake-slurm' },
      workspaceRoot: remoteRoot,
      hpc: {
        scheduler: 'slurm',
        controller: 'sbatch',
        nextflowBin: process.env.NEXTFLOW_BIN
      },
      connectImpl: async () => session,
      pollIntervalMs: 20,
      skipPreflight: true
    }
  }
}

test('requested FAILED 0:15 controller cancellation returns a clean cancelled result', async () => {
  await withSandbox(async (sandbox) => {
    await withSlurm(sandbox, 'failed', async (harness) => {
      process.env.FAKE_NF_MODE = 'hang'
      const job = start(sandbox, harness)
      await waitFor(
        () => existsSync(sandbox.pidFile) && harness.snapshots.at(-1)?.jobId !== undefined
      )
      const nextflowPid = Number(readFileSync(sandbox.pidFile, 'utf8'))

      job.cancel()
      const result = await job.done

      assert.equal(result.success, false)
      assert.equal(result.cancelled, true)
      assert.equal(result.lost, undefined)
      assert.equal(result.exitCode, 0)
      assert.match(result.output, /已取消/)
      assert.doesNotMatch(result.output, /Slurm ended .* FAILED/)
      await waitFor(() => {
        try {
          globalThis.process.kill(nextflowPid, 0)
          return false
        } catch {
          return true
        }
      })
    })
  })
})

test('requested CANCELLED controller state still returns a clean cancelled result', async () => {
  await withSandbox(async (sandbox) => {
    await withSlurm(sandbox, 'cancelled', async (harness) => {
      process.env.FAKE_NF_MODE = 'hang'
      const job = start(sandbox, harness)
      await waitFor(
        () => existsSync(sandbox.pidFile) && harness.snapshots.at(-1)?.jobId !== undefined
      )
      job.cancel()
      const result = await job.done
      assert.equal(result.success, false)
      assert.equal(result.cancelled, true)
      assert.match(result.output, /已取消/)
      assert.doesNotMatch(result.output, /Slurm ended .* FAILED/)
    })
  })
})

test('FAILED 0:15 without a cancellation request remains failed', async () => {
  await withSandbox(async (sandbox) => {
    const harness = terminalControllerHarness(
      sandbox,
      { state: 'FAILED', exitCode: 0, exitSignal: 15 },
      false
    )
    const result = await start(sandbox, harness).done
    assert.equal(result.success, false)
    assert.equal(result.cancelled, undefined)
    assert.equal(result.lost, undefined)
    assert.equal(result.exitCode, 0)
    assert.match(result.output, /state FAILED/)
  })
})

test('requested FAILED 1:0 controller state preserves the failure reason', async () => {
  await withSandbox(async (sandbox) => {
    const harness = terminalControllerHarness(
      sandbox,
      { state: 'FAILED', exitCode: 1, exitSignal: 0 },
      true
    )
    const job = start(sandbox, harness)
    await waitFor(() => harness.snapshots.at(-1)?.jobId !== undefined)
    const runDir = harness.snapshots.at(-1)!.remoteRunDir
    writeFileSync(join(runDir, 'logs', 'stderr.log'), 'Nextflow failed before cancellation.\n')
    job.cancel()
    const result = await job.done
    assert.equal(result.success, false)
    assert.equal(result.cancelled, undefined)
    assert.equal(result.lost, undefined)
    assert.equal(result.exitCode, 1)
    assert.match(result.output, /Nextflow failed before cancellation/)
    assert.match(result.output, /state FAILED/)
  })
})

test('matching CANCELLED AT output confirms a requested cancellation without signal metadata', async () => {
  await withSandbox(async (sandbox) => {
    const harness = terminalControllerHarness(
      sandbox,
      { state: 'FAILED', exitCode: 0, exitSignal: 0 },
      true
    )
    const job = start(sandbox, harness)
    await waitFor(() => harness.snapshots.at(-1)?.jobId !== undefined)
    const runDir = harness.snapshots.at(-1)!.remoteRunDir
    writeFileSync(
      join(runDir, 'logs', 'stderr.log'),
      'slurmstepd: error: *** JOB 6001 ON node1 CANCELLED AT 2026-10-09T16:48:51 ***\n'
    )
    job.cancel()
    const result = await job.done
    assert.equal(result.success, false)
    assert.equal(result.cancelled, true)
    assert.equal(result.lost, undefined)
    assert.match(result.output, /已取消/)
    assert.doesNotMatch(result.output, /node1|Slurm ended .* FAILED/)
  })
})

test('CANCELLED AT output for another job does not hide a controller failure', async () => {
  await withSandbox(async (sandbox) => {
    const harness = terminalControllerHarness(
      sandbox,
      { state: 'FAILED', exitCode: 0, exitSignal: 0 },
      true
    )
    const job = start(sandbox, harness)
    await waitFor(() => harness.snapshots.at(-1)?.jobId !== undefined)
    const runDir = harness.snapshots.at(-1)!.remoteRunDir
    writeFileSync(
      join(runDir, 'logs', 'stderr.log'),
      'slurmstepd: error: *** JOB 6002 CANCELLED AT 2026-10-09T16:48:51 ***\n'
    )
    job.cancel()
    const result = await job.done
    assert.equal(result.cancelled, undefined)
    assert.equal(result.lost, undefined)
    assert.match(result.output, /state FAILED/)
  })
})

test('sacct signal 9 is preserved as requested-cancellation evidence', async () => {
  const session = {
    async exec(command: string) {
      if (command.startsWith('squeue ')) return { stdout: '', stderr: '', code: 0, signal: null }
      if (command.startsWith('scontrol '))
        return { stdout: '', stderr: 'unknown job', code: 1, signal: null }
      return { stdout: '6001|FAILED|0:9\n', stderr: '', code: 0, signal: null }
    }
  } as RemoteSshSession
  const status = await readSlurmJobStatus(session, '6001')
  assert.deepEqual(status, { outcome: 'failed', exitCode: 0, exitSignal: 9, detail: 'FAILED' })
  assert.equal(isRequestedCancellationStatus(status), true)
})

test('a requested cancellation whose controller disappears remains lost', async () => {
  await withSandbox(async (sandbox) => {
    const harness = terminalControllerHarness(sandbox, 'lost', true)
    const job = start(sandbox, harness)
    await waitFor(() => harness.snapshots.at(-1)?.jobId !== undefined)
    job.cancel()
    const result = await job.done
    assert.equal(result.success, false)
    assert.equal(result.cancelled, undefined)
    assert.equal(result.lost, true)
  })
})
