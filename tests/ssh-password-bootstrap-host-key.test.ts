import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'

import {
  runSshBootstrapPreflight,
  type SshBootstrapCommandRequest,
  type SshBootstrapCommandResult
} from '../src/main/agent/ssh-bootstrap/preflight'
import {
  createSshHostKeyTrustService,
  type SshHostKeyFileSystem
} from '../src/main/agent/ssh-bootstrap/host-key'

const TARGET = {
  alias: 'lab-hpc',
  hostname: 'compute.example.invalid',
  user: 'scientist',
  port: 22
}

test('preflight rejects OpenSSH versions older than 8.4 before inspecting the target', async () => {
  const calls: SshBootstrapCommandRequest[] = []
  const runCommand = async (
    request: SshBootstrapCommandRequest
  ): Promise<SshBootstrapCommandResult> => {
    calls.push(request)
    return { exitCode: 0, stdout: '', stderr: 'OpenSSH_8.3p1, LibreSSL 3.3.6' }
  }

  const result = await runSshBootstrapPreflight(TARGET, {
    platform: 'darwin',
    environment: {},
    runCommand
  })

  assert.deepEqual(result, { status: 'rejected', errorCode: 'openssh_too_old' })
  assert.deepEqual(calls, [{ command: 'ssh', args: ['-V'] }])
})

test('preflight accepts a validated IPv6 hostname without treating it as an SSH option', async () => {
  const calls: SshBootstrapCommandRequest[] = []
  const result = await runSshBootstrapPreflight(
    { ...TARGET, hostname: '2001:db8::10' },
    {
      platform: 'linux',
      environment: { SSH_AUTH_SOCK: '/tmp/agent.sock' },
      runCommand: async (request) => {
        calls.push(request)
        return request.args[0] === '-V'
          ? { exitCode: 0, stdout: '', stderr: 'OpenSSH_9.9p1' }
          : { exitCode: 0, stdout: 'proxyjump none\nproxycommand none\n', stderr: '' }
      }
    }
  )

  assert.equal(result.status, 'ready')
  assert.equal(calls.length, 2)
})

test('preflight rejects targets resolved through ProxyJump or ProxyCommand', async (context) => {
  for (const proxyConfig of [
    'proxyjump bastion.example.invalid',
    'proxycommand ssh gateway.example.invalid -W %h:%p'
  ]) {
    await context.test(proxyConfig.split(' ')[0], async () => {
      const runCommand = async (
        request: SshBootstrapCommandRequest
      ): Promise<SshBootstrapCommandResult> => {
        if (request.args[0] === '-V') {
          return { exitCode: 0, stdout: '', stderr: 'OpenSSH_9.9p1' }
        }
        return { exitCode: 0, stdout: `${proxyConfig}\n`, stderr: '' }
      }

      const result = await runSshBootstrapPreflight(TARGET, {
        platform: 'linux',
        environment: { SSH_AUTH_SOCK: '/tmp/agent.sock' },
        runCommand
      })

      assert.deepEqual(result, { status: 'rejected', errorCode: 'proxy_unsupported' })
    })
  }
})

test('a matching plain known_hosts entry is already trusted', async () => {
  const writes: string[] = []
  const files: SshHostKeyFileSystem = {
    readText: async () => 'compute.example.invalid ssh-ed25519 AAAA-server-key\n',
    ensureDirectory: async () => undefined,
    appendText: async (_path, content) => {
      writes.push(content)
    }
  }
  const runCommand = async (
    request: SshBootstrapCommandRequest
  ): Promise<SshBootstrapCommandResult> => {
    if (request.command === 'ssh-keyscan') {
      return {
        exitCode: 0,
        stdout: 'compute.example.invalid ssh-ed25519 AAAA-server-key\n',
        stderr: ''
      }
    }
    assert.equal(request.command, 'ssh-keygen')
    return {
      exitCode: 0,
      stdout: '256 SHA256:server-fingerprint compute.example.invalid (ED25519)\n',
      stderr: ''
    }
  }
  const service = createSshHostKeyTrustService({
    runCommand,
    files,
    knownHostsPath: '/home/test/.ssh/known_hosts',
    createId: () => 'confirmation-1'
  })

  assert.deepEqual(await service.inspectTarget(TARGET), {
    status: 'ready',
    fingerprints: [{ algorithm: 'ssh-ed25519', sha256: 'SHA256:server-fingerprint' }]
  })
  assert.deepEqual(writes, [])
})

