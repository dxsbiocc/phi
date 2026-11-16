import assert from 'node:assert/strict'
import test from 'node:test'

import { runSshBootstrapCommand } from '../src/main/agent/ssh-bootstrap/runtime'
import {
  createSshPasswordSessionAuthenticator,
  type SshPasswordSessionFileSystem
} from '../src/main/agent/ssh-bootstrap/password-session'
import type { SshAskpassFileSystem } from '../src/main/agent/ssh-bootstrap/askpass'
import type { SshBootstrapSecretCommandRequest } from '../src/main/agent/ssh-bootstrap/credentials'

const TARGET = {
  alias: 'lab-hpc',
  hostname: 'compute.example.invalid',
  user: 'scientist',
  port: 22022
}

const ASKPASS: SshAskpassFileSystem = {
  createDirectory: async () => '/tmp/askpass-background',
  writeFile: async () => undefined,
  createSecretPipe: async () => ({ close: async () => undefined }),
  remove: async () => undefined
}

function sessionFiles(
  created: string[] = [],
  removed: string[] = []
): SshPasswordSessionFileSystem {
  let counter = 0
  return {
    createDirectory: async () => {
      const path = `/tmp/password-session-${++counter}`
      created.push(path)
      return path
    },
    remove: async (path) => {
      removed.push(path)
    }
  }
}

function authGate(): {
  recordSshFailure: (key: string, code: string) => void
  assertSshNotBlocked: (key: string) => void
  clearSshBlock: (key: string) => void
  failures: Array<{ key: string; code: string }>
} {
  const failures: Array<{ key: string; code: string }> = []
  return {
    failures,
    recordSshFailure: (key, code) => failures.push({ key, code }),
    assertSshNotBlocked: () => undefined,
    clearSshBlock: () => undefined
  }
}

test(
  'a deadline settles immediately as a failure when a descendant holds the pipes',
  { skip: process.platform === 'win32' },
  async () => {
    const started = Date.now()
    const result = await runSshBootstrapCommand({
      command: '/bin/sh',
      args: ['-c', 'sleep 2 &'],
      timeoutMs: 100
    })
    const elapsed = Date.now() - started

    assert.ok(elapsed < 1000, `deadline must not wait for the descendant, took ${elapsed}ms`)
    assert.deepEqual(result, { exitCode: null, stdout: '', stderr: 'Command timed out' })
  }
)

test(
  'a timed-out command still bounds captured output',
  { skip: process.platform === 'win32' },
  async () => {
    const started = Date.now()
    const result = await runSshBootstrapCommand({
      command: '/bin/sh',
      args: ['-c', 'printf early; sleep 2 &'],
      timeoutMs: 100,
      maxOutputBytes: 8
    })

    assert.ok(Date.now() - started < 1000)
    assert.equal(result.exitCode, null)
    assert.equal(result.stderr, 'Command timed out')
    assert.ok(Buffer.byteLength(result.stdout) <= 8)
  }
)

