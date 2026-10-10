import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RemoteProjectDownloadManager } from '../src/main/agent/download/remote-project-download'
import { ensureRemoteProjectAnchor } from '../src/main/agent/remote-project-anchor'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'

test('remote download manager runs curl on the selected server without local fallback', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-remote-download-host-'))
  const anchor = ensureRemoteProjectAnchor('project-1', agentDir)
  const sentinel = join(anchor, 'sentinel.txt')
  writeFileSync(sentinel, 'untouched')
  const location = {
    kind: 'ssh' as const,
    hostProfileId: 'profile-1',
    remoteRoot: '/remote/project',
    canonicalRoot: '/remote/project'
  }
  const commands: string[] = []
  let call = 0
  const execute = async (command: string): Promise<ReturnType<typeof result>> => {
    commands.push(command)
    call += 1
    if (call === 1) return result('/remote/project/downloads/data.txt\0')
    if (call === 2) return result('93.184.216.34\n')
    return result('PHI_REMOTE_DOWNLOAD_V1\t12\n')
  }
  const session = {
    exec: execute,
    execBounded: execute,
    async close(): Promise<void> {
      return undefined
    }
  } as unknown as RemoteSshSession
  const manager = new RemoteProjectDownloadManager({
    agentDir,
    getManifest: () =>
      ({
        kind: 'project',
        projectId: 'project-1',
        cwd: anchor,
        projectLocation: location
      }) as never,
    getProject: () => ({ id: 'project-1', location }) as never,
    getHostProfile: () => ({ id: 'profile-1', label: 'Cluster', hostAlias: 'cluster-a' }),
    connectHost: async () => session
  })
  try {
    const downloaded = await manager.run({
      sessionId: 'phi-session-1',
      projectId: 'project-1',
      requestId: 'request-1234',
      toolCallId: 'tool-1',
      url: 'https://example.org/data.txt',
      outputPath: 'downloads/data.txt',
      maxFileBytes: 1024
    })
    assert.deepEqual(downloaded, {
      path: 'ssh://cluster-a/remote/project/downloads/data.txt',
      displayPath: 'downloads/data.txt',
      bytes: 12
    })
    assert.match(commands[1] ?? '', /getent ahosts/)
    assert.match(commands[2] ?? '', /curl/)
    assert.match(commands[2] ?? '', /--resolve 'example\.org:443:93\.184\.216\.34'/)
    assert.match(commands[2] ?? '', /cd -P/)
    assert.match(commands[2] ?? '', /phi_root='\/remote\/project'/)
    assert.match(commands[2] ?? '', /mktemp -d/)
    assert.match(commands[2] ?? '', /ln --/)
    assert.doesNotMatch(commands[2] ?? '', /mv --/)
    assert.ok(commands.every((command) => !command.includes(anchor)))
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched')
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('remote download manager surfaces server network errors without retrying locally', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-remote-download-network-'))
  const anchor = ensureRemoteProjectAnchor('project-1', agentDir)
  const execute = async (command: string): Promise<ReturnType<typeof result>> =>
    command.includes('candidate=')
      ? result('/remote/project/data.txt\0')
      : command.includes('getent ahosts')
        ? result('93.184.216.34\n')
        : { ...result(''), code: 83 }
  const session = {
    exec: execute,
    execBounded: execute,
    async close(): Promise<void> {
      return undefined
    }
  } as unknown as RemoteSshSession
  const manager = managerWithSession(session, agentDir, anchor)
  try {
    await assert.rejects(
      manager.run({
        sessionId: 'phi-session-1',
        projectId: 'project-1',
        requestId: 'request-5678',
        toolCallId: 'tool-2',
        url: 'https://example.org/data.txt',
        outputPath: 'data.txt',
        maxFileBytes: 1024
      }),
      /服务器无法联网/
    )
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('remote download refuses server redirects instead of following an unvalidated host', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-remote-download-redirect-'))
  const anchor = ensureRemoteProjectAnchor('project-1', agentDir)
  const execute = async (command: string): Promise<ReturnType<typeof result>> =>
    command.includes('candidate=')
      ? result('/remote/project/data.txt\0')
      : command.includes('getent ahosts')
        ? result('93.184.216.34\n')
        : { ...result(''), code: 85 }
  const session = {
    exec: execute,
    execBounded: execute,
    async close(): Promise<void> {
      return undefined
    }
  } as unknown as RemoteSshSession
  try {
    await assert.rejects(
      managerWithSession(session, agentDir, anchor).run({
        sessionId: 'phi-session-1',
        projectId: 'project-1',
        requestId: 'request-redirect',
        toolCallId: 'tool-redirect',
        url: 'https://example.org/data.txt',
        outputPath: 'data.txt',
        maxFileBytes: 1024
      }),
      /最终的公开 HTTPS 地址/
    )
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('remote download cancellation before start performs no server or local work', async () => {
  let connections = 0
  const manager = new RemoteProjectDownloadManager({
    connectHost: async () => {
      connections += 1
      throw new Error('must not connect')
    }
  })
  manager.cancel({
    sessionId: 'phi-session-1',
    projectId: 'project-1',
    requestId: 'request-cancelled'
  })
  await assert.rejects(
    manager.run({
      sessionId: 'phi-session-1',
      projectId: 'project-1',
      requestId: 'request-cancelled',
      toolCallId: 'tool-3',
      url: 'https://example.org/data.txt',
      outputPath: 'data.txt',
      maxFileBytes: 1024
    }),
    /abort/i
  )
  assert.equal(connections, 0)
})

test('remote download cancellation is scoped to the owning session and project', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-remote-download-cancel-scope-'))
  const anchor = ensureRemoteProjectAnchor('project-1', agentDir)
  const session = {
    async exec(): Promise<never> {
      throw new Error('owner request reached its backend')
    },
    async close(): Promise<void> {
      return undefined
    }
  } as unknown as RemoteSshSession
  const manager = managerWithSession(session, agentDir, anchor)
  manager.cancel({
    sessionId: 'other-session',
    projectId: 'project-1',
    requestId: 'request-scoped'
  })
  try {
    await assert.rejects(
      manager.run({
        sessionId: 'phi-session-1',
        projectId: 'project-1',
        requestId: 'request-scoped',
        toolCallId: 'tool-4',
        url: 'https://example.org/data.txt',
        outputPath: 'data.txt',
        maxFileBytes: 1024
      }),
      /owner request reached/
    )
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('remote download rejects hostnames that resolve to private server addresses', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-remote-download-private-dns-'))
  const anchor = ensureRemoteProjectAnchor('project-1', agentDir)
  const commands: string[] = []
  const execute = async (command: string): Promise<ReturnType<typeof result>> => {
    commands.push(command)
    return command.includes('candidate=')
      ? result('/remote/project/data.txt\0')
      : result('10.0.0.2\n')
  }
  const session = {
    exec: execute,
    execBounded: execute,
    async close(): Promise<void> {
      return undefined
    }
  } as unknown as RemoteSshSession
  try {
    await assert.rejects(
      managerWithSession(session, agentDir, anchor).run({
        sessionId: 'phi-session-1',
        projectId: 'project-1',
        requestId: 'request-private',
        toolCallId: 'tool-private',
        url: 'https://internal.example/data.txt',
        outputPath: 'data.txt',
        maxFileBytes: 1024
      }),
      /private or invalid server address/
    )
    assert.equal(
      commands.some((command) => command.includes('curl ')),
      false
    )
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('remote download no-clobber publish reports a target race without overwrite', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-remote-download-race-'))
  const anchor = ensureRemoteProjectAnchor('project-1', agentDir)
  const execute = async (command: string): Promise<ReturnType<typeof result>> =>
    command.includes('candidate=')
      ? result('/remote/project/data.txt\0')
      : command.includes('getent ahosts')
        ? result('93.184.216.34\n')
        : { ...result(''), code: 87 }
  const session = {
    exec: execute,
    execBounded: execute,
    async close(): Promise<void> {
      return undefined
    }
  } as unknown as RemoteSshSession
  try {
    await assert.rejects(
      managerWithSession(session, agentDir, anchor).run({
        sessionId: 'phi-session-1',
        projectId: 'project-1',
        requestId: 'request-race',
        toolCallId: 'tool-race',
        url: 'https://example.org/data.txt',
        outputPath: 'data.txt',
        maxFileBytes: 1024
      }),
      /未覆盖现有文件/
    )
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

function managerWithSession(
  session: RemoteSshSession,
  agentDir: string,
  anchor: string
): RemoteProjectDownloadManager {
  const location = {
    kind: 'ssh' as const,
    hostProfileId: 'profile-1',
    remoteRoot: '/remote/project',
    canonicalRoot: '/remote/project'
  }
  return new RemoteProjectDownloadManager({
    agentDir,
    getManifest: () =>
      ({
        kind: 'project',
        projectId: 'project-1',
        cwd: anchor,
        projectLocation: location
      }) as never,
    getProject: () => ({ id: 'project-1', location }) as never,
    getHostProfile: () => ({ id: 'profile-1', label: 'Cluster', hostAlias: 'cluster-a' }),
    connectHost: async () => session
  })
}

function result(stdout: string): {
  stdout: string
  stderr: string
  code: number
  signal: null
  stdoutTruncated: false
  stderrTruncated: false
} {
  return {
    stdout,
    stderr: '',
    code: 0,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false
  }
}
