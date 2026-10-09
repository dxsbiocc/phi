import assert from 'node:assert/strict'
import test from 'node:test'

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

test('password authentication installs the public key through the same one-use SSH session', async () => {
  const requests: SshBootstrapSecretCommandRequest[] = []
  const removed: string[] = []
  const askpassFiles: SshAskpassFileSystem = {
    createDirectory: async () => '/tmp/askpass',
    writeFile: async () => undefined,
    createSecretPipe: async () => ({ close: async () => undefined }),
    remove: async () => undefined
  }
  const sessionFiles: SshPasswordSessionFileSystem = {
    createDirectory: async () => '/tmp/password-session',
    remove: async (path) => {
      removed.push(path)
    }
  }
  const authFailures: string[] = []
  const authenticator = createSshPasswordSessionAuthenticator({
    askpassFiles,
    sessionFiles,
    authGate: {
      recordSshFailure: (key) => authFailures.push(key),
      assertSshNotBlocked: () => undefined,
      clearSshBlock: () => undefined
    },
    runCommand: async (request) => {
      requests.push(request)
      return {
        exitCode: 0,
        stdout: '',
        stderr: 'debug1: Authentications that can continue: publickey,password\n'
      }
    }
  })

  const authenticated = await authenticator.authenticate(TARGET, 'one-use-password')
  assert.equal(authenticated.status, 'ready')
  if (authenticated.status !== 'ready') return
  assert.deepEqual(
    await authenticated.session.installPublicKey('ssh-ed25519 AAAA-new-key phi@test'),
    { status: 'ready' }
  )
  await authenticated.session.close()

  assert.equal(requests.length, 3)
  const [open, install, close] = requests
  assert.ok(open.args.includes('-M'))
  assert.ok(open.args.includes('-N'))
  assert.ok(open.args.includes('-f'))
  assert.ok(open.args.includes('StrictHostKeyChecking=yes'))
  assert.deepEqual(open.args.slice(open.args.indexOf('-F'), open.args.indexOf('-F') + 2), [
    '-F',
    '/dev/null'
  ])
  assert.equal(open.args.includes('one-use-password'), false)
  assert.equal(open.env?.PHI_SSH_ASKPASS_SECRET, undefined)
  assert.equal(open.env?.PHI_SSH_ASKPASS_PIPE, '/tmp/askpass/secret.pipe')
  assert.ok(install.args.includes('-S'))
  assert.equal(install.env?.PHI_SSH_ASKPASS_SECRET, undefined)
  assert.equal(install.stdin, 'ssh-ed25519 AAAA-new-key phi@test\n')
  assert.ok(close.args.includes('-O'))
  assert.ok(close.args.includes('exit'))
  assert.ok(close.args.indexOf('-O') < close.args.indexOf(TARGET.hostname))
  assert.deepEqual(removed, ['/tmp/password-session'])
  assert.deepEqual(authFailures, [])
})

test('one bootstrap opens at most three password sessions and records every rejection', async () => {
  let commands = 0
  let failures = 0
  let directory = 0
  const authenticator = createSshPasswordSessionAuthenticator({
    askpassFiles: {
      createDirectory: async () => `/tmp/askpass-${++directory}`,
      writeFile: async () => undefined,
      createSecretPipe: async () => ({ close: async () => undefined }),
      remove: async () => undefined
    },
    sessionFiles: {
      createDirectory: async () => `/tmp/session-${directory}`,
      remove: async () => undefined
    },
    authGate: {
      recordSshFailure: () => {
        failures += 1
      },
      assertSshNotBlocked: () => undefined,
      clearSshBlock: () => undefined
    },
    runCommand: async () => {
      commands += 1
      return {
        exitCode: 255,
        stdout: '',
        stderr: 'Permission denied (publickey,password).'
      }
    }
  })

  const results = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    results.push(await authenticator.authenticate(TARGET, `wrong-${attempt}`))
  }
  assert.deepEqual(
    results.map((result) => (result.status === 'rejected' ? result.errorCode : result.status)),
    [
      'authentication_failed',
      'authentication_failed',
      'password_attempts_exhausted',
      'password_attempts_exhausted'
    ]
  )
  assert.equal(commands, 3)
  assert.equal(failures, 3)
})

test('concurrent password requests reserve the three-attempt budget before spawning', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let commands = 0
  let directory = 0
  const authenticator = createSshPasswordSessionAuthenticator({
    askpassFiles: {
      createDirectory: async () => `/tmp/askpass-concurrent-${++directory}`,
      writeFile: async () => undefined,
      createSecretPipe: async () => ({ close: async () => undefined }),
      remove: async () => undefined
    },
    sessionFiles: {
      createDirectory: async () => `/tmp/session-concurrent-${directory}`,
      remove: async () => undefined
    },
    authGate: {
      recordSshFailure: () => undefined,
      assertSshNotBlocked: () => undefined,
      clearSshBlock: () => undefined
    },
    runCommand: async () => {
      commands += 1
      await gate
      return {
        exitCode: 255,
        stdout: '',
        stderr: 'Permission denied (publickey,password).'
      }
    }
  })

  const pending = Array.from({ length: 3 }, (_, index) =>
    authenticator.authenticate(TARGET, `wrong-${index}`, 'attempt-shared')
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await authenticator.authenticate(TARGET, 'must-not-spawn', 'attempt-shared'), {
    status: 'rejected',
    errorCode: 'password_attempts_exhausted'
  })
  assert.equal(commands, 3)
  release()
  await Promise.all(pending)
})
