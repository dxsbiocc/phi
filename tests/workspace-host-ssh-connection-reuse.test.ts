import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

import { CodedError } from '../src/shared/errorCodes'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'
import {
  createLocalShellSession,
  installSetsidShim,
  type LocalShellSession
} from './helpers/localShellSession'

let shimDirectory = ''
let restoreSetsid = (): void => undefined

before(async () => {
  shimDirectory = await mkdtemp(join(tmpdir(), 'phi-ssh-reuse-setsid-'))
  restoreSetsid = installSetsidShim(shimDirectory)
})

after(async () => {
  restoreSetsid()
  await rm(shimDirectory, { recursive: true, force: true })
})

interface Fixture {
  root: string
  host: SshHost
  sessions: LocalShellSession[]
  connects: () => number
  cleanup: () => Promise<void>
}

async function fixture(
  decorate: (session: LocalShellSession, index: number) => RemoteSshSession = (session) => session
): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-ssh-reuse-')))
  const sessions: LocalShellSession[] = []
  const host = new SshHost({
    remoteRoot: root,
    canonicalRoot: root,
    connect: async () => {
      await delay(5)
      const session = createLocalShellSession(root)
      sessions.push(session)
      return decorate(session, sessions.length - 1)
    }
  })
  return {
    root,
    host,
    sessions,
    connects: () => sessions.length,
    cleanup: async () => {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}

test('pure SSH operations share one connection, including concurrent first calls', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'a.txt'), 'a')
    await Promise.all([1, 2, 3].map(() => f.host.fs.readRange('a.txt', { offset: 0, length: 1 })))
    for (let index = 0; index < 5; index += 1) {
      await f.host.fs.readRange('a.txt', { offset: 0, length: 1 })
    }
    await f.host.fs.list('.')
    assert.equal(f.connects(), 1)
    assert.equal(f.sessions[0].closed, false)
  } finally {
    await f.cleanup()
  }
})

test('closing the host closes the shared connection once', async () => {
  const f = await fixture()
  await f.host.fs.list('.')
  await f.host.close()
  assert.equal(f.sessions[0].closed, true)
  await rm(f.root, { recursive: true, force: true })
})

test('a failed connect is not cached and the next call reconnects', async () => {
  let attempts = 0
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-ssh-reuse-fail-')))
  const host = new SshHost({
    remoteRoot: root,
    canonicalRoot: root,
    connect: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('connect refused')
      return createLocalShellSession(root)
    }
  })
  try {
    await assert.rejects(host.fs.list('.'), /connect refused/)
    await host.fs.list('.')
    await host.fs.list('.')
    assert.equal(attempts, 2)
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('TRANSPORT_LOST drops the shared connection and the next call reconnects', async () => {
  const f = await fixture((session, index) => {
    if (index > 0) return session
    const exec = session.exec.bind(session)
    session.exec = async (command) => {
      if (session.commands.length >= 3)
        throw new CodedError('TRANSPORT_LOST', 'SSH connection lost')
      return exec(command)
    }
    return session
  })
  try {
    await assert.rejects(
      (async () => {
        for (;;) await f.host.fs.list('.')
      })(),
      { code: 'TRANSPORT_LOST' }
    )
    assert.equal(f.connects(), 1)
    await f.host.fs.list('.')
    assert.equal(f.connects(), 2)
    assert.equal(f.sessions[0].closed, true)
    assert.equal(f.sessions[1].closed, false)
  } finally {
    await f.cleanup()
  }
})

test('a non-transport error keeps the shared connection', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.host.fs.readRange('missing.txt', { offset: 0, length: 1 }))
    await f.host.fs.list('.')
    assert.equal(f.connects(), 1)
  } finally {
    await f.cleanup()
  }
})

test('typical sequence of project open, five reads and one foreground command uses one master', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'a.txt'), 'a')
    await f.host.fs.stat('.')
    for (let index = 0; index < 5; index += 1) {
      await f.host.fs.readRange('a.txt', { offset: 0, length: 1 })
    }
    const result = await f.host.exec.run(['echo', 'hello'], { cwd: '.' })
    assert.equal(result.stdout, 'hello\n')
    assert.equal(f.connects(), 1)
  } finally {
    await f.cleanup()
  }
})

