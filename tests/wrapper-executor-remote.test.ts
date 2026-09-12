import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SshExecRunner,
  buildDetachedLaunchCommand,
  wrapWithExitCodeTrap,
  type RemoteLaunchSpec
} from '../src/main/agent/wrappers/executor-remote'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import type { WrapperRun, WrapperRunPlan } from '../src/main/agent/wrappers/types'

const RUN_DIR = '/home/lab/.phi/wrappers/runs/wrun_test'

const FIXTURE_RUN: WrapperRun = {
  runId: 'wrun_test',
  planId: 'wplan_test',
  revision: 1,
  state: 'created',
  actor: 'agent',
  wrapper: {
    canonicalId: 'phi/ngs/fastq-qc',
    namespace: 'phi/ngs',
    shortId: 'fastq-qc',
    version: '1.0.0'
  },
  trustTier: 'bundled',
  executor: 'remote-background',
  profile: 'default',
  cwd: '/home/lab/project',
  outDir: 'results/fastq-qc',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z'
}

const FIXTURE_LAUNCH: RemoteLaunchSpec = {
  remoteRunDir: RUN_DIR,
  launchScript: wrapWithExitCodeTrap('nextflow run wrapper/main.nf -params-file params.json'),
  paramsJson: '{"outdir":"results"}'
}

/**
 * In-memory fake of `RemoteSshSession` — a tiny fake filesystem plus a
 * fake process table, driven entirely by the shell commands
 * `SshExecRunner` actually sends. No real network/SSH involved, matching
 * `executor-local.ts`'s test harness pattern of faking `spawn` rather than
 * mocking at the class boundary.
 */
class FakeRemoteHost implements RemoteSshSession {
  files = new Map<string, string>()
  /** pid -> alive */
  processes = new Map<number, boolean>()
  closed = false
  private nextPid = 1000

  async exec(command: string): Promise<RemoteExecResult> {
    // Checked first: the multi-command launch line (built by
    // buildDetachedLaunchCommand) also *starts with* `mkdir -p`, so a
    // plain startsWith check below would shadow it.
    if (command.includes('setsid bash')) {
      const pid = this.nextPid++
      this.processes.set(pid, true)
      this.files.set(`${RUN_DIR}/${PID_RELATIVE}`, `${pid}`)
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
    throw new Error(`FakeRemoteHost: unhandled command: ${command}`)
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

  /** Test helper: simulate the remote process finishing on its own. */
  finish(pid: number, exitCode: number): void {
    this.processes.set(pid, false)
    this.files.set(`${RUN_DIR}/exit_code`, `${exitCode}`)
  }
}

const PID_RELATIVE = 'pid'

function makeRunner(): { runner: SshExecRunner; host: FakeRemoteHost } {
  const host = new FakeRemoteHost()
  const runner = new SshExecRunner({
    connection: { host: 'lab-hpc.example.edu', username: 'agent', privateKey: 'fake' },
    connectImpl: async () => host
  })
  return { runner, host }
}

test('buildDetachedLaunchCommand launches under setsid and captures the pid', () => {
  const command = buildDetachedLaunchCommand(RUN_DIR)
  assert.match(
    command,
    /setsid bash '.*launch\.sh' > '.*logs\/stdout\.log' 2> '.*logs\/stderr\.log' < \/dev\/null &/
  )
  assert.match(command, /echo \$! > '.*pid'/)
  assert.match(command, /cat '.*pid'$/)
})

test('wrapWithExitCodeTrap appends an exit-code capture line', () => {
  const wrapped = wrapWithExitCodeTrap('some-command')
  assert.match(wrapped, /^some-command\necho \$\? > 'exit_code'\n$/)
})

test('SshExecRunner.submit uploads the launch bundle and returns a pid handle', async () => {
  const { runner, host } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, {} as WrapperRunPlan, FIXTURE_LAUNCH)

  assert.equal(handle.runId, FIXTURE_RUN.runId)
  assert.equal(handle.remoteRunDir, RUN_DIR)
  assert.equal(typeof handle.pid, 'number')
  assert.equal(host.files.get(`${RUN_DIR}/launch.sh`), FIXTURE_LAUNCH.launchScript)
  assert.equal(host.files.get(`${RUN_DIR}/params.json`), FIXTURE_LAUNCH.paramsJson)
})

test('SshExecRunner.status reports running while the process is alive', async () => {
  const { runner } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, {} as WrapperRunPlan, FIXTURE_LAUNCH)

  const status = await runner.status(handle)
  assert.deepEqual(status, { outcome: 'running' })
})

test('SshExecRunner.status reports completed/failed from the recorded exit code', async () => {
  const { runner, host } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, {} as WrapperRunPlan, FIXTURE_LAUNCH)

  host.finish(handle.pid!, 0)
  assert.deepEqual(await runner.status(handle), { outcome: 'completed', exitCode: 0 })

  host.finish(handle.pid!, 1)
  assert.deepEqual(await runner.status(handle), { outcome: 'failed', exitCode: 1 })
})

test('SshExecRunner.status reports lost when the process is gone without an exit code', async () => {
  const { runner, host } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, {} as WrapperRunPlan, FIXTURE_LAUNCH)

  host.processes.set(handle.pid!, false)
  assert.deepEqual(await runner.status(handle), { outcome: 'lost' })
})

