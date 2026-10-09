import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createNodeSshAskpassFileSystem,
  withSshAskpass,
  type SshAskpassFileSystem
} from '../src/main/agent/ssh-bootstrap/askpass'
import { runSshBootstrapCommand } from '../src/main/agent/ssh-bootstrap/runtime'
import {
  createSshPasswordAuthenticator,
  type SshBootstrapSecretCommandRequest
} from '../src/main/agent/ssh-bootstrap/credentials'
import {
  createNodeSshBootstrapKeyFileSystem,
  generateSshBootstrapKey,
  loadSshBootstrapKey,
  verifySshBootstrapKey,
  type SshBootstrapKeyFileSystem
} from '../src/main/agent/ssh-bootstrap/key'
import { installSshPublicKeyWithPassword } from '../src/main/agent/ssh-bootstrap/install-key'

const TARGET = {
  alias: 'gpu-lab',
  hostname: 'compute.example.invalid',
  user: 'scientist',
  port: 22022
}

function memoryAskpassFiles(
  writes: Array<{ path: string; content: string; mode: number }> = [],
  removed: string[] = [],
  pipes: Array<{ path: string; content: Buffer; mode: number }> = []
): SshAskpassFileSystem {
  return {
    createDirectory: async () => '/tmp/phi-askpass-test',
    writeFile: async (path, content, mode) => {
      writes.push({ path, content, mode })
    },
    createSecretPipe: async (path, content, mode) => {
      pipes.push({ path, content: Buffer.from(content), mode })
      return { close: async () => undefined }
    },
    remove: async (path) => {
      removed.push(path)
    }
  }
}

