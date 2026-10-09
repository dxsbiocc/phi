import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import type {
  RemoteExecResult,
  RemoteSshSession,
  RemoteStdioProcess
} from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession, installSetsidShim } from './helpers/localShellSession'

function profile(): ReturnType<typeof parseHostCapabilityProbe> {
  return parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Linux
platform.arch=x86_64
storage.home_writable=1
storage.home_executable=1
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)
}

function disconnectingProcess(): { process: RemoteStdioProcess; closeCalls: () => number } {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let closes = 0
  let resolveClosed: (result: { code: number | null; signal: string | null }) => void = () => {
    throw new Error('closed promise is not initialized')
  }
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveClosed = resolve
  })
  stdin.once('data', () => {
    stdout.end()
    resolveClosed({ code: 255, signal: null })
  })
  return {
    closeCalls: () => closes,
    process: {
      stdin,
      stdout,
      stderr,
      closed,
      async close() {
        closes += 1
        stdin.end()
        stdout.end()
        stderr.end()
        resolveClosed({ code: 0, signal: null })
      }
    }
  }
}

function installerSession(
  hash: string,
  process: RemoteStdioProcess,
  remoteHome: string
): RemoteSshSession & { closed: boolean } {
  const session = {
    closed: false,
    async exec(command: string): Promise<RemoteExecResult> {
      if (command.includes('__PHI_HELPER_HOME__')) {
        return { stdout: `__PHI_HELPER_HOME__${remoteHome}\n`, stderr: '', code: 0, signal: null }
      }
      if (command.startsWith('sha256sum ')) {
        return { stdout: `${hash}  uploaded\n`, stderr: '', code: 0, signal: null }
      }
      if (command.includes('--selftest')) {
        return { stdout: '{"ok":true}\n', stderr: '', code: 0, signal: null }
      }
      return { stdout: '', stderr: '', code: 0, signal: null }
    },
    async readTextFile() {
      throw new Error('not used')
    },
    async writeTextFile() {
      throw new Error('not used')
    },
    async mkdirp() {
      return undefined
    },
    async exists() {
      return false
    },
    async uploadFile() {
      return undefined
    },
    async openStdio() {
      return process
    },
    async close() {
      session.closed = true
      await process.close()
    }
  }
  return session
}

test('helper disconnect rejects the unknown request and only later calls use pure SSH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-helper-disconnect-'))
  const artifactPath = join(root, 'helper-artifact')
  await writeFile(artifactPath, 'helper')
  const hash = createHash('sha256').update('helper').digest('hex')
  const fixture = disconnectingProcess()
  const installation = installerSession(hash, fixture.process, join(root, '.home'))
  const pureSessions: ReturnType<typeof createLocalShellSession>[] = []
  const shimDirectory = join(root, '.shim')
  await mkdir(shimDirectory)
  const restoreSetsid = installSetsidShim(shimDirectory)
  let connections = 0
  try {
    const canonicalRoot = await realpath(root)
    const host = new SshHost({
      remoteRoot: root,
      canonicalRoot,
      connect: async () => {
        connections += 1
        if (connections === 1) return installation
        const session = createLocalShellSession(canonicalRoot)
        pureSessions.push(session)
        return session
      },
      helper: {
        profile: profile(),
        profileKey: { hostAlias: 'cluster', projectRoot: canonicalRoot },
        artifact: { version: '0.1.0', localPath: artifactPath, sha256: hash },
        agentDir: join(root, '.agent')
      }
    })

    await assert.rejects(
      host.exec.run(['bash', '-c', 'printf first'], { cwd: '.' }),
      /remote helper exited/
    )
    assert.equal(pureSessions.length, 0, 'an unknown helper command must not be replayed')
    const fallback = await host.exec.run(['bash', '-c', 'printf fallback'], { cwd: '.' })
    assert.equal(fallback.stdout, 'fallback')
    assert.equal(host.capabilities().helperStatus?.state, 'degraded')
    assert.equal(host.capabilities().exec.state, 'degraded')
    await host.close()
    assert.equal(installation.closed, true)
    assert.ok(fixture.closeCalls() >= 1)
  } finally {
    restoreSetsid()
    await rm(root, { recursive: true, force: true })
  }
})

test('closing a local SSH session terminates its open stdio child', async () => {
  const session = createLocalShellSession()
  assert.ok(session.openStdio)
  const channel = await session.openStdio(
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(() => {}, 1000)')}`
  )
  await session.close()
  const result = await Promise.race([
    channel.closed,
    delay(2_000).then(() => {
      throw new Error('stdio child survived SSH session close')
    })
  ])

  assert.ok(result.signal || result.code !== null)
})
