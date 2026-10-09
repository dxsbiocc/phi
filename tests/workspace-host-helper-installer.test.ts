import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
  installRemoteHelper,
  reconcileRemoteHelperProfile,
  remoteHelperResourceCandidates,
  resolveRemoteHelperArtifact
} from '../src/main/agent/workspace-host/helper-installer'
import { readCapabilityProfile } from '../src/main/agent/workspace-host/capability-profile-store'
import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'phi-helper-installer-'))
  temporaryDirectories.push(path)
  return path
}

function profile(os: string, arch: string): ReturnType<typeof parseHostCapabilityProbe> {
  return parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=${os}
platform.arch=${arch}
storage.home_writable=1
storage.home_executable=1
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)
}

function unusedSession(): RemoteSshSession {
  const unexpected = (): never => {
    throw new Error('unsupported platforms must not touch the remote session')
  }
  return {
    exec: async () => unexpected(),
    readTextFile: async () => unexpected(),
    writeTextFile: async () => unexpected(),
    mkdirp: async () => unexpected(),
    exists: async () => unexpected(),
    uploadFile: async () => unexpected(),
    close: async () => undefined
  }
}

interface InstallerSessionOptions {
  hash?: string
  selftest?: RemoteExecResult
  uploadFailures?: number
}

class InstallerSession implements RemoteSshSession {
  readonly commands: string[] = []
  readonly uploads: Array<{ localPath: string; remotePath: string }> = []
  private uploadFailures: number

  constructor(
    private readonly expectedHash: string,
    private readonly options: InstallerSessionOptions = {}
  ) {
    this.uploadFailures = options.uploadFailures ?? 0
  }

  async exec(command: string): Promise<RemoteExecResult> {
    this.commands.push(command)
    if (command.includes('__PHI_HELPER_HOME__')) return ok('__PHI_HELPER_HOME__/home/test\n')
    if (command.includes('__PHI_HELPER_ALTERNATE__')) {
      return ok('__PHI_HELPER_ALTERNATE__/tmp/phi-remote-1000\n')
    }
    if (command.startsWith('sha256sum ')) {
      return ok(`${this.options.hash ?? this.expectedHash}  uploaded\n`)
    }
    if (command.includes('--selftest')) return this.options.selftest ?? ok('{"ok":true}\n')
    return ok()
  }

  async readTextFile(): Promise<string> {
    throw new Error('not used')
  }

  async writeTextFile(): Promise<void> {
    throw new Error('not used')
  }

  async mkdirp(): Promise<void> {
    throw new Error('not used')
  }

  async exists(): Promise<boolean> {
    throw new Error('not used')
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    this.uploads.push({ localPath, remotePath })
    if (this.uploadFailures > 0) {
      this.uploadFailures -= 1
      throw new Error('upload interrupted')
    }
  }

  async close(): Promise<void> {
    return undefined
  }
}

function ok(stdout = ''): RemoteExecResult {
  return { stdout, stderr: '', code: 0, signal: null }
}