test('askpass keeps the secret out of its 0700 helper and deletes it after failure', async () => {
  const secret = 'password-that-must-stay-in-memory'
  const writes: Array<{ path: string; content: string; mode: number }> = []
  const removed: string[] = []
  const pipes: Array<{ path: string; content: Buffer; mode: number }> = []
  const files = memoryAskpassFiles(writes, removed, pipes)
  await assert.rejects(
    withSshAskpass(secret, files, async ({ env }) => {
      assert.equal(env.SSH_ASKPASS_REQUIRE, 'force')
      assert.equal(env.DISPLAY, 'phi-ssh-askpass:0')
      assert.equal(env.PHI_SSH_ASKPASS_SECRET, undefined)
      assert.equal(env.PHI_SSH_ASKPASS_PIPE, '/tmp/phi-askpass-test/secret.pipe')
      assert.equal(env.PHI_SSH_ASKPASS_BYTES, String(Buffer.byteLength(secret)))
      throw new Error('synthetic command failure')
    }),
    /synthetic command failure/
  )
  assert.equal(writes.length, 1)
  assert.equal(writes[0].mode, 0o700)
  assert.equal(writes[0].content.includes(secret), false)
  assert.equal(pipes.length, 1)
  assert.equal(pipes[0].path, '/tmp/phi-askpass-test/secret.pipe')
  assert.equal(pipes[0].mode, 0o600)
  assert.equal(pipes[0].content.toString('utf8'), secret)
  assert.deepEqual(removed, ['/tmp/phi-askpass-test'])
})
test('password authentication is strict-host-key checked and exposes the password only to askpass', async () => {
  const password = 'one-time-server-password'
  const requests: SshBootstrapSecretCommandRequest[] = []
  const authenticator = createSshPasswordAuthenticator({
    askpassFiles: memoryAskpassFiles(),
    authGate: {
      recordSshFailure: () => undefined,
      assertSshNotBlocked: () => undefined,
      clearSshBlock: () => undefined
    },
    runCommand: async (request) => {
      requests.push(request)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
  })
  assert.deepEqual(await authenticator.authenticate(TARGET, password), { status: 'ready' })
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.command, 'ssh')
  assert.equal(request.args.includes(password), false)
  assert.deepEqual(request.args, [
    '-F',
    '/dev/null',
    '-v',
    '-o',
    'BatchMode=no',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'PreferredAuthentications=password',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'PubkeyAuthentication=no',
    '-o',
    'NumberOfPasswordPrompts=1',
    '-p',
    '22022',
    '-l',
    'scientist',
    'compute.example.invalid',
    'true'
  ])
  assert.equal(request.env?.SSH_ASKPASS_REQUIRE, 'force')
  assert.equal(request.env?.PHI_SSH_ASKPASS_SECRET, undefined)
  assert.equal(request.env?.PHI_SSH_ASKPASS_PIPE, '/tmp/phi-askpass-test/secret.pipe')
})
test('password authentication records all three failures and never starts a fourth attempt', async () => {
  const recorded: Array<{ hostKey: string; code: string }> = []
  const requests: SshBootstrapSecretCommandRequest[] = []
  const authenticator = createSshPasswordAuthenticator({
    askpassFiles: memoryAskpassFiles(),
    authGate: {
      recordSshFailure: (hostKey, code) => recorded.push({ hostKey, code }),
      assertSshNotBlocked: () => undefined,
      clearSshBlock: () => undefined
    },
    runCommand: async (request) => {
      requests.push(request)
      return {
        exitCode: 255,
        stdout: '',
        stderr: 'Permission denied (password).'
      }
    }
  })

  assert.deepEqual(await authenticator.authenticate(TARGET, 'wrong-1'), {
    status: 'rejected',
    errorCode: 'authentication_failed'
  })
  assert.deepEqual(await authenticator.authenticate(TARGET, 'wrong-2'), {
    status: 'rejected',
    errorCode: 'authentication_failed'
  })
  assert.deepEqual(await authenticator.authenticate(TARGET, 'wrong-3'), {
    status: 'rejected',
    errorCode: 'password_attempts_exhausted'
  })
  assert.deepEqual(await authenticator.authenticate(TARGET, 'must-not-run'), {
    status: 'rejected',
    errorCode: 'password_attempts_exhausted'
  })

  assert.equal(requests.length, 3)
  assert.deepEqual(
    recorded,
    Array.from({ length: 3 }, () => ({
      hostKey: '["gpu-lab",null,null,null]',
      code: 'authentication_failed'
    }))
  )
  const recordedCommands = JSON.stringify(requests.map(({ command, args }) => ({ command, args })))
  for (const secret of ['wrong-1', 'wrong-2', 'wrong-3', 'must-not-run']) {
    assert.equal(recordedCommands.includes(secret), false)
  }
})
test('password authentication maps MFA and disabled public-key diagnostics to public codes only', async () => {
  const cases = [
    {
      stderr:
        'debug1: Authentications that can continue: keyboard-interactive\nPermission denied (keyboard-interactive). /private/server/path',
      exitCode: 255,
      errorCode: 'keyboard_interactive_unsupported'
    },
    {
      stderr: 'debug1: Authentications that can continue: password\nAuthenticated to host.',
      exitCode: 0,
      errorCode: 'pubkey_auth_disabled'
    }
  ] as const

  for (const fixture of cases) {
    const authenticator = createSshPasswordAuthenticator({
      askpassFiles: memoryAskpassFiles(),
      authGate: {
        recordSshFailure: () => undefined,
        assertSshNotBlocked: () => undefined,
        clearSshBlock: () => undefined
      },
      runCommand: async () => ({
        exitCode: fixture.exitCode,
        stdout: '',
        stderr: fixture.stderr
      })
    })

    const result = await authenticator.authenticate(TARGET, 'never-return-this-password')
    assert.deepEqual(result, { status: 'rejected', errorCode: fixture.errorCode })
    assert.equal(JSON.stringify(result).includes('/private/server/path'), false)
    assert.equal(JSON.stringify(result).includes('never-return-this-password'), false)
  }
})
test('passphrase-protected ed25519 generation uses askpass without ssh-keygen -N', async () => {
  const passphrase = 'private-key-passphrase'
  const requests: SshBootstrapSecretCommandRequest[] = []
  const modes: Array<{ path: string; mode: number }> = []
  const files: SshBootstrapKeyFileSystem = {
    ensureDirectory: async (path, mode) => {
      modes.push({ path, mode })
    },
    exists: async () => false,
    readText: async (path) => {
      assert.equal(path, '/home/alice/.ssh/phi_gpu-lab_ed25519.pub')
      return 'ssh-ed25519 AAAA-new-public-key phi@test\n'
    },
    chmod: async (path, mode) => {
      modes.push({ path, mode })
    },
    remove: async () => undefined,
    acquireLock: async () => async () => undefined
  }

  const result = await generateSshBootstrapKey(
    {
      alias: 'gpu-lab',
      protection: { kind: 'passphrase', passphrase }
    },
    {
      sshDirectory: '/home/alice/.ssh',
      machineName: 'alice-mac',
      date: '2026-10-09',
      files,
      askpassFiles: memoryAskpassFiles(),
      runCommand: async (request) => {
        requests.push(request)
        return request.args.includes('-lf')
          ? {
              exitCode: 0,
              stdout: '256 SHA256:new-key-fingerprint phi@test (ED25519)\n',
              stderr: ''
            }
          : { exitCode: 0, stdout: '', stderr: '' }
      }
    }
  )

  assert.deepEqual(result, {
    status: 'ready',
    privateKeyPath: '/home/alice/.ssh/phi_gpu-lab_ed25519',
    publicKey: 'ssh-ed25519 AAAA-new-public-key phi@test',
    fingerprint: 'SHA256:new-key-fingerprint'
  })
  assert.equal(requests.length, 2)
  const generation = requests[0]
  assert.equal(generation.command, 'ssh-keygen')
  assert.equal(generation.args.includes('-N'), false)
  assert.equal(generation.args.includes(passphrase), false)
  assert.deepEqual(generation.args, [
    '-q',
    '-t',
    'ed25519',
    '-f',
    '/home/alice/.ssh/phi_gpu-lab_ed25519',
    '-C',
    'phi@alice-mac-2026-10-09'
  ])
  assert.equal(generation.env?.SSH_ASKPASS_REQUIRE, 'force')
  assert.equal(generation.env?.PHI_SSH_ASKPASS_SECRET, undefined)
  assert.equal(generation.env?.PHI_SSH_ASKPASS_BYTES, String(Buffer.byteLength(passphrase)))
  assert.deepEqual(modes, [
    { path: '/home/alice/.ssh', mode: 0o700 },
    { path: '/home/alice/.ssh/phi_gpu-lab_ed25519', mode: 0o600 }
  ])
  assert.equal(JSON.stringify(result).includes(passphrase), false)
})
test('an empty passphrase is accepted only through the explicit passwordless choice', async () => {
  const files: SshBootstrapKeyFileSystem = {
    ensureDirectory: async () => undefined,
    exists: async () => false,
    readText: async () => 'ssh-ed25519 AAAA-public phi@test\n',
    chmod: async () => undefined,
    remove: async () => undefined,
    acquireLock: async () => async () => undefined
  }
  const requests: SshBootstrapSecretCommandRequest[] = []
  const dependencies = {
    sshDirectory: '/home/alice/.ssh',
    machineName: 'linux-workstation',
    date: '2026-10-09',
    files,
    askpassFiles: memoryAskpassFiles(),
    runCommand: async (request: SshBootstrapSecretCommandRequest) => {
      requests.push(request)
      return request.args.includes('-lf')
        ? { exitCode: 0, stdout: '256 SHA256:key phi@test (ED25519)\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }
    }
  }

  assert.deepEqual(
    await generateSshBootstrapKey(
      { alias: 'gpu-lab', protection: { kind: 'passphrase', passphrase: '' } },
      dependencies
    ),
    { status: 'rejected', errorCode: 'unexpected' }
  )
  assert.equal(requests.length, 0)

  assert.equal(
    (
      await generateSshBootstrapKey(
        { alias: 'gpu-lab', protection: { kind: 'passwordless-explicit' } },
        dependencies
      )
    ).status,
    'ready'
  )
  assert.equal(requests[0].env?.PHI_SSH_ASKPASS_SECRET, undefined)
  assert.equal(requests[0].env?.PHI_SSH_ASKPASS_BYTES, '0')
  assert.equal(requests[0].args.includes('-N'), false)
})
test('public-key installation is idempotent, stdin-only, and never chmods the home directory', async () => {
  const password = 'one-time-password'
  const publicKey = 'ssh-ed25519 AAAA-public-key phi@workstation'
  const requests: SshBootstrapSecretCommandRequest[] = []

  const result = await installSshPublicKeyWithPassword(
    { target: TARGET, password, publicKey },
    {
      askpassFiles: memoryAskpassFiles(),
      runCommand: async (request) => {
        requests.push(request)
        return { exitCode: 0, stdout: '', stderr: '' }
      }
    }
  )

  assert.deepEqual(result, { status: 'ready' })
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.command, 'ssh')
  assert.equal(request.args.includes(password), false)
  assert.equal(request.args.includes(publicKey), false)
  assert.equal(request.stdin, `${publicKey}\n`)
  const remoteCommand = request.args.at(-1) ?? ''
  assert.match(remoteCommand, /mkdir -p "\$HOME\/\.ssh"/)
  assert.match(remoteCommand, /chmod 700 "\$HOME\/\.ssh"/)
  assert.match(remoteCommand, /chmod 600 "\$HOME\/\.ssh\/authorized_keys"/)
  assert.match(remoteCommand, /grep -qxF/)
  assert.doesNotMatch(remoteCommand, /chmod\s+\d+\s+"\$HOME"(?:\s|$)/)
  assert.equal(remoteCommand.includes(publicKey), false)
})
test('key loading uses the platform agent contract without exposing its passphrase', async () => {
  const passphrase = 'agent-load-passphrase'
  const macRequests: SshBootstrapSecretCommandRequest[] = []
  assert.deepEqual(
    await loadSshBootstrapKey(
      {
        platform: 'darwin',
        privateKeyPath: '/home/alice/.ssh/phi_gpu-lab_ed25519',
        passphrase
      },
      {
        environment: {},
        askpassFiles: memoryAskpassFiles(),
        runCommand: async (request) => {
          macRequests.push(request)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
      }
    ),
    { status: 'ready' }
  )
  assert.deepEqual(macRequests[0].args, [
    '--apple-use-keychain',
    '/home/alice/.ssh/phi_gpu-lab_ed25519'
  ])
  assert.equal(macRequests[0].args.includes(passphrase), false)

  let linuxRuns = 0
  assert.deepEqual(
    await loadSshBootstrapKey(
      {
        platform: 'linux',
        privateKeyPath: '/home/alice/.ssh/phi_gpu-lab_ed25519',
        passphrase
      },
      {
        environment: {},
        askpassFiles: memoryAskpassFiles(),
        runCommand: async () => {
          linuxRuns += 1
          return { exitCode: 0, stdout: '', stderr: '' }
        }
      }
    ),
    { status: 'rejected', errorCode: 'linux_agent_missing' }
  )
  assert.equal(linuxRuns, 0)

  const linuxRequests: SshBootstrapSecretCommandRequest[] = []
  assert.deepEqual(
    await loadSshBootstrapKey(
      {
        platform: 'linux',
        privateKeyPath: '/home/alice/.ssh/phi_gpu-lab_ed25519',
        passphrase
      },
      {
        environment: { SSH_AUTH_SOCK: '/tmp/agent.sock' },
        askpassFiles: memoryAskpassFiles(),
        runCommand: async (request) => {
          linuxRequests.push(request)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
      }
    ),
    { status: 'ready' }
  )
  assert.deepEqual(linuxRequests[0].args, ['/home/alice/.ssh/phi_gpu-lab_ed25519'])
  assert.equal(linuxRequests[0].env?.SSH_AUTH_SOCK, '/tmp/agent.sock')
  assert.equal(linuxRequests[0].env?.PHI_SSH_ASKPASS_SECRET, undefined)
  assert.equal(linuxRequests[0].env?.PHI_SSH_ASKPASS_BYTES, String(Buffer.byteLength(passphrase)))
})
test('key verification refuses an unloaded key before BatchMode SSH and pins the new identity', async () => {
  const privateKeyPath = '/home/alice/.ssh/phi_gpu-lab_ed25519'
  let unloadedRuns = 0
  assert.deepEqual(
    await verifySshBootstrapKey(
      { target: TARGET, privateKeyPath, fingerprint: 'SHA256:new-key', requireAgent: true },
      {
        environment: { SSH_AUTH_SOCK: '/tmp/agent.sock' },
        authGate: {
          recordSshFailure: () => assert.fail('an unloaded key is not an authentication failure'),
          assertSshNotBlocked: () => undefined,
          clearSshBlock: () => undefined
        },
        runCommand: async () => {
          unloadedRuns += 1
          return {
            exitCode: 0,
            stdout: '256 SHA256:some-other-key unrelated (ED25519)\n',
            stderr: ''
          }
        }
      }
    ),
    { status: 'rejected', errorCode: 'key_not_loaded' }
  )
  assert.equal(unloadedRuns, 1)

  const requests: SshBootstrapSecretCommandRequest[] = []
  assert.deepEqual(
    await verifySshBootstrapKey(
      { target: TARGET, privateKeyPath, fingerprint: 'SHA256:new-key', requireAgent: true },
      {
        environment: { SSH_AUTH_SOCK: '/tmp/agent.sock' },
        authGate: {
          recordSshFailure: () => undefined,
          assertSshNotBlocked: () => undefined,
          clearSshBlock: () => undefined
        },
        runCommand: async (request) => {
          requests.push(request)
          return request.command === 'ssh-add'
            ? {
                exitCode: 0,
                stdout: '256 SHA256:new-key phi@workstation (ED25519)\n',
                stderr: ''
              }
            : { exitCode: 0, stdout: '', stderr: '' }
        }
      }
    ),
    { status: 'ready' }
  )
  assert.deepEqual(requests[0], {
    command: 'ssh-add',
    args: ['-l', '-E', 'sha256'],
    env: { SSH_AUTH_SOCK: '/tmp/agent.sock' }
  })
  assert.deepEqual(requests[1], {
    command: 'ssh',
    args: [
      '-F',
      '/dev/null',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-i',
      privateKeyPath,
      '-p',
      '22022',
      '-l',
      'scientist',
      'compute.example.invalid',
      'true'
    ]
  })
})
test('explicit passwordless key verification does not require an SSH agent', async () => {
  const requests: SshBootstrapSecretCommandRequest[] = []
  const result = await verifySshBootstrapKey(
    {
      target: TARGET,
      privateKeyPath: '/home/alice/.ssh/phi_gpu-lab_ed25519',
      fingerprint: 'SHA256:new-key',
      requireAgent: false
    },
    {
      environment: {},
      authGate: {
        recordSshFailure: () => undefined,
        assertSshNotBlocked: () => undefined,
        clearSshBlock: () => undefined
      },
      runCommand: async (request) => {
        requests.push(request)
        return { exitCode: 0, stdout: '', stderr: '' }
      }
    }
  )

  assert.deepEqual(result, { status: 'ready' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].command, 'ssh')
  assert.equal(requests[0].args.includes('BatchMode=yes'), true)
})
const hasSshKeygen = !spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error

test(
  'local ssh-keygen reads a generated passphrase through forced askpass',
  { skip: !hasSshKeygen },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-keygen-askpass-test-'))
    const secret = randomBytes(32).toString('hex')
    const sshDirectory = join(root, '.ssh')
    try {
      const result = await generateSshBootstrapKey(
        {
          alias: 'local-contract',
          protection: { kind: 'passphrase', passphrase: secret }
        },
        {
          sshDirectory,
          machineName: 'contract-test',
          date: '2026-10-09',
          files: createNodeSshBootstrapKeyFileSystem(),
          askpassFiles: createNodeSshAskpassFileSystem(root),
          runCommand: runSshBootstrapCommand
        }
      )
      assert.equal(result.status, 'ready')
      if (result.status !== 'ready') return

      const privateKey = await readFile(result.privateKeyPath, 'utf8')
      const publicKeyFile = await readFile(`${result.privateKeyPath}.pub`, 'utf8')
      assert.equal(privateKey.includes(secret), false)
      assert.equal(publicKeyFile.includes(secret), false)

      const unlocked = await withSshAskpass(
        secret,
        createNodeSshAskpassFileSystem(root),
        ({ env }) =>
          runSshBootstrapCommand({
            command: 'ssh-keygen',
            args: ['-y', '-f', result.privateKeyPath],
            env
          })
      )
      assert.equal(unlocked.exitCode, 0)
      assert.equal(
        unlocked.stdout.trim().split(/\s+/).slice(0, 2).join(' '),
        result.publicKey.split(/\s+/).slice(0, 2).join(' ')
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
test('the production runner bounds output, times out, and never returns its child environment', async () => {
  const secret = 'runner-environment-secret'
  const echoedSecret = await runSshBootstrapCommand({
    command: process.execPath,
    args: ['-e', "process.stderr.write(process.env.PHI_SSH_ASKPASS_SECRET ?? '')"],
    env: { PHI_SSH_ASKPASS_SECRET: secret }
  })
  assert.equal(echoedSecret.exitCode, 0)
  assert.equal(JSON.stringify(echoedSecret).includes(secret), false)

  const bounded = await runSshBootstrapCommand({
    command: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(256)); process.stderr.write('y'.repeat(256))"],
    env: { PHI_SSH_ASKPASS_SECRET: secret },
    maxOutputBytes: 32
  })
  assert.equal(bounded.exitCode, 0)
  assert.equal(Buffer.byteLength(bounded.stdout), 32)
  assert.equal(Buffer.byteLength(bounded.stderr), 32)
  assert.equal(JSON.stringify(bounded).includes(secret), false)

  const timedOut = await runSshBootstrapCommand({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => undefined, 10_000)'],
    env: { PHI_SSH_ASKPASS_SECRET: secret },
    timeoutMs: 10
  })
  assert.equal(timedOut.exitCode === 0, false)
  assert.equal(timedOut.stderr, '命令执行超时')
  assert.equal(JSON.stringify(timedOut).includes(secret), false)

  const missing = await runSshBootstrapCommand({
    command: `phi-command-that-does-not-exist-${Date.now()}`,
    args: [],
    env: { PHI_SSH_ASKPASS_SECRET: secret }
  })
  assert.deepEqual(missing, { exitCode: null, stdout: '', stderr: '无法启动命令' })
})
test('password authentication accepts a safe IPv6 hostname as one argv element', async () => {
  const requests: SshBootstrapSecretCommandRequest[] = []
  const authenticator = createSshPasswordAuthenticator({
    askpassFiles: memoryAskpassFiles(),
    authGate: {
      recordSshFailure: () => undefined,
      assertSshNotBlocked: () => undefined,
      clearSshBlock: () => undefined
    },
    runCommand: async (request) => {
      requests.push(request)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
  })

  assert.deepEqual(
    await authenticator.authenticate({ ...TARGET, hostname: '2001:db8::42' }, 'password'),
    { status: 'ready' }
  )
  assert.equal(requests[0].args.includes('2001:db8::42'), true)
})
