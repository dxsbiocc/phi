import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { readCapabilityProfile } from '../src/main/agent/workspace-host/capability-profile-store'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import type {
  RemoteExecResult,
  RemoteSshSession,
  RemoteStdioProcess
} from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession } from './helpers/localShellSession'

const PROBE_OUTPUT = `
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Linux
platform.arch=x86_64
libc.name=glibc
libc.version=2.17
storage.home_writable=1
storage.home_executable=1
storage.available_kib=1024
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`

interface BootstrapCounters {
  connections: number
  probeSessions: number
  uploads: number
  closes: number
}

interface FailureResult {
  entries: unknown[]
  probeSessions: number
  uploads: number
  probeState: string | undefined
  helperState: string | undefined
  helperReason: string | undefined
}

interface FailureCounters {
  connections: number
  probeSessions: number
  uploads: number
}

function listProcess(): RemoteStdioProcess {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let buffer = Buffer.alloc(0)
  let finish!: (result: { code: number | null; signal: string | null }) => void
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    finish = resolve
  })
  stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
      const length = buffer.readUInt32BE(0)
      const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as { id: number }
      buffer = buffer.subarray(length + 4)
      const payload = Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { entries: [] } })
      )
      const header = Buffer.alloc(4)
      header.writeUInt32BE(payload.length)
      stdout.write(Buffer.concat([header, payload]))
    }
  })
  return {
    stdin,
    stdout,
    stderr,
    closed,
    async close() {
      stdin.end()
      stdout.end()
      stderr.end()
      finish({ code: 0, signal: null })
    }
  }
}

function helperSession(
  hash: string,
  probeGate: Promise<void>,
  counters: BootstrapCounters
): RemoteSshSession {
  const process = listProcess()
  let probed = false
  const unused = async (): Promise<never> => {
    throw new Error('not used')
  }
  return {
    async exec(command): Promise<RemoteExecResult> {
      const stdout = command.includes('__PHI_HELPER_HOME__')
        ? '__PHI_HELPER_HOME__/home/test\n'
        : command.startsWith('sha256sum ')
          ? `${hash}  helper\n`
          : command.includes('--selftest')
            ? '{"ok":true}\n'
            : ''
      return { stdout, stderr: '', code: 0, signal: null }
    },
    async execWithInput() {
      if (!probed) counters.probeSessions += 1
      probed = true
      await probeGate
      return { stdout: PROBE_OUTPUT, stderr: '', code: 0, signal: null }
    },
    readTextFile: unused,
    writeTextFile: unused,
    mkdirp: unused,
    exists: unused,
    async uploadFile() {
      counters.uploads += 1
    },
    async openStdio() {
      return process
    },
    async close() {
      counters.closes += 1
    }
  }
}

async function helperResources(root: string): Promise<{ resourceRoot: string; hash: string }> {
  const resourceRoot = join(root, 'resources')
  const artifactDirectory = join(resourceRoot, '0.1.0', 'linux-amd64')
  const artifact = join(artifactDirectory, 'phi-helper')
  const bytes = 'fake helper'
  const hash = createHash('sha256').update(bytes).digest('hex')
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(artifact, bytes)
  await writeFile(
    join(resourceRoot, 'manifest.json'),
    `${JSON.stringify({
      version: '0.1.0',
      platforms: { 'linux-amd64': { path: '0.1.0/linux-amd64/phi-helper', sha256: hash } }
    })}\n`
  )
  return { resourceRoot, hash }
}

function failureSession(
  root: string,
  canonicalRoot: string,
  failure: 'probe' | 'upload',
  counters: FailureCounters
): ReturnType<typeof createLocalShellSession> {
  const session = createLocalShellSession(canonicalRoot)
  const bootstrap = counters.connections++ === 0
  let probed = false
  const execute = session.exec.bind(session)
  session.exec = (command) =>
    command.includes('__PHI_HELPER_HOME__')
      ? Promise.resolve({
          stdout: `__PHI_HELPER_HOME__${join(root, 'remote-home')}\n`,
          stderr: '',
          code: 0,
          signal: null
        })
      : execute(command)
  session.execWithInput = async () => {
    if (!probed) counters.probeSessions += 1
    probed = true
    if (bootstrap && failure === 'probe') throw new Error('simulated probe failure')
    return { stdout: PROBE_OUTPUT, stderr: '', code: 0, signal: null }
  }
  if (bootstrap && failure === 'upload') {
    session.uploadFile = async () => {
      counters.uploads += 1
      throw new Error('simulated upload failure')
    }
  }
  return session
}