test(
  'ordinary commands still wait for trailing descendant output before settling',
  { skip: process.platform === 'win32' },
  async () => {
    // The direct child exits while a background descendant writes after a delay. Without the
    // background flag the runner must keep close semantics and capture that trailing output.
    const result = await runSshBootstrapCommand({
      command: '/bin/sh',
      args: ['-c', '(sleep 0.3; printf trailing-from-descendant) & printf immediate']
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'immediatetrailing-from-descendant')
  }
)

test(
  'an ordinary command exit code is preserved and is not treated as daemonization',
  { skip: process.platform === 'win32' },
  async () => {
    const result = await runSshBootstrapCommand({
      command: '/bin/sh',
      args: ['-c', 'exit 7']
    })

    assert.equal(result.exitCode, 7)
  }
)

test(
  'background commands settle on parent exit without waiting for inherited pipes',
  { skip: process.platform === 'win32' },
  async () => {
    const started = Date.now()
    const result = await runSshBootstrapCommand({
      command: '/bin/sh',
      args: ['-c', '(sleep 3 &) ; exit 0'],
      background: true
    })
    const elapsed = Date.now() - started

    assert.equal(result.exitCode, 0)
    assert.ok(
      elapsed < 2000,
      `background completion must not wait on descendants, took ${elapsed}ms`
    )
  }
)

test(
  'background commands still capture output written before the parent exits',
  { skip: process.platform === 'win32' },
  async () => {
    const result = await runSshBootstrapCommand({
      command: '/bin/sh',
      args: ['-c', 'printf before-exit; (sleep 3 &) ; exit 0'],
      background: true
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'before-exit')
  }
)

test(
  'background commands prefer close when the daemon releases its inherited pipes',
  { skip: process.platform === 'win32' },
  async () => {
    const started = Date.now()
    const result = await runSshBootstrapCommand({
      command: '/bin/sh',
      args: ['-c', 'printf closed-cleanly; exit 0'],
      background: true
    })
    const elapsed = Date.now() - started

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'closed-cleanly')
    assert.ok(elapsed < 2000, `a clean close must settle promptly, took ${elapsed}ms`)
  }
)

test(
  'a background command that fails never reports success',
  { skip: process.platform === 'win32' },
  async () => {
    const started = Date.now()
    const result = await runSshBootstrapCommand({
      command: '/bin/sh',
      args: ['-c', 'printf denied >&2; (sleep 3 &) ; exit 255'],
      background: true
    })
    const elapsed = Date.now() - started

    assert.equal(result.exitCode, 255)
    assert.equal(result.stderr, 'denied')
    assert.ok(elapsed < 2000, `a failing background command must settle on exit, took ${elapsed}ms`)
  }
)

test(
  'a background command that hangs still times out as a failure',
  { skip: process.platform === 'win32' },
  async () => {
    const result = await runSshBootstrapCommand({
      command: '/bin/sh',
      args: ['-c', 'sleep 5'],
      background: true,
      timeoutMs: 100
    })

    assert.deepEqual(result, { exitCode: null, stdout: '', stderr: 'Command timed out' })
  }
)

test(
  'captured output from a background command never leaks the secret',
  { skip: process.platform === 'win32' },
  async () => {
    const secret = 'background-runner-secret'
    const result = await runSshBootstrapCommand({
      command: process.execPath,
      args: [
        '-e',
        "process.stderr.write(process.env.PHI_SSH_ASKPASS_SECRET ?? ''); (require('node:child_process').spawn('sleep', ['2'], { detached: true, stdio: 'inherit' })).unref()"
      ],
      env: { PHI_SSH_ASKPASS_SECRET: secret },
      background: true,
      timeoutMs: 5_000
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stderr, '[REDACTED]')
    assert.equal(JSON.stringify(result).includes(secret), false)
  }
)

test('password session opens the master in the background and confirms its exact control socket', async () => {
  const requests: SshBootstrapSecretCommandRequest[] = []
  const removed: string[] = []
  const authenticator = createSshPasswordSessionAuthenticator({
    askpassFiles: ASKPASS,
    sessionFiles: sessionFiles([], removed),
    authGate: authGate(),
    runCommand: async (request) => {
      requests.push(request)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
  })

  const authenticated = await authenticator.authenticate(TARGET, 'one-use-password')
  assert.equal(authenticated.status, 'ready')
  if (authenticated.status !== 'ready') return

  // Authentication is exactly `open` then `-O check`; it must not wait on the daemon.
  assert.equal(requests.length, 2)
  const [open, check] = requests
  assert.equal(open.background, true)
  assert.ok(open.args.includes('-M') && open.args.includes('-N') && open.args.includes('-f'))
  assert.equal(check.background, undefined)
  assert.ok(check.args.includes('-O') && check.args.includes('check'))
  const controlPath = open.args[open.args.indexOf('-S') + 1]
  assert.equal(check.args[check.args.indexOf('-S') + 1], controlPath)
  assert.ok(controlPath.startsWith('/tmp/password-session-'))
  assert.equal(JSON.stringify(requests).includes('one-use-password'), false)

  assert.deepEqual(await authenticated.session.installPublicKey('ssh-ed25519 AAAA phi@test'), {
    status: 'ready'
  })
  const install = requests[2]
  assert.equal(install.background, undefined)
  assert.equal(install.args[install.args.indexOf('-S') + 1], controlPath)

  await authenticated.session.close()
  const close = requests[3]
  assert.ok(close.args.includes('-O') && close.args.includes('exit'))
  assert.equal(close.args[close.args.indexOf('-S') + 1], controlPath)
  assert.equal(JSON.stringify(requests).includes('one-use-password'), false)
  assert.deepEqual(removed, ['/tmp/password-session-1'])
})

test('a failed control-socket check closes only the owned master and rejects the session', async () => {
  const requests: SshBootstrapSecretCommandRequest[] = []
  const removed: string[] = []
  const authenticator = createSshPasswordSessionAuthenticator({
    askpassFiles: ASKPASS,
    sessionFiles: sessionFiles([], removed),
    authGate: authGate(),
    runCommand: async (request) => {
      requests.push(request)
      return request.args.includes('check')
        ? { exitCode: 255, stdout: '', stderr: 'master is not running' }
        : { exitCode: 0, stdout: '', stderr: '' }
    }
  })

  assert.deepEqual(await authenticator.authenticate(TARGET, 'password'), {
    status: 'rejected',
    errorCode: 'unexpected'
  })

  const openControlPath = requests[0].args[requests[0].args.indexOf('-S') + 1]
  const exits = requests.filter((request) => request.args.includes('exit'))
  assert.equal(exits.length, 1)
  assert.equal(exits[0].args[exits[0].args.indexOf('-S') + 1], openControlPath)
  assert.deepEqual(removed, ['/tmp/password-session-1'])
})

test('a timed-out master open cleans only its own master before deleting the session dir', async () => {
  const requests: SshBootstrapSecretCommandRequest[] = []
  const removed: string[] = []
  const authenticator = createSshPasswordSessionAuthenticator({
    askpassFiles: ASKPASS,
    sessionFiles: sessionFiles([], removed),
    authGate: authGate(),
    runCommand: async (request) => {
      requests.push(request)
      return request.args.includes('-N')
        ? { exitCode: null, stdout: '', stderr: 'Command timed out' }
        : { exitCode: 0, stdout: '', stderr: '' }
    }
  })

  assert.deepEqual(await authenticator.authenticate(TARGET, 'password'), {
    status: 'rejected',
    errorCode: 'unexpected'
  })

  assert.equal(requests[0].background, true)
  const exits = requests.filter((request) => request.args.includes('exit'))
  assert.equal(exits.length, 1)
  assert.equal(exits[0].args[exits[0].args.indexOf('-S') + 1], '/tmp/password-session-1/master')
  for (const request of requests) {
    const command = JSON.stringify(request)
    assert.equal(command.includes('pkill'), false)
    assert.equal(command.includes('killall'), false)
  }
  assert.deepEqual(removed, ['/tmp/password-session-1'])
})

test('a wrong password never starts a master and never closes one', async () => {
  const requests: SshBootstrapSecretCommandRequest[] = []
  const removed: string[] = []
  const gate = authGate()
  const authenticator = createSshPasswordSessionAuthenticator({
    askpassFiles: ASKPASS,
    sessionFiles: sessionFiles([], removed),
    authGate: gate,
    runCommand: async (request) => {
      requests.push(request)
      return {
        exitCode: 255,
        stdout: '',
        stderr: 'Permission denied (password).'
      }
    }
  })

  assert.deepEqual(await authenticator.authenticate(TARGET, 'wrong-password'), {
    status: 'rejected',
    errorCode: 'authentication_failed'
  })

  // An ordinary rejection never forked a master, so nothing is closed.
  assert.equal(requests.length, 1)
  assert.equal(requests[0].background, true)
  assert.equal(
    requests.some((request) => request.args.includes('exit')),
    false
  )
  for (const request of requests) {
    assert.equal(JSON.stringify(request).includes('pkill'), false)
    assert.equal(JSON.stringify(request).includes('killall'), false)
  }
  assert.equal(gate.failures.length, 1)
  assert.deepEqual(removed, ['/tmp/password-session-1'])
})

test('a real daemonizing child settles on parent exit instead of inherited pipes', async () => {
  // A real local child that forks a long-lived descendant holding the inherited stdout/stderr,
  // mirroring `ssh -M -N -f` completion. It must settle on parent exit, not on pipe close.
  const started = Date.now()
  const result = await runSshBootstrapCommand({
    command: process.execPath,
    args: [
      '-e',
      "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref()"
    ],
    background: true
  })
  const elapsed = Date.now() - started

  assert.equal(result.exitCode, 0)
  assert.ok(elapsed < 2000, `detached child must not be awaited, took ${elapsed}ms`)
})

for (const fault of ['check-throws', 'remove-throws'] as const) {
  test(`confirmation cleanup releases reserved attempts when ${fault}`, async () => {
    const requests: SshBootstrapSecretCommandRequest[] = []
    const removed: string[] = []
    const files = sessionFiles([], removed)
    const authenticator = createSshPasswordSessionAuthenticator({
      askpassFiles: ASKPASS,
      sessionFiles:
        fault === 'remove-throws'
          ? {
              ...files,
              remove: async () => {
                throw new Error('cleanup denied')
              }
            }
          : files,
      authGate: authGate(),
      runCommand: async (request) => {
        requests.push(request)
        if (request.args.includes('check')) {
          if (fault === 'check-throws') throw new Error('transport rejected')
          return { exitCode: 255, stdout: '', stderr: 'not ready' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      }
    })
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.deepEqual(await authenticator.authenticate(TARGET, 'password'), {
        status: 'rejected',
        errorCode: 'unexpected'
      })
    }
    const opens = requests.filter((r) => r.args.includes('-N'))
    const exits = requests.filter((r) => r.args.includes('exit'))
    assert.equal(opens.length, 5)
    assert.equal(exits.length, 5)
    assert.deepEqual(
      exits.map((r) => r.args[r.args.indexOf('-S') + 1]),
      opens.map((r) => r.args[r.args.indexOf('-S') + 1])
    )
  })
}