test('a matching hashed known_hosts entry is already trusted', async () => {
  const salt = Buffer.from('host-hash-salt')
  const digest = createHmac('sha1', salt).update(TARGET.hostname).digest()
  const hashedHost = `|1|${salt.toString('base64')}|${digest.toString('base64')}`
  const files: SshHostKeyFileSystem = {
    readText: async () => `${hashedHost} ssh-ed25519 AAAA-server-key\n`,
    ensureDirectory: async () => undefined,
    appendText: async () => assert.fail('trusted host key must not be written again')
  }
  const runCommand = async (
    request: SshBootstrapCommandRequest
  ): Promise<SshBootstrapCommandResult> =>
    request.command === 'ssh-keyscan'
      ? {
          exitCode: 0,
          stdout: 'compute.example.invalid ssh-ed25519 AAAA-server-key\n',
          stderr: ''
        }
      : {
          exitCode: 0,
          stdout: '256 SHA256:server-fingerprint host (ED25519)\n',
          stderr: ''
        }
  const service = createSshHostKeyTrustService({
    runCommand,
    files,
    knownHostsPath: '/home/test/.ssh/known_hosts',
    createId: () => 'confirmation-1'
  })

  assert.equal((await service.inspectTarget(TARGET)).status, 'ready')
})

test('a changed known_hosts key is rejected without writing', async () => {
  const writes: string[] = []
  const files: SshHostKeyFileSystem = {
    readText: async () => 'compute.example.invalid ssh-ed25519 AAAA-old-key\n',
    ensureDirectory: async () => undefined,
    appendText: async (_path, content) => {
      writes.push(content)
    }
  }
  const runCommand = async (
    request: SshBootstrapCommandRequest
  ): Promise<SshBootstrapCommandResult> =>
    request.command === 'ssh-keyscan'
      ? {
          exitCode: 0,
          stdout: 'compute.example.invalid ssh-ed25519 AAAA-new-key\n',
          stderr: ''
        }
      : {
          exitCode: 0,
          stdout: '256 SHA256:new-fingerprint host (ED25519)\n',
          stderr: ''
        }
  const service = createSshHostKeyTrustService({
    runCommand,
    files,
    knownHostsPath: '/home/test/.ssh/known_hosts',
    createId: () => 'confirmation-1'
  })

  assert.deepEqual(await service.inspectTarget(TARGET), {
    status: 'rejected',
    errorCode: 'host_key_changed'
  })
  assert.deepEqual(writes, [])
})