function artifact(version = '0.1.0'): {
  directory: string
  artifact: { version: string; localPath: string; sha256: string }
} {
  const directory = temporaryDirectory()
  const localPath = join(directory, 'phi-helper')
  writeFileSync(localPath, 'helper bytes')
  return {
    directory,
    artifact: {
      version,
      localPath,
      sha256: createHash('sha256').update('helper bytes').digest('hex')
    }
  }
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('unsupported helper platforms degrade to pure SSH without uploading', async () => {
  const agentDir = temporaryDirectory()
  const key = { hostAlias: 'cluster', projectRoot: '/work/project' }
  const result = await installRemoteHelper({
    session: unusedSession(),
    profile: profile('Darwin', 'arm64'),
    profileKey: key,
    artifact: {
      version: '0.1.0',
      localPath: '/unused/phi-helper',
      sha256: 'a'.repeat(64)
    },
    agentDir
  })

  assert.equal(result.state, 'degraded')
  assert.match(result.reason, /Linux only/i)
  assert.deepEqual(result.profile.helperStatus?.affectedCapabilities, ['fs', 'exec', 'background'])
  assert.equal(result.profile.helperStatus?.version, '0.1.0')
  assert.equal(result.profile.fs.state, 'degraded')
  assert.equal(result.profile.exec.state, 'degraded')
  assert.equal(result.profile.background.state, 'degraded')
  assert.equal(result.profile.pty.state, 'unavailable')
  assert.equal(result.profile.watch.state, 'unavailable')
  assert.equal(result.profile.forwardPort.state, 'unavailable')
  assert.equal(
    readCapabilityProfile(key, { agentDir, expectedHelperVersion: '0.1.0' })?.helperStatus?.state,
    'degraded'
  )
})

test('unsupported Linux architectures degrade without uploading', async () => {
  const agentDir = temporaryDirectory()
  const fixture = artifact()
  const result = await installRemoteHelper({
    session: unusedSession(),
    profile: profile('Linux', 's390x'),
    profileKey: { hostAlias: 'cluster', projectRoot: '/work/project' },
    artifact: fixture.artifact,
    agentDir
  })

  assert.equal(result.state, 'degraded')
  assert.match(result.reason, /unsupported.*architecture/i)
  assert.equal(
    readCapabilityProfile(
      { hostAlias: 'cluster', projectRoot: '/work/project' },
      { agentDir, expectedHelperVersion: '0.2.0' }
    ),
    undefined
  )
})

test('helper installation retries an interrupted upload and activates the verified version', async () => {
  const agentDir = temporaryDirectory()
  const fixture = artifact()
  const session = new InstallerSession(fixture.artifact.sha256, { uploadFailures: 1 })
  const result = await installRemoteHelper({
    session,
    profile: profile('Linux', 'x86_64'),
    profileKey: { hostAlias: 'cluster', projectRoot: '/work/project' },
    artifact: fixture.artifact,
    agentDir
  })

  assert.equal(result.state, 'available')
  assert.equal(result.remotePath, '/home/test/.phi/remote/0.1.0/phi-helper')
  assert.equal(session.uploads.length, 2)
  assert.notEqual(session.uploads[0]?.remotePath, session.uploads[1]?.remotePath)
  assert.ok(session.commands.some((command) => command.includes('sha256sum ')))
  assert.ok(session.commands.some((command) => command.includes('chmod 700 ')))
  assert.ok(session.commands.some((command) => command.includes('--selftest')))
  assert.equal(result.profile.helperStatus?.state, 'available')
  assert.deepEqual(result.profile.helperStatus?.affectedCapabilities, [])
  assert.equal(result.profile.fs.state, 'available')
})

test('helper installation retries a hash mismatch once before degrading', async () => {
  const fixture = artifact()
  const session = new InstallerSession(fixture.artifact.sha256, { hash: 'b'.repeat(64) })
  const result = await installRemoteHelper({
    session,
    profile: profile('Linux', 'arm64'),
    profileKey: { hostAlias: 'cluster', projectRoot: '/work/project' },
    artifact: fixture.artifact,
    agentDir: temporaryDirectory()
  })

  assert.equal(session.uploads.length, 2)
  assert.equal(session.commands.filter((command) => command.startsWith('rm -f ')).length, 2)
  assert.equal(result.state, 'degraded')
  assert.match(result.reason, /sha256 mismatch/)
})

test('helper installation degrades after two interrupted uploads', async () => {
  const fixture = artifact()
  const session = new InstallerSession(fixture.artifact.sha256, { uploadFailures: 2 })
  const result = await installRemoteHelper({
    session,
    profile: profile('Linux', 'x86_64'),
    profileKey: { hostAlias: 'cluster', projectRoot: '/work/project' },
    artifact: fixture.artifact,
    agentDir: temporaryDirectory()
  })

  assert.equal(session.uploads.length, 2)
  assert.equal(session.commands.filter((command) => command.startsWith('rm -f ')).length, 2)
  assert.equal(result.state, 'degraded')
  assert.match(result.reason, /upload interrupted/)
})

test('helper installation uses an alternate executable directory for noexec home', async () => {
  const fixture = artifact()
  const detected = profile('Linux', 'x86_64')
  const noexec = {
    ...detected,
    storage: {
      ...detected.storage,
      homeExecutable: { state: 'unavailable' as const, reason: 'home is noexec' }
    }
  }
  const session = new InstallerSession(fixture.artifact.sha256)
  const result = await installRemoteHelper({
    session,
    profile: noexec,
    profileKey: { hostAlias: 'cluster', projectRoot: '/work/project' },
    artifact: fixture.artifact,
    agentDir: temporaryDirectory()
  })

  assert.equal(result.remotePath, '/tmp/phi-remote-1000/0.1.0/phi-helper')
  const alternate = session.commands.find((command) => command.includes('__PHI_HELPER_ALTERNATE__'))
  assert.match(alternate ?? '', /^bash -c /)
  assert.match(alternate ?? '', /\[ -O /)
  assert.match(alternate ?? '', /\[ ! -L /)
  assert.match(alternate ?? '', /chmod 700/)
  assert.match(alternate ?? '', /stat -c %a/)
  assert.ok(session.commands.every((command) => !command.includes('__PHI_HELPER_HOME__')))
})

test('helper selftest failure degrades without replaying the upload', async () => {
  const fixture = artifact()
  const session = new InstallerSession(fixture.artifact.sha256, {
    selftest: { stdout: '', stderr: 'selftest failed', code: 1, signal: null }
  })
  const result = await installRemoteHelper({
    session,
    profile: profile('Linux', 'x86_64'),
    profileKey: { hostAlias: 'cluster', projectRoot: '/work/project' },
    artifact: fixture.artifact,
    agentDir: temporaryDirectory()
  })

  assert.equal(session.uploads.length, 1)
  assert.equal(result.state, 'degraded')
  assert.match(result.reason, /selftest failed/)
})

test('helper versions install to distinct paths', async () => {
  const paths: string[] = []
  for (const version of ['0.1.0', '0.2.0']) {
    const fixture = artifact(version)
    const session = new InstallerSession(fixture.artifact.sha256)
    const result = await installRemoteHelper({
      session,
      profile: profile('Linux', 'x86_64'),
      profileKey: { hostAlias: 'cluster', projectRoot: '/work/project' },
      artifact: fixture.artifact,
      agentDir: temporaryDirectory()
    })
    if (result.remotePath) paths.push(result.remotePath)
  }

  assert.deepEqual(paths, [
    '/home/test/.phi/remote/0.1.0/phi-helper',
    '/home/test/.phi/remote/0.2.0/phi-helper'
  ])
})

test('helper resources fall back from Electron resources to the repository only in development', () => {
  assert.deepEqual(
    remoteHelperResourceCandidates('/Applications/Phi.app/Contents/Resources', '/repo', true),
    ['/Applications/Phi.app/Contents/Resources/remote-helper', '/repo/resources/remote-helper']
  )
  assert.deepEqual(
    remoteHelperResourceCandidates('/Applications/Phi.app/Contents/Resources', '/untrusted', false),
    ['/Applications/Phi.app/Contents/Resources/remote-helper']
  )
})

test('helper manifest still provides its version for an unsupported platform fallback', () => {
  const root = temporaryDirectory()
  writeFileSync(
    join(root, 'manifest.json'),
    `${JSON.stringify({
      version: '0.3.0',
      platforms: {
        'linux-amd64': {
          path: '0.3.0/linux-amd64/phi-helper',
          sha256: 'a'.repeat(64)
        }
      }
    })}\n`
  )

  assert.deepEqual(resolveRemoteHelperArtifact(profile('Darwin', 'arm64'), root), {
    version: '0.3.0',
    localPath: '',
    sha256: '0'.repeat(64)
  })
})

test('a bundled helper version change invalidates only stale helper state', () => {
  const resourceRoot = temporaryDirectory()
  const agentDir = temporaryDirectory()
  const key = { hostAlias: 'cluster', projectRoot: '/work/project' }
  writeFileSync(
    join(resourceRoot, 'manifest.json'),
    `${JSON.stringify({ version: '0.2.0', platforms: {} })}\n`
  )
  const stale = {
    ...profile('Darwin', 'arm64'),
    helperVersion: '0.1.0',
    helperStatus: {
      state: 'degraded' as const,
      reason: 'old helper failed',
      version: '0.1.0',
      affectedCapabilities: ['fs', 'exec', 'background'] as const
    },
    fs: { state: 'degraded' as const, reason: 'pure SSH fallback' },
    exec: { state: 'degraded' as const, reason: 'pure SSH fallback' },
    background: { state: 'degraded' as const, reason: 'pure SSH fallback' }
  }
  const reconciled = reconcileRemoteHelperProfile(stale, {
    profileKey: key,
    agentDir,
    resourceRoot
  })

  assert.equal(reconciled.helperVersion, undefined)
  assert.equal(reconciled.helperStatus, undefined)
  assert.equal(reconciled.fs.state, 'available')
  assert.equal(reconciled.platform.os, 'darwin')
  assert.equal(readCapabilityProfile(key, { agentDir })?.helperVersion, undefined)
})
