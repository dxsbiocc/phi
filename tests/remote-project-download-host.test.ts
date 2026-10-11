import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
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
  const session = scriptedSession(commands)
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
    const curlCommand = commands.find((command) => command.includes('--continue-at -')) ?? ''
    assert.match(curlCommand, /curl -q/)
    assert.match(curlCommand, /--continue-at -/)
    assert.match(curlCommand, /--resolve 'example\.org:443:93\.184\.216\.34'/)
    assert.ok(commands.some((command) => command.includes('ln -- "$phi_part" "$phi_dest"')))
    assert.ok(commands.every((command) => !command.includes(anchor)))
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched')
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('remote download manager surfaces server network errors without retrying locally', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-remote-download-network-'))
  const anchor = ensureRemoteProjectAnchor('project-1', agentDir)
  const session = scriptedSession([], {
    headResult: { ...result('PHI_ERROR=NETWORK\n'), code: 83 }
  })
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
  const session = scriptedSession([], { headResult: headResult(302) })
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
  const session = scriptedSession([], { publishRace: true })
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
const digest = 'a'.repeat(64)

function headResult(status = 200): ReturnType<typeof result> {
  return result(
    [
      `PHI_HTTP_CODE=${status}`,
      'PHI_HTTP_SIZE=12',
      `PHI_HTTP_ETAG_HEX=${Buffer.from('"fixture-v1"').toString('hex')}`,
      'PHI_HTTP_LAST_MODIFIED_HEX=',
      `PHI_HTTP_SHA256_HEX=${Buffer.from(digest).toString('hex')}`,
      'PHI_HTTP_DIGEST_HEX=',
      ''
    ].join('\n')
  )
}

function scriptedSession(
  commands: string[],
  options: Readonly<{
    headResult?: ReturnType<typeof result>
    publishRace?: boolean
  }> = {}
): RemoteSshSession {
  let partialSize: number | null = null
  const execute = async (command: string): Promise<ReturnType<typeof result>> => {
    commands.push(command)
    if (command.includes('candidate=')) {
      return result(
        command.includes('downloads/data.txt')
          ? '/remote/project/downloads/data.txt\0'
          : '/remote/project/data.txt\0'
      )
    }
    if (command.includes('getent ahosts')) return result('93.184.216.34\n')
    if (
      command.includes('df -Pk') &&
      command.includes('PHI_SPACE=') &&
      !command.includes('hash_tool=sha256sum')
    ) {
      return result('PHI_SPACE=1073741824\n')
    }
    if (command.includes('hash_tool=sha256sum')) {
      return result(
        [
          'PHI_HASH=sha256sum',
          'PHI_SPACE=1073741824',
          'PHI_PART=missing:0',
          'PHI_MANIFEST_HEX=',
          ''
        ].join('\n')
      )
    }
    if (command.includes('curl -q --head')) return options.headResult ?? headResult()
    if (command.includes('PHI_PART=file:%s')) {
      return result(
        partialSize === null ? 'PHI_PART=missing:0\n' : `PHI_PART=file:${partialSize}\n`
      )
    }
    if (command.includes('phi_manifest=') && command.includes('set -C; : > "$phi_part"')) {
      partialSize = 0
      return result('')
    }
    if (command.includes('tail -c +') && command.includes("printf 'PHI_HASH=%s")) {
      return result(`PHI_HASH=${digest}\n`)
    }
    if (command.includes('ln -- "$phi_part" "$phi_dest"')) {
      if (options.publishRace) {
        return { ...result('PHI_ERROR=DESTINATION_EXISTS\n'), code: 49 }
      }
      partialSize = null
      return result(`PHI_HASH=${digest}\n`)
    }
    return result('')
  }
  return {
    exec: execute,
    execBounded: execute,
    async openStdio(command) {
      commands.push(command)
      partialSize = 12
      return {
        stdin: new Writable({
          write(_chunk, _encoding, callback) {
            callback()
          }
        }),
        stdout: Readable.from([
          `PHI_PROGRESS_V1\t12\t0\t12\t${digest}\n`,
          `PHI_REMOTE_DOWNLOAD_V2\t12\t${digest}\n`
        ]),
        stderr: Readable.from([]),
        closed: Promise.resolve({ code: 0, signal: null }),
        async close() {
          return undefined
        }
      }
    },
    async close() {
      return undefined
    }
  } as unknown as RemoteSshSession
}