async function firstOperationWithFailure(failure: 'probe' | 'upload'): Promise<FailureResult> {
  const root = await mkdtemp(join(tmpdir(), `phi-helper-${failure}-failure-`))
  const workspace = join(root, 'workspace')
  const agentDir = join(root, 'agent')
  const { resourceRoot } = await helperResources(root)
  const counters: FailureCounters = { connections: 0, probeSessions: 0, uploads: 0 }
  await mkdir(workspace)
  const canonicalRoot = await realpath(workspace)
  const host = new SshHost({
    remoteRoot: workspace,
    canonicalRoot,
    connect: async () => failureSession(root, canonicalRoot, failure, counters),
    helperBootstrap: {
      profileKey: { hostAlias: `${failure}-failure`, projectRoot: workspace },
      agentDir,
      resourceRoot,
      developmentRoot: join(root, 'missing-development-root')
    }
  })
  try {
    const result = await host.fs.list('.')
    const profile = host.capabilities()
    return {
      entries: [...result.entries],
      probeSessions: counters.probeSessions,
      uploads: counters.uploads,
      probeState: profile.probe?.state,
      helperState: profile.helperStatus?.state,
      helperReason: profile.helperStatus?.reason
    }
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('an uncached first operation probes and persists before falling back to pure SSH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-helper-bootstrap-'))
  const workspace = join(root, 'workspace')
  const agentDir = join(root, '.agent')
  const profileKey = { hostAlias: 'cold-host', projectRoot: workspace }
  const sessions: ReturnType<typeof createLocalShellSession>[] = []
  let probeSessions = 0
  try {
    await mkdir(workspace)
    const canonicalRoot = await realpath(workspace)
    const host = new SshHost({
      remoteRoot: workspace,
      canonicalRoot,
      connect: async () => {
        const session = createLocalShellSession(canonicalRoot)
        let probed = false
        session.execWithInput = async () => {
          if (!probed) probeSessions += 1
          probed = true
          return { stdout: PROBE_OUTPUT, stderr: '', code: 0, signal: null }
        }
        sessions.push(session)
        return session
      },
      helperBootstrap: {
        profileKey,
        agentDir,
        resourceRoot: join(root, 'missing-helper-resources'),
        developmentRoot: join(root, 'missing-development-root')
      }
    })

    const result = await host.fs.list('.')

    assert.deepEqual(result, { entries: [] })
    assert.equal(probeSessions, 1)
    assert.equal(readCapabilityProfile(profileKey, { agentDir })?.platform.os, 'linux')
    assert.equal(sessions[0]?.closed, true, 'the probe-only session must be closed')
    assert.equal(host.capabilities().helperCompatibility?.state, 'degraded')
    assert.match(host.capabilities().helperCompatibility?.reason ?? '', /artifact.*unavailable/i)
    assert.match(
      readCapabilityProfile(profileKey, { agentDir })?.helperCompatibility.reason ?? '',
      /artifact.*unavailable/i
    )
    await host.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent first operations share one probe and helper installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-helper-bootstrap-shared-'))
  const profileKey = { hostAlias: 'cold-helper-host', projectRoot: '/project' }
  const counters: BootstrapCounters = { connections: 0, probeSessions: 0, uploads: 0, closes: 0 }
  let releaseProbe!: () => void
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve
  })
  const { resourceRoot, hash } = await helperResources(root)
  const host = new SshHost({
    remoteRoot: '/project',
    canonicalRoot: '/project',
    connect: async () => {
      counters.connections += 1
      return helperSession(hash, probeGate, counters)
    },
    helperBootstrap: {
      profileKey,
      agentDir: join(root, 'agent'),
      resourceRoot,
      developmentRoot: join(root, 'missing-development-root')
    }
  })
  try {
    const first = host.fs.list('.')
    const second = host.fs.list('.')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(counters.probeSessions, 1)
    releaseProbe()

    assert.deepEqual(await Promise.all([first, second]), [{ entries: [] }, { entries: [] }])
    assert.equal(counters.connections, 1)
    assert.equal(counters.probeSessions, 1)
    assert.equal(counters.uploads, 1)
    assert.equal(host.capabilities().helperStatus?.state, 'available')
    assert.equal(
      readCapabilityProfile(profileKey, { agentDir: join(root, 'agent') })?.helperStatus?.state,
      'available'
    )
  } finally {
    releaseProbe()
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed first-use probe preserves the first pure SSH operation', async () => {
  const result = await firstOperationWithFailure('probe')

  assert.deepEqual(result.entries, [])
  assert.equal(result.probeSessions, 1)
  assert.equal(result.uploads, 0)
  assert.equal(result.probeState, 'unavailable')
  assert.equal(result.helperState, 'degraded')
})

test('a failed first-use helper install preserves the first pure SSH operation', async () => {
  const result = await firstOperationWithFailure('upload')

  assert.deepEqual(result.entries, [])
  assert.equal(result.probeSessions, 1)
  assert.equal(
    result.uploads,
    2,
    result.helperReason ?? 'the existing installer retry remains active'
  )
  assert.equal(result.probeState, 'available')
  assert.equal(result.helperState, 'degraded', result.helperReason)
})
