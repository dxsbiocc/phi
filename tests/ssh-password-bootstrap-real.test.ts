import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDefaultSshBootstrapCoordinator } from '../src/main/agent/ssh-bootstrap/default-coordinator'
import { runSshBootstrapCommand } from '../src/main/agent/ssh-bootstrap/runtime'

const sshdBinary = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((path) => existsSync(path))

function available(binary: string): boolean {
  return spawnSync(binary, ['-V'], { stdio: 'ignore' }).error === undefined
}

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
    if (child.exitCode !== null) throw new Error(`Local sshd exited: ${errorText()}`)
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

function createUnencryptedTestKey(path: string): void {
  const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path], {
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
}

test(
  'real password-only sshd bootstraps one protected key and verifies a fresh key login',
  { skip: !sshdBinary || !available('ssh') || !available('ssh-keygen') },
  async (context) => {
    let port: number
    try {
      port = await unusedLocalPort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip('sandbox forbids listening on 127.0.0.1')
        return
      }
      throw error
    }

    const password = process.env.PHI_SSH_BOOTSTRAP_E2E_PASSWORD
    if (!password) {
      context.skip('set PHI_SSH_BOOTSTRAP_E2E_PASSWORD to the current test user password')
      return
    }

    const root = mkdtempSync(join(tmpdir(), 'phi-ssh-bootstrap-real-'))
    chmodSync(root, 0o700)
    let server: ChildProcessWithoutNullStreams | undefined
    let agentEnvironment: Record<string, string> | undefined
    try {
      const hostKey = join(root, 'host-key')
      createUnencryptedTestKey(hostKey)
      const authorizedKeys = join(root, 'authorized_keys')
      writeFileSync(authorizedKeys, '', { mode: 0o600 })
      const serverConfig = join(root, 'sshd_config')
      writeFileSync(
        serverConfig,
        [
          `Port ${port}`,
          'ListenAddress 127.0.0.1',
          `HostKey ${hostKey}`,
          `AuthorizedKeysFile ${authorizedKeys}`,
          `PidFile ${join(root, 'sshd.pid')}`,
          'PasswordAuthentication yes',
          'KbdInteractiveAuthentication no',
          'PubkeyAuthentication yes',
          'StrictModes no',
          'UsePAM no',
          'LogLevel ERROR',
          ''
        ].join('\n')
      )
      const configCheck = spawnSync(sshdBinary, ['-t', '-f', serverConfig], { encoding: 'utf8' })
      assert.equal(configCheck.status, 0, configCheck.stderr)
      server = spawn(sshdBinary, ['-D', '-e', '-f', serverConfig], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let serverError = ''
      server.stderr.on('data', (chunk: Buffer) => {
        serverError += chunk.toString('utf8')
      })
      await waitForSshd(port, server, () => serverError)

      const agent = spawnSync('ssh-agent', ['-s'], { encoding: 'utf8' })
      assert.equal(agent.status, 0, agent.stderr)
      const socket = /SSH_AUTH_SOCK=([^;]+);/.exec(agent.stdout)?.[1]
      const pid = /SSH_AGENT_PID=([^;]+);/.exec(agent.stdout)?.[1]
      assert.ok(socket && pid)
      agentEnvironment = { SSH_AUTH_SOCK: socket, SSH_AGENT_PID: pid }

      const homeDirectory = join(root, 'home')
      const knownHostsPath = join(homeDirectory, '.ssh', 'known_hosts')
      const runCommand: typeof runSshBootstrapCommand = (request) =>
        runSshBootstrapCommand({
          ...request,
          args:
            request.command === 'ssh'
              ? ['-o', `UserKnownHostsFile=${knownHostsPath}`, ...request.args]
              : request.args
        })
      const coordinator = createDefaultSshBootstrapCoordinator({
        homeDirectory,
        platform: 'linux',
        environment: { ...process.env, ...agentEnvironment },
        machineName: 'real-test',
        tempRoot: root,
        runCommand
      })
      const target = {
        alias: 'phi-real-bootstrap',
        hostname: '127.0.0.1',
        user: userInfo().username,
        port
      }
      const inspected = await coordinator.inspectTarget(target)
      assert.equal(inspected.status, 'confirmation-required')
      if (inspected.status !== 'confirmation-required') return
      assert.equal((await coordinator.confirmHostKey(inspected.attemptId)).status, 'ready')
      const prepared = await coordinator.completeWithCredentials(inspected.attemptId, {
        password,
        keyProtection: 'passphrase',
        passphrase: randomBytes(24).toString('hex')
      })
      assert.equal(prepared.status, 'config-preview')
      if (prepared.status !== 'config-preview') return
      assert.equal((await coordinator.saveConfig(prepared.operationId)).configured, true)

      const privateKeyPath = join(homeDirectory, '.ssh', 'phi_phi-real-bootstrap_ed25519')
      const verified = await runCommand({
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
          String(port),
          '-l',
          userInfo().username,
          '127.0.0.1',
          'true'
        ],
        env: agentEnvironment
      })
      assert.equal(verified.exitCode, 0, verified.stderr)
    } finally {
      server?.kill('SIGTERM')
      if (agentEnvironment) {
        spawnSync('ssh-agent', ['-k'], { env: { ...process.env, ...agentEnvironment } })
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
)
