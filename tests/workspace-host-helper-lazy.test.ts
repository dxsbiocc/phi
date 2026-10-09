import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import type { RemoteHelperArtifact } from '../src/main/agent/workspace-host/helper-installer'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'

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

const missingArtifact: RemoteHelperArtifact = {
  version: '0.1.0',
  localPath: '',
  sha256: '0'.repeat(64)
}

test('helper preparation is lazy, shared by first operations, and closes the acquired session on failure', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-helper-lazy-'))
  let preparations = 0
  let connections = 0
  let closes = 0
  let finish!: (artifact: RemoteHelperArtifact) => void
  const prepared = new Promise<RemoteHelperArtifact>((resolve) => {
    finish = resolve
  })
  const unused = async (): Promise<never> => {
    throw new Error('unexpected remote operation')
  }
  const session: RemoteSshSession = {
    exec: unused,
    readTextFile: unused,
    writeTextFile: unused,
    mkdirp: unused,
    exists: unused,
    uploadFile: unused,
    close: async () => {
      closes += 1
    }
  }
  const host = new SshHost({
    remoteRoot: '/project',
    canonicalRoot: '/project',
    connect: async () => {
      connections += 1
      if (connections > 1) throw new Error('pure SSH fallback selected')
      return session
    },
    helper: {
      profile: profile(),
      profileKey: { hostAlias: 'lazy', projectRoot: '/project' },
      artifact: missingArtifact,
      agentDir,
      prepareArtifact: async () => {
        preparations += 1
        return prepared
      }
    }
  })
  try {
    assert.equal(preparations, 0)
    assert.equal(connections, 0)
    const first = assert.rejects(host.fs.list('.'), /pure SSH fallback selected/)
    const second = assert.rejects(host.fs.list('.'), /pure SSH fallback selected/)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(preparations, 1)
    assert.equal(connections, 1)
    assert.equal(closes, 0)
    finish(missingArtifact)
    await Promise.all([first, second])
    assert.equal(closes, 1)
    assert.equal(host.capabilities().helperStatus?.state, 'degraded')
  } finally {
    finish(missingArtifact)
    await host.close()
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('a prepared artifact replaces missing metadata before the verified remote installation', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-helper-prepared-install-'))
  const localPath = join(agentDir, 'helper')
  writeFileSync(localPath, 'prepared helper')
  const sha256 = createHash('sha256').update('prepared helper').digest('hex')
  const uploads: string[] = []
  const commands: string[] = []
  let connections = 0
  let preparations = 0
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let finish!: (result: { code: number | null; signal: string | null }) => void
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    finish = resolve
  })
  stdin.on('data', (bytes: Buffer) => {
    const request = JSON.parse(bytes.subarray(4).toString('utf8')) as { id: number; method: string }
    assert.equal(request.method, 'fs.list')
    const payload = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { entries: [] } })
    )
    const header = Buffer.alloc(4)
    header.writeUInt32BE(payload.length)
    stdout.write(Buffer.concat([header, payload]))
  })
  const unused = async (): Promise<never> => {
    throw new Error('not used')
  }
  const session: RemoteSshSession = {
    async exec(command) {
      commands.push(command)
      const stdout = command.includes('__PHI_HELPER_HOME__')
        ? '__PHI_HELPER_HOME__/home/test\n'
        : command.startsWith('sha256sum ')
          ? `${sha256}  helper\n`
          : command.includes('--selftest')
            ? '{"ok":true}\n'
            : ''
      return { stdout, stderr: '', code: 0, signal: null }
    },
    readTextFile: unused,
    writeTextFile: unused,
    mkdirp: unused,
    exists: unused,
    uploadFile: async (path) => {
      uploads.push(path)
    },
    openStdio: async () => ({
      stdin,
      stdout,
      stderr,
      closed,
      close: async () => {
        stdin.end()
        stdout.end()
        stderr.end()
        finish({ code: 0, signal: null })
      }
    }),
    close: async () => undefined
  }
  const host = new SshHost({
    remoteRoot: '/project',
    canonicalRoot: '/project',
    connect: async () => {
      if (++connections > 1) throw new Error('pure SSH fallback selected')
      return session
    },
    helper: {
      profile: profile(),
      profileKey: { hostAlias: 'prepared', projectRoot: '/project' },
      artifact: missingArtifact,
      agentDir,
      prepareArtifact: async () => {
        preparations += 1
        return { version: '0.1.0', localPath, sha256 }
      }
    }
  })
  try {
    assert.deepEqual(await host.fs.list('.'), { entries: [] })
    assert.deepEqual(await host.fs.list('.'), { entries: [] })
    assert.equal(preparations, 1)
    assert.equal(connections, 1)
    assert.deepEqual(uploads, [localPath])
    assert.ok(commands.some((command) => command.includes('--selftest')))
    assert.equal(host.capabilities().helperStatus?.state, 'available')
  } finally {
    await host.close()
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('closing a host during preparation cancels the compiler, closes SSH, and prevents upload or fallback operations', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-helper-preparation-close-'))
  let connections = 0
  let closes = 0
  let cancelled = false
  const unused = async (): Promise<never> => {
    throw new Error('must not touch remote files')
  }
  const session: RemoteSshSession = {
    exec: unused,
    readTextFile: unused,
    writeTextFile: unused,
    mkdirp: unused,
    exists: unused,
    uploadFile: unused,
    close: async () => {
      closes += 1
    }
  }
  const host = new SshHost({
    remoteRoot: '/project',
    canonicalRoot: '/project',
    connect: async () => {
      connections += 1
      return session
    },
    helper: {
      profile: profile(),
      profileKey: { hostAlias: 'closing', projectRoot: '/project' },
      artifact: missingArtifact,
      agentDir,
      prepareArtifact: async (signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener(
            'abort',
            () => {
              cancelled = true
              reject(new Error('compiler cancelled'))
            },
            { once: true }
          )
        })
    }
  })
  try {
    const operation = assert.rejects(host.fs.list('.'), /host is closed/)
    await new Promise<void>((resolve) => setImmediate(resolve))
    await host.close()
    await operation
    assert.equal(cancelled, true)
    assert.equal(closes, 1)
    assert.equal(connections, 1)
    await assert.rejects(host.fs.list('.'), /host is closed/)
    assert.equal(connections, 1)
  } finally {
    await host.close()
    rmSync(agentDir, { recursive: true, force: true })
  }
})