test('SshExecRunner.cancel kills the process group and is a no-op without a pid', async () => {
  const { runner, host } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, {} as WrapperRunPlan, FIXTURE_LAUNCH)

  await runner.cancel(handle)
  assert.equal(host.processes.get(handle.pid!), false)

  await runner.cancel({ ...handle, pid: undefined })
})

test('SshExecRunner.tailLog returns empty string until the log file exists', async () => {
  const { runner, host } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, {} as WrapperRunPlan, FIXTURE_LAUNCH)

  assert.equal(await runner.tailLog(handle), '')

  host.files.set(`${RUN_DIR}/logs/stdout.log`, 'hello from nextflow\n')
  assert.equal(await runner.tailLog(handle), 'hello from nextflow\n')
})

test('SshExecRunner.close is a no-op when nothing ever connected', async () => {
  const runner = new SshExecRunner({
    connection: { host: 'unused', username: 'agent', privateKey: 'fake' },
    connectImpl: async () => {
      throw new Error('should never connect')
    }
  })
  await runner.close()
})

// --- real-bash execution of buildDetachedLaunchCommand -------------------
//
// Everything above drives SshExecRunner through FakeRemoteHost, an
// in-memory string matcher that never executes anything. That's exactly
// how this project shipped buildDetachedLaunchCommand with a fatal `cmd &
// && next` bash syntax error for a while: `&` already terminates a
// command the way `;`/`&&` do, so chaining `&&` right after it is invalid
// — no fake ever caught it because no fake ever ran the string through a
// real shell. These tests do, against a real local `bash` (no SSH, no
// network) — with a `setsid` shim on PATH since macOS doesn't ship one but
// every real deployment target (Linux) does; the shim only proves the
// command's syntax/redirection/pid-capture, not setsid's actual session
// detachment (that needs a genuine Linux host to verify).

async function withDetachedCommandHarness<T>(
  callback: (h: { runDir: string; run: (command: string) => string }) => Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-detached-cmd-realbash-'))
  const runDir = join(root, 'run')
  const binDir = join(root, 'bin')
  try {
    // A `setsid` shim: real `setsid` also execs its arguments, it just
    // additionally detaches from the controlling session first — which
    // this test can't observe locally anyway (see comment above).
    mkdirSync(binDir, { recursive: true })
    mkdirSync(runDir, { recursive: true })
    const setsidShim = join(binDir, 'setsid')
    writeFileSync(setsidShim, '#!/bin/sh\nexec "$@"\n')
    chmodSync(setsidShim, 0o755)

    function run(command: string): string {
      return execSync(command, {
        shell: '/bin/bash',
        encoding: 'utf-8',
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
      }).trim()
    }

    return await callback({ runDir, run })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Polls (via real timers, not repeated `execSync` subprocess spawns — those
 * have enough overhead of their own to skew short timing windows) until
 * `check()` returns true or `timeoutMs` elapses.
 */
async function waitUntil(check: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await sleep(intervalMs)
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('buildDetachedLaunchCommand is valid bash and actually launches a detached, pid-tracked process', async () => {
  await withDetachedCommandHarness(async ({ runDir, run }) => {
    writeFileSync(
      join(runDir, 'launch.sh'),
      wrapWithExitCodeTrap('echo hello-from-real-launch; sleep 1')
    )

    // bash -n first: pure syntax check, would have caught the `& &&` bug
    // on its own without needing to actually run anything.
    const command = buildDetachedLaunchCommand(runDir)
    execSync(`bash -n -c ${JSON.stringify(command)}`)

    const pid = Number(run(command))
    assert.ok(Number.isInteger(pid) && pid > 0, `expected a numeric pid, got: ${pid}`)

    // Still running: the launch script sleeps for 1s, and submit() must
    // return before the backgrounded script finishes — that's the entire
    // point of "detached".
    assert.equal(isAlive(pid), true)
    assert.equal(readFileSync(join(runDir, 'logs', 'stdout.log'), 'utf-8'), '')

    await waitUntil(() => !isAlive(pid))
    assert.equal(
      readFileSync(join(runDir, 'logs', 'stdout.log'), 'utf-8'),
      'hello-from-real-launch\n'
    )
    assert.equal(readFileSync(join(runDir, 'exit_code'), 'utf-8').trim(), '0')
  })
})

test('buildDetachedLaunchCommand still records a non-zero exit code for a failing launch script', async () => {
  await withDetachedCommandHarness(async ({ runDir, run }) => {
    // `sh -c 'exit 7'`, not a bare `exit 7` — the latter is a shell
    // builtin that would terminate launch.sh itself immediately, before
    // wrapWithExitCodeTrap's appended `echo $? > exit_code` line ever ran.
    writeFileSync(join(runDir, 'launch.sh'), wrapWithExitCodeTrap("sh -c 'exit 7'"))

    const pid = Number(run(buildDetachedLaunchCommand(runDir)))
    await waitUntil(() => !isAlive(pid))

    assert.equal(readFileSync(join(runDir, 'exit_code'), 'utf-8').trim(), '7')
  })
})
