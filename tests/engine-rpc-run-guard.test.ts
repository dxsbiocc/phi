import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  RUN_NONCE_ENV,
  RUN_STOPPED_NOTICE,
  buildRunGuardWrapper
} from '../src/main/agent/engine/rpc/run-guard'
import { runRpcStartupTransaction } from '../src/main/agent/engine/rpc/startup-transaction'
import { describeRemoteRecoveryFailure } from '../src/main/agent/engine/rpc/session-recovery'
import { shellQuote as q } from '../src/main/agent/wrappers/remote-ssh-session'
import { installFlockShim } from './helpers/flockShim'
import { createLocalShellSession } from './helpers/localShellSession'

interface Fixture {
  root: string
  directory: string
  lockPath: string
  runLock: string
  runRecord: string
  fakeOmp: string
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-run-guard-')))
  await chmod(root, 0o700)
  const directory = join(root, 'omp-sessions', 'key')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(join(root, 'omp-sessions'), 0o700)
  await chmod(directory, 0o700)
  const fakeOmp = join(root, 'fake-omp')
  // A symlink keeps argv0 equal to this path while avoiding re-signing a platform binary.
  await symlink(process.platform === 'darwin' ? '/bin/sleep' : '/usr/bin/sleep', fakeOmp)
  const runLock = join(directory, 'run.lock')
  await writeFile(runLock, '', { mode: 0o600 })
  return {
    root,
    directory,
    lockPath: join(directory, 'lease.lock'),
    runLock,
    runRecord: join(directory, 'run.record'),
    fakeOmp
  }
}

/** Starts a "previous run" exactly the way the factory's launch command does. */
async function startOldRun(f: Fixture, nonce: string): Promise<number> {
  const command = `umask 077 && cd -- ${q(f.root)} && ${buildRunGuardWrapper({
    runLock: f.runLock,
    runRecord: f.runRecord,
    nonce
  })}env -i PATH=${q(process.env.PATH ?? '/usr/bin:/bin')} ${RUN_NONCE_ENV}=${nonce} ${q(f.fakeOmp)} 300`
  const child = spawn('bash', ['-c', command], { detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 100 && !existsSync(f.runRecord); i++) await delay(50)
  await delay(150)
  return child.pid!
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function startup(
  f: Fixture,
  runExecutable = f.fakeOmp
): Promise<{
  session: ReturnType<typeof createLocalShellSession>
  execution: Awaited<ReturnType<typeof runRpcStartupTransaction>>
}> {
  const session = createLocalShellSession(f.root)
  const execution = await runRpcStartupTransaction(session, {
    runtimeRoot: f.root,
    projectRoot: f.root,
    lock: { path: f.lockPath, runExecutable },
    markers: [],
    directories: [],
    files: []
  })
  return { session, execution }
}

const restoreFlock = installFlockShim(join(tmpdir(), 'phi-run-guard-flock-shim'))
test.after(restoreFlock)

test('launch guard takes the run lock, records pid/pgid/nonce at mode 0600 and the lock follows the process', async (t) => {
  const f = await fixture()
  const nonce = 'a'.repeat(32)
  const pid = await startOldRun(f, nonce)
  t.after(async () => {
    killGroup(pid)
    await rm(f.root, { recursive: true, force: true })
  })
  const record = (await readFile(f.runRecord, 'utf8')).trimEnd().split('\t')
  assert.equal(record[0], 'PHI_RUN_V1')
  assert.equal(Number(record[1]), pid)
  assert.equal(Number(record[2]), pid)
  assert.equal(record[3], nonce)
  assert.ok(Number(record[4]) > 1_000_000_000)
  assert.equal((await stat(f.runRecord)).mode & 0o777, 0o600)
  // The lock is held by the exec'd process, not by the (gone) launch shell.
  const probe = spawn('bash', ['-c', `exec 8<>${q(f.runLock)}; flock -x -n 8`])
  assert.equal(await new Promise((r) => probe.once('close', r)), 1)
})

test('free run lock: startup proceeds without takeover in one remote command', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const { session, execution } = await startup(f)
  assert.equal(session.commands.length, 1)
  assert.equal(execution.result.takeover, undefined)
  await execution.lock!.release()
})

test('busy run lock held by a verified Phi run: TERM the group, take over, report it, one remote command', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const pid = await startOldRun(f, 'b'.repeat(32))
  assert.ok(alive(pid))
  const { session, execution } = await startup(f)
  assert.equal(session.commands.length, 1)
  assert.deepEqual(execution.result.takeover, { stoppedPid: pid })
  assert.ok(!alive(pid))
  assert.ok(RUN_STOPPED_NOTICE.includes('已停止上一次未结束的远端运行'))
  await execution.lock!.release()
})