test('foreground commands stream on the shared connection without detach files or polling', async () => {
  const f = await fixture()
  try {
    const result = await f.host.exec.run(['bash', '-c', 'echo out; echo err >&2; exit 3'], {
      cwd: '.',
      env: { PHI_TEST_VALUE: 'x y' }
    })
    assert.equal(result.stdout, 'out\n')
    assert.equal(result.stderr, 'err\n')
    assert.equal(result.code, 3)
    assert.equal(result.signal, null)
    assert.equal(result.truncated, false)
    assert.equal(existsSync(join(f.root, 'wrappers')), false)
    assert.equal(f.connects(), 1)
    const polls = f.sessions[0].commands.filter((command) => /launch\.sh|exit_code/.test(command))
    assert.deepEqual(polls, [])
    const env = await f.host.exec.run(['bash', '-c', 'printf %s "$PHI_TEST_VALUE"'], {
      cwd: '.',
      env: { PHI_TEST_VALUE: 'x y' }
    })
    assert.equal(env.stdout, 'x y')
  } finally {
    await f.cleanup()
  }
})

test('a long-running foreground command is not stopped while its connection is healthy', async () => {
  const f = await fixture()
  try {
    const result = await f.host.exec.run(['bash', '-c', 'sleep 2.5; echo finished'], { cwd: '.' })
    assert.equal(result.stdout, 'finished\n')
    assert.equal(result.code, 0)
    assert.equal(result.terminationReason, undefined)
  } finally {
    await f.cleanup()
  }
})

test('a foreground timeout returns partial output and stops the remote process group', async () => {
  const f = await fixture()
  try {
    const pidFile = join(f.root, 'child.pid')
    const result = await f.host.exec.run(
      ['bash', '-c', `echo started; echo $$ > ${pidFile}; sleep 60 & wait`],
      { cwd: '.', timeoutMs: 600 }
    )
    assert.equal(result.stdout, 'started\n')
    assert.equal(result.code, null)
    assert.ok(result.signal)
    assert.equal(result.terminationReason, 'timeout')
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    await delay(100)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally {
    await f.cleanup()
  }
})

test('a foreground cancellation reports cancelled and an already-aborted signal never launches', async () => {
  const f = await fixture()
  try {
    const controller = new AbortController()
    const pending = f.host.exec.run(['sleep', '30'], { cwd: '.', signal: controller.signal })
    setTimeout(() => controller.abort(), 150)
    const result = await pending
    assert.equal(result.terminationReason, 'cancelled')
    assert.equal(result.code, null)
    const before = f.sessions[0].commands.length
    const aborted = new AbortController()
    aborted.abort()
    const skipped = await f.host.exec.run(['echo', 'no'], { cwd: '.', signal: aborted.signal })
    assert.equal(skipped.terminationReason, 'cancelled')
    assert.equal(skipped.stdout, '')
    assert.equal(f.sessions[0].commands.length, before)
  } finally {
    await f.cleanup()
  }
})

test('foreground output beyond the budget is dropped while the command finishes', async () => {
  const f = await fixture()
  try {
    const result = await f.host.exec.run(['bash', '-c', 'printf abcdefgh; printf ijklmnop >&2'], {
      cwd: '.',
      maxOutputBytes: 10
    })
    assert.equal(result.code, 0)
    assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 10)
    assert.equal(result.truncated, true)
  } finally {
    await f.cleanup()
  }
})

test('a foreground command whose connection dies reports TRANSPORT_LOST', async () => {
  const f = await fixture((session) => {
    const open = session.openStdio!.bind(session)
    session.openStdio = async (command) => {
      const channel = await open(command)
      return { ...channel, closed: Promise.resolve({ code: 255, signal: null }) }
    }
    const exec = session.exec.bind(session)
    session.exec = async (command) => {
      if (command === 'true') throw new CodedError('TRANSPORT_LOST', 'SSH connection lost')
      return exec(command)
    }
    return session
  })
  try {
    await assert.rejects(f.host.exec.run(['sleep', '5'], { cwd: '.' }), { code: 'TRANSPORT_LOST' })
    await f.host.fs.list('.')
    assert.equal(f.connects(), 2)
  } finally {
    await f.cleanup()
  }
})