test('an untrusted scan exposes fingerprints and writes keys only after explicit confirmation', async () => {
  const fileEvents: Array<{ operation: string; path: string; content?: string; mode: number }> = []
  const files: SshHostKeyFileSystem = {
    readText: async () => null,
    ensureDirectory: async (path, mode) => {
      fileEvents.push({ operation: 'mkdir', path, mode })
    },
    appendText: async (path, content, mode) => {
      fileEvents.push({ operation: 'append', path, content, mode })
    }
  }
  const scan = [
    '[compute.example.invalid]:22022 ssh-ed25519 AAAA-ed25519',
    '[compute.example.invalid]:22022 ecdsa-sha2-nistp256 AAAA-ecdsa',
    '[compute.example.invalid]:22022 ssh-rsa AAAA-rsa',
    ''
  ].join('\n')
  const fingerprintOutput = [
    '256 SHA256:ed25519-fingerprint host (ED25519)',
    '256 SHA256:ecdsa-fingerprint host (ECDSA)',
    '3072 SHA256:rsa-fingerprint host (RSA)',
    ''
  ].join('\n')
  const runCommand = async (
    request: SshBootstrapCommandRequest
  ): Promise<SshBootstrapCommandResult> =>
    request.command === 'ssh-keyscan'
      ? { exitCode: 0, stdout: scan, stderr: '' }
      : { exitCode: 0, stdout: fingerprintOutput, stderr: '' }
  const service = createSshHostKeyTrustService({
    runCommand,
    files,
    knownHostsPath: '/home/test/.ssh/known_hosts',
    createId: () => 'confirmation-1'
  })
  const target = { ...TARGET, port: 22022 }

  assert.deepEqual(await service.inspectTarget(target), {
    status: 'confirmation-required',
    confirmationId: 'confirmation-1',
    fingerprints: [
      { algorithm: 'ssh-ed25519', sha256: 'SHA256:ed25519-fingerprint' },
      { algorithm: 'ecdsa-sha2-nistp256', sha256: 'SHA256:ecdsa-fingerprint' },
      { algorithm: 'ssh-rsa', sha256: 'SHA256:rsa-fingerprint' }
    ]
  })
  assert.deepEqual(fileEvents, [])

  assert.deepEqual(await service.confirmHostKey('confirmation-1'), {
    status: 'ready',
    fingerprints: [
      { algorithm: 'ssh-ed25519', sha256: 'SHA256:ed25519-fingerprint' },
      { algorithm: 'ecdsa-sha2-nistp256', sha256: 'SHA256:ecdsa-fingerprint' },
      { algorithm: 'ssh-rsa', sha256: 'SHA256:rsa-fingerprint' }
    ]
  })
  assert.deepEqual(fileEvents, [
    { operation: 'mkdir', path: '/home/test/.ssh', mode: 0o700 },
    {
      operation: 'append',
      path: '/home/test/.ssh/known_hosts',
      mode: 0o600,
      content: [
        '[compute.example.invalid]:22022 ssh-ed25519 AAAA-ed25519',
        '[compute.example.invalid]:22022 ecdsa-sha2-nistp256 AAAA-ecdsa',
        '[compute.example.invalid]:22022 ssh-rsa AAAA-rsa',
        ''
      ].join('\n')
    }
  ])
})

test('preflight and host-key inspection never weaken OpenSSH host verification', async () => {
  const calls: SshBootstrapCommandRequest[] = []
  const runCommand = async (
    request: SshBootstrapCommandRequest
  ): Promise<SshBootstrapCommandResult> => {
    calls.push(request)
    if (request.command === 'ssh' && request.args[0] === '-V') {
      return { exitCode: 0, stdout: '', stderr: 'OpenSSH_9.9p1' }
    }
    if (request.command === 'ssh') {
      return {
        exitCode: 0,
        stdout: 'proxyjump none\nproxycommand none\n',
        stderr: ''
      }
    }
    if (request.command === 'ssh-keyscan') {
      return {
        exitCode: 0,
        stdout: 'compute.example.invalid ssh-ed25519 AAAA-server-key\n',
        stderr: ''
      }
    }
    return {
      exitCode: 0,
      stdout: '256 SHA256:server-fingerprint host (ED25519)\n',
      stderr: ''
    }
  }
  const files: SshHostKeyFileSystem = {
    readText: async () => null,
    ensureDirectory: async () => undefined,
    appendText: async () => undefined
  }

  assert.equal(
    (
      await runSshBootstrapPreflight(TARGET, {
        platform: 'darwin',
        environment: {},
        runCommand
      })
    ).status,
    'ready'
  )
  const service = createSshHostKeyTrustService({
    runCommand,
    files,
    knownHostsPath: '/home/test/.ssh/known_hosts',
    createId: () => 'confirmation-1'
  })
  assert.equal((await service.inspectTarget(TARGET)).status, 'confirmation-required')

  const commandLines = calls.map((call) => call.args.join(' ')).join('\n')
  assert.doesNotMatch(commandLines, /StrictHostKeyChecking=(?:no|accept-new)/i)
  assert.doesNotMatch(commandLines, /UserKnownHostsFile=\/dev\/null/i)
  assert.doesNotMatch(commandLines, /accept-new/i)
})