test('busy run lock whose process ignores TERM is KILLed after the bounded wait', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await writeFile(join(f.root, 'stubborn.sh'), '')
  const nonce = 'c'.repeat(32)
  const command = `umask 077 && cd -- ${q(f.root)} && ${buildRunGuardWrapper({ runLock: f.runLock, runRecord: f.runRecord, nonce })}env -i PATH=${q(process.env.PATH ?? '/usr/bin:/bin')} ${RUN_NONCE_ENV}=${nonce} ${q(f.fakeOmp)} 300`
  // A TERM-immune holder: ignore TERM in the launching shell; the disposition survives exec.
  const child = spawn('bash', ['-c', `trap '' TERM; ${command}`], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  for (let i = 0; i < 100 && !existsSync(f.runRecord); i++) await delay(50)
  await delay(150)
  const { execution } = await startup(f)
  assert.deepEqual(execution.result.takeover, { stoppedPid: child.pid })
  assert.ok(!alive(child.pid!))
  await execution.lock!.release()
})

test('busy run lock with an unverifiable holder is never killed and fails with DOMAIN_CONFLICT', async (t) => {
  const f = await fixture()
  const pid = await startOldRun(f, 'd'.repeat(32))
  t.after(async () => {
    killGroup(pid)
    await rm(f.root, { recursive: true, force: true })
  })
  // Different executable than the one we deployed.
  await assert.rejects(
    startup(f, join(f.root, 'other-omp')),
    (error: { code?: string; message: string }) => {
      assert.equal(error.code, 'DOMAIN_CONFLICT')
      assert.match(error.message, /另一个进程/u)
      return true
    }
  )
  assert.ok(alive(pid))
  // Tampered record (pgid does not match the process).
  const original = (await readFile(f.runRecord, 'utf8')).split('\t')
  original[2] = String(pid + 7)
  await writeFile(f.runRecord, original.join('\t'), { mode: 0o600 })
  await assert.rejects(startup(f), (error: { code?: string }) => error.code === 'DOMAIN_CONFLICT')
  assert.ok(alive(pid))
  // Missing record.
  await rm(f.runRecord)
  await assert.rejects(startup(f), (error: { code?: string }) => error.code === 'DOMAIN_CONFLICT')
  assert.ok(alive(pid))
})

test('an unverifiable holder reaches recovery as the coded Chinese message', async (t) => {
  const f = await fixture()
  const pid = await startOldRun(f, 'e'.repeat(32))
  t.after(async () => {
    killGroup(pid)
    await rm(f.root, { recursive: true, force: true })
  })
  const error = await startup(f, join(f.root, 'other-omp')).catch((cause: unknown) => cause)
  const described = describeRemoteRecoveryFailure(error)
  assert.match(described.message, /另一个进程/u)
})

test('launch wrapper works from a csh login shell and record pid is the exec-chain final pid', async (t) => {
  const f = await fixture()
  const nonce = 'f'.repeat(32)
  const wrapper = buildRunGuardWrapper({ runLock: f.runLock, runRecord: f.runRecord, nonce })
  // csh -> exec sh -> exec env -> exec fake omp: one pid throughout.
  const command = `umask 077 && ${wrapper}env -i PATH=${q(process.env.PATH ?? '/usr/bin:/bin')} ${RUN_NONCE_ENV}=${nonce} ${q(f.fakeOmp)} 300`
  const child = spawn('/bin/csh', ['-c', command], { detached: true, stdio: 'ignore', cwd: f.root })
  child.unref()
  const pid = child.pid!
  t.after(async () => {
    killGroup(pid)
    await rm(f.root, { recursive: true, force: true })
  })
  for (let i = 0; i < 100 && !existsSync(f.runRecord); i++) await delay(50)
  await delay(150)
  const record = (await readFile(f.runRecord, 'utf8')).trimEnd().split('\t')
  assert.equal(Number(record[1]), pid)
  assert.equal(Number(record[2]), pid)
  const args = spawn('ps', ['-o', 'args=', '-p', String(pid)])
  let out = ''
  args.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
  await new Promise((resolve) => args.once('close', resolve))
  assert.ok(out.trim().startsWith(f.fakeOmp), out)
})
