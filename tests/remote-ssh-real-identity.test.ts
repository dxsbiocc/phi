import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RemoteSshConnectionError } from '../src/main/agent/wrappers/remote-ssh-diagnostics'
import {
  connectRemoteSshSession,
  type OpenSshRuntime
} from '../src/main/agent/wrappers/remote-ssh-session'

function available(binary: string): boolean {
  return spawnSync(binary, ['-V'], { stdio: 'ignore' }).error === undefined
}

const sshdBinary = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((path) => existsSync(path))

async function unusedLocalPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

async function waitForSshd(
  port: number,
  child: ChildProcessWithoutNullStreams,
  errorText: () => string
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Local sshd exited before listening: ${errorText()}`)
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Local sshd did not start')
}

function createKey(path: string): void {
  const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path], {
    encoding: 'utf-8'
  })
  assert.equal(result.status, 0, result.stderr)
}

test(
  'real OpenSSH accepts a trusted host key and rejects unknown or changed keys',
  {
    skip: !available('ssh') || !sshdBinary || !available('ssh-keygen')
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phi-ssh-identity-'))
    chmodSync(dir, 0o700)
    let server: ChildProcessWithoutNullStreams | undefined
    try {
      const port = await unusedLocalPort()
      const hostKey = join(dir, 'host-key')
      const changedKey = join(dir, 'changed-key')
      const clientKey = join(dir, 'client-key')
      createKey(hostKey)
      createKey(changedKey)
      createKey(clientKey)
      const authorizedKeys = join(dir, 'authorized_keys')
      writeFileSync(authorizedKeys, readFileSync(`${clientKey}.pub`))
      chmodSync(authorizedKeys, 0o600)
      const serverConfig = join(dir, 'sshd_config')
      writeFileSync(
        serverConfig,
        [
          `Port ${port}`,
          'ListenAddress 127.0.0.1',
          `HostKey ${hostKey}`,
          `AuthorizedKeysFile ${authorizedKeys}`,
          `PidFile ${join(dir, 'sshd.pid')}`,
          'PasswordAuthentication no',
          'KbdInteractiveAuthentication no',
          'PubkeyAuthentication yes',
          'StrictModes no',
          'UsePAM no',
          'LogLevel ERROR',
          ''
        ].join('\n')
      )
      const configCheck = spawnSync(sshdBinary, ['-t', '-f', serverConfig], { encoding: 'utf-8' })
      assert.equal(configCheck.status, 0, configCheck.stderr)
      server = spawn(sshdBinary, ['-D', '-e', '-f', serverConfig], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let serverError = ''
      server.stderr.on('data', (chunk: Buffer) => {
        serverError += chunk.toString('utf-8')
      })
      await waitForSshd(port, server, () => serverError)

      const knownHosts = join(dir, 'known_hosts')
      const clientConfig = join(dir, 'ssh_config')
      writeFileSync(
        clientConfig,
        [
          'Host phi-a01-test',
          '  HostName 127.0.0.1',
          `  Port ${port}`,
          `  User ${userInfo().username}`,
          `  IdentityFile ${clientKey}`,
          '  IdentitiesOnly yes',
          `  UserKnownHostsFile ${knownHosts}`,
          '  GlobalKnownHostsFile /dev/null',
          ''
        ].join('\n')
      )
      const runtime: OpenSshRuntime = {
        spawnImpl: (binary, args, options) => spawn(binary, ['-F', clientConfig, ...args], options)
      }
      const knownHostPrefix = `[127.0.0.1]:${port} `
      writeFileSync(knownHosts, `${knownHostPrefix}${readFileSync(`${hostKey}.pub`, 'utf-8')}`)

      const session = await connectRemoteSshSession({ host: 'phi-a01-test' }, runtime)
      try {
        const result = await session.exec('printf trusted')
        assert.equal(result.code, 0)
        assert.equal(result.stdout, 'trusted')
      } finally {
        await session.close()
      }

      writeFileSync(knownHosts, '')
      await assert.rejects(
        () => connectRemoteSshSession({ host: 'phi-a01-test', userInitiated: true }, runtime),
        (error: unknown) =>
          error instanceof RemoteSshConnectionError && error.code === 'host_key_unknown'
      )

      writeFileSync(knownHosts, `${knownHostPrefix}${readFileSync(`${changedKey}.pub`, 'utf-8')}`)
      await assert.rejects(
        () => connectRemoteSshSession({ host: 'phi-a01-test', userInitiated: true }, runtime),
        (error: unknown) =>
          error instanceof RemoteSshConnectionError && error.code === 'host_key_changed'
      )
    } finally {
      server?.kill('SIGTERM')
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