test('a background task polls on the shared connection and can be terminated', async () => {
  const f = await fixture()
  try {
    const handle = await f.host.exec.spawnBackground(['sleep', '30'], {
      cwd: '.',
      timeoutMs: 60_000
    })
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await handle.query()).running, true)
    }
    const result = await handle.terminate()
    assert.equal(result.code, null)
    assert.ok(result.signal)
    assert.equal((await handle.query()).running, false)
    assert.equal(f.connects(), 1)
  } finally {
    await f.cleanup()
  }
})

test('concurrent channels on the shared connection stay below the server session limit', async () => {
  let active = 0
  let peak = 0
  const f = await fixture((session) => {
    const exec = session.exec.bind(session)
    session.exec = async (command) => {
      active += 1
      peak = Math.max(peak, active)
      try {
        await delay(15)
        return await exec(command)
      } finally {
        active -= 1
      }
    }
    return session
  })
  try {
    await writeFile(join(f.root, 'a.txt'), 'a')
    await Promise.all(
      Array.from({ length: 30 }, () => f.host.fs.readRange('a.txt', { offset: 0, length: 1 }))
    )
    assert.ok(peak > 1, `expected parallel channels, saw ${peak}`)
    assert.ok(peak <= 8, `expected at most 8 concurrent channels, saw ${peak}`)
    assert.equal(f.connects(), 1)
  } finally {
    await f.cleanup()
  }
})

test('a caller queued for a channel can still be cancelled', async () => {
  const f = await fixture()
  try {
    const holders = Array.from({ length: 8 }, () => f.host.exec.run(['sleep', '2'], { cwd: '.' }))
    await delay(300)
    const controller = new AbortController()
    const queued = f.host.exec.run(['echo', 'late'], { cwd: '.', signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    const result = await queued
    assert.equal(result.terminationReason, 'cancelled')
    assert.equal(result.stdout, '')
    assert.ok(Date.now() - started < 1500)
    await Promise.all(holders)
  } finally {
    await f.cleanup()
  }
})

test('a refused channel on a live master is not a lost transport', async () => {
  const f = await fixture((session, index) => {
    if (index > 0) return session
    session.isAlive = async () => true
    session.openStdio = async () => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      stderr.end(
        'mux_client_request_session: session request failed: Session open refused by peer\n'
      )
      stdout.end()
      return {
        stdin: new PassThrough(),
        stdout,
        stderr,
        closed: new Promise((resolve) =>
          setTimeout(() => resolve({ code: 255, signal: null }), 20)
        ),
        close: async () => undefined
      }
    }
    return session
  })
  try {
    await assert.rejects(f.host.exec.run(['sleep', '5'], { cwd: '.' }), (error: unknown) => {
      assert.notEqual((error as { code?: string }).code, 'TRANSPORT_LOST')
      assert.match((error as Error).message, /refused|拒绝/)
      return true
    })
    await f.host.fs.list('.')
    assert.equal(f.connects(), 1)
  } finally {
    await f.cleanup()
  }
})

test('a foreground failure on a dead master is TRANSPORT_LOST', async () => {
  const f = await fixture((session) => {
    const open = session.openStdio!.bind(session)
    session.openStdio = async (command) => {
      const channel = await open(command)
      return { ...channel, closed: Promise.resolve({ code: 255, signal: null }) }
    }
    session.isAlive = async () => false
    return session
  })
  try {
    await assert.rejects(f.host.exec.run(['sleep', '5'], { cwd: '.' }), { code: 'TRANSPORT_LOST' })
    await f.host.fs.list('.')
    assert.equal(f.connects(), 2)
  } finally {
    await f.cleanup()
  }
})

test('an idle shared connection is liveness-checked and replaced transparently when dead', async (t) => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const checks: number[] = []
  const f = await fixture((session, index) => {
    session.isAlive = async () => {
      checks.push(index)
      return index !== 0
    }
    return session
  })
  try {
    await f.host.fs.list('.')
    now += 5_000
    await f.host.fs.list('.')
    assert.deepEqual(checks, [])
    now += 31_000
    await f.host.fs.list('.')
    assert.deepEqual(checks, [0])
    assert.equal(f.connects(), 2)
    assert.equal(f.sessions[0].closed, true)
    now += 31_000
    await f.host.fs.list('.')
    assert.deepEqual(checks, [0, 1])
    assert.equal(f.connects(), 2)
  } finally {
    await f.cleanup()
  }
})
