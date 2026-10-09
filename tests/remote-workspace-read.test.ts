import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Project } from '../src/main/agent/projects'
import { ensureRemoteProjectAnchor } from '../src/main/agent/remote-project-anchor'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import {
  readRemoteWorkspacePath,
  REMOTE_READ_MAX_BYTES
} from '../src/main/agent/remote-workspace-read'
import {
  buildRemoteWorkspaceReadTool,
  PHI_REMOTE_READ_DESCRIPTION
} from '../src/main/agent/remote-workspace-read-tool'
import type { RemoteWorkspaceBoundaryDependencies } from '../src/main/agent/remote-workspace-boundary'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'

function fixture(): {
  root: string
  agentDir: string
  commands: string[]
  closed: () => number
  dependencies: RemoteWorkspaceBoundaryDependencies
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-remote-read-'))
  const agentDir = join(base, 'phi')
  const root = join(base, 'server-project')
  mkdirSync(root)
  const location = {
    kind: 'ssh' as const,
    hostProfileId: 'host-a',
    remoteRoot: root,
    canonicalRoot: realpathSync(root)
  }
  const project = {
    id: 'project-a',
    name: 'Remote',
    location,
    workingDirectory: root,
    workingDirectoryRealPath: realpathSync(root),
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-09-24T00:00:00.000Z'
  } as Project
  const manifest = {
    sessionId: 'session-a',
    kind: 'project',
    projectId: project.id,
    projectLocation: location,
    cwd: ensureRemoteProjectAnchor(project.id, agentDir)
  } as PhiSessionManifest
  const commands: string[] = []
  let closeCount = 0
  const dependencies: RemoteWorkspaceBoundaryDependencies = {
    agentDir,
    getManifest: (id) => (id === manifest.sessionId ? manifest : null),
    getProject: (id) => (id === project.id ? project : undefined),
    getHostProfile: (id) =>
      id === 'host-a' ? { id, label: 'Cluster A', hostAlias: 'cluster-a' } : undefined,
    connectImpl: async (): Promise<RemoteSshSession> => ({
      exec: async (command) => {
        commands.push(command)
        const result = spawnSync('sh', ['-c', command], {
          encoding: 'utf-8',
          timeout: 5_000,
          maxBuffer: 3 * 1024 * 1024
        })
        return {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          code: result.status,
          signal: result.signal
        }
      },
      readTextFile: async () => {
        throw new Error('unbounded remote read must not be used')
      },
      writeTextFile: async () => {
        throw new Error('read must not write')
      },
      mkdirp: async () => {
        throw new Error('read must not write')
      },
      exists: async () => {
        throw new Error('extra probe must not be used')
      },
      uploadFile: async () => {
        throw new Error('read must not upload')
      },
      close: async () => {
        closeCount += 1
      }
    })
  }
  return {
    root,
    agentDir,
    commands,
    closed: () => closeCount,
    dependencies,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

const request = (path: string): { sessionId: string; projectId: string; path: string } => ({
  sessionId: 'session-a',
  projectId: 'project-a',
  path
})

test('ordinary remote read returns exact UTF-8 text and an SSH source, including empty files', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'note.txt'), 'alpha\nβeta\n')
    writeFileSync(join(sample.root, 'empty.json'), '')
    writeFileSync(
      join(sample.agentDir, 'remote-project-anchors', 'project-a', 'note.txt'),
      'anchor'
    )
    const note = await readRemoteWorkspacePath(request('note.txt'), sample.dependencies)
    assert.deepEqual(note, {
      kind: 'file',
      path: `ssh://cluster-a${realpathSync(join(sample.root, 'note.txt'))}`,
      content: 'alpha\nβeta\n',
      fileSize: Buffer.byteLength('alpha\nβeta\n'),
      contentType: 'text/plain'
    })
    assert.deepEqual(await readRemoteWorkspacePath(request('empty.json'), sample.dependencies), {
      kind: 'file',
      path: `ssh://cluster-a${realpathSync(join(sample.root, 'empty.json'))}`,
      content: '',
      fileSize: 0,
      contentType: 'application/json'
    })
    assert.equal(sample.closed(), 2)
  } finally {
    sample.cleanup()
  }
})

test('remote read uses the WorkspaceHost session supplied by the main process', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'host.txt'), 'through host')
    const connect = sample.dependencies.connectImpl
    assert.ok(connect)
    let hostConnections = 0
    const result = await readRemoteWorkspacePath(request('host.txt'), {
      ...sample.dependencies,
      connectImpl: async () => {
        throw new Error('legacy SSH connection path was used')
      },
      connectHost: async () => {
        hostConnections += 1
        return connect({ host: 'cluster-a' })
      }
    })

    assert.equal(result.kind, 'file')
    assert.equal(result.content, 'through host')
    assert.equal(hostConnections, 1)
  } finally {
    sample.cleanup()
  }
})

test('directory records preserve newlines and quotes, sort directories first, and report empty', async () => {
  const sample = fixture()
  try {
    mkdirSync(join(sample.root, 'folder'))
    mkdirSync(join(sample.root, 'empty'))
    writeFileSync(join(sample.root, "line\n'quote'.txt"), 'x')
    writeFileSync(join(sample.root, 'z.txt'), 'z')
    const listed = await readRemoteWorkspacePath(request('.'), sample.dependencies)
    assert.equal(listed.kind, 'directory')
    if (listed.kind !== 'directory') throw new Error('expected directory')
    assert.deepEqual(
      listed.entries.map((entry) => [entry.name, entry.isDirectory]),
      [
        ['empty', true],
        ['folder', true],
        ["line\n'quote'.txt", false],
        ['z.txt', false]
      ]
    )
    assert.equal(listed.content.includes(JSON.stringify("line\n'quote'.txt")), true)
    const namedFile = await readRemoteWorkspacePath(
      request("line\n'quote'.txt"),
      sample.dependencies
    )
    assert.equal(namedFile.kind, 'file')
    assert.equal(namedFile.path.endsWith(encodeURIComponent("line\n'quote'.txt")), true)
    const empty = await readRemoteWorkspacePath(request('empty'), sample.dependencies)
    assert.equal(empty.kind, 'directory')
    assert.equal(empty.content, '(empty directory)')
  } finally {
    sample.cleanup()
  }
})

test('exactly 1 MiB succeeds; an extra byte fails without returning partial text', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'limit.txt'), 'a'.repeat(REMOTE_READ_MAX_BYTES))
    const exact = await readRemoteWorkspacePath(request('limit.txt'), sample.dependencies)
    assert.equal(exact.kind, 'file')
    assert.equal(exact.content.length, REMOTE_READ_MAX_BYTES)
    writeFileSync(join(sample.root, 'limit.txt'), 'a'.repeat(REMOTE_READ_MAX_BYTES + 1))
    await assert.rejects(
      readRemoteWorkspacePath(request('limit.txt'), sample.dependencies),
      /超过 1 MiB/
    )
  } finally {
    sample.cleanup()
  }
})

test('binary, invalid UTF-8, special files, and symlink escape fail closed', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'binary.dat'), Buffer.from([0, 1, 2]))
    writeFileSync(join(sample.root, 'invalid.txt'), Buffer.from([0xff, 0xfe]))
    await assert.rejects(
      readRemoteWorkspacePath(request('binary.dat'), sample.dependencies),
      /二进制/
    )
    await assert.rejects(
      readRemoteWorkspacePath(request('invalid.txt'), sample.dependencies),
      /二进制|UTF-8/
    )
    const fifo = join(sample.root, 'pipe')
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0)
    await assert.rejects(
      readRemoteWorkspacePath(request('pipe'), sample.dependencies),
      /不是普通文件/
    )
    const outside = join(sample.agentDir, 'outside.txt')
    writeFileSync(outside, 'private')
    symlinkSync(outside, join(sample.root, 'escape'))
    await assert.rejects(
      readRemoteWorkspacePath(request('escape'), sample.dependencies),
      /超出项目根目录/
    )
  } finally {
    sample.cleanup()
  }
})

test('permission failures and oversized directory listings return explicit errors', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'private.txt'), 'private')
    const connect = sample.dependencies.connectImpl
    assert.ok(connect)
    await assert.rejects(
      readRemoteWorkspacePath(request('private.txt'), {
        ...sample.dependencies,
        connectImpl: async (config) => {
          const session = await connect(config)
          return {
            ...session,
            exec: async (command) =>
              command.includes('Fcntl')
                ? { stdout: '', stderr: 'private diagnostic', code: 75, signal: null }
                : session.exec(command)
          }
        }
      }),
      /不可访问或已变成符号链接/
    )
    for (let index = 0; index < 1001; index += 1) {
      writeFileSync(join(sample.root, `entry-${index}`), '')
    }
    await assert.rejects(readRemoteWorkspacePath(request('.'), sample.dependencies), /条目过多/)
    assert.equal(sample.closed(), 2)
  } finally {
    sample.cleanup()
  }
})

test('swapping a leaf or directory to an outside symlink after authorization is rejected', async () => {
  const sample = fixture()
  try {
    const outsideDir = join(sample.agentDir, 'outside')
    mkdirSync(outsideDir)
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret')
    writeFileSync(join(sample.root, 'target.txt'), 'safe')
    const connect = sample.dependencies.connectImpl
    assert.ok(connect)
    let swaps = 0
    const swappedFileDependencies: RemoteWorkspaceBoundaryDependencies = {
      ...sample.dependencies,
      connectImpl: async (config) => {
        const session = await connect(config)
        let calls = 0
        return {
          ...session,
          exec: async (command) => {
            const result = await session.exec(command)
            if (++calls === 1) {
              rmSync(join(sample.root, 'target.txt'))
              symlinkSync(join(outsideDir, 'secret.txt'), join(sample.root, 'target.txt'))
              swaps += 1
            }
            return result
          }
        }
      }
    }
    await assert.rejects(
      readRemoteWorkspacePath(request('target.txt'), swappedFileDependencies),
      /符号链接/
    )

    mkdirSync(join(sample.root, 'folder'))
    const swappedDirectoryDependencies: RemoteWorkspaceBoundaryDependencies = {
      ...sample.dependencies,
      connectImpl: async (config) => {
        const session = await connect(config)
        let calls = 0
        return {
          ...session,
          exec: async (command) => {
            const result = await session.exec(command)
            if (++calls === 1) {
              rmSync(join(sample.root, 'folder'), { recursive: true })
              symlinkSync(outsideDir, join(sample.root, 'folder'))
              swaps += 1
            }
            return result
          }
        }
      }
    }
    await assert.rejects(
      readRemoteWorkspacePath(request('folder'), swappedDirectoryDependencies),
      /移出项目根目录/
    )
    assert.equal(swaps, 2)
    assert.equal(sample.closed(), 2)
  } finally {
    sample.cleanup()
  }
})

test('missing file, malformed request, and disconnected SSH do not read the anchor', async () => {
  const sample = fixture()
  try {
    await assert.rejects(
      readRemoteWorkspacePath(request('missing'), sample.dependencies),
      /目标不存在/
    )
    await assert.rejects(
      readRemoteWorkspacePath({ ...request('x'), host: 'attacker' }, sample.dependencies),
      /只能包含会话、项目 ID 和路径/
    )
    await assert.rejects(
      readRemoteWorkspacePath(request('x'), {
        ...sample.dependencies,
        connectImpl: async () => {
          throw new Error('SSH offline')
        }
      }),
      /SSH offline/
    )
    writeFileSync(join(sample.root, 'x'), 'remote')
    const connect = sample.dependencies.connectImpl
    assert.ok(connect)
    await assert.rejects(
      readRemoteWorkspacePath(request('x'), {
        ...sample.dependencies,
        connectImpl: async (config) => {
          const session = await connect(config)
          let calls = 0
          return {
            ...session,
            exec: async (command) => {
              if (++calls === 3) throw new Error('SSH dropped during read')
              return session.exec(command)
            }
          }
        }
      }),
      /SSH dropped during read/
    )
    assert.equal(sample.closed(), 2)
  } finally {
    sample.cleanup()
  }
})

test('same-name read tool preserves the SDK path parameter and remote source metadata', async () => {
  const calls: string[] = []
  const tool = buildRemoteWorkspaceReadTool(async (path) => {
    calls.push(path)
    return {
      kind: 'file',
      path: 'ssh://cluster-a/project/note.txt',
      content: 'remote text',
      fileSize: 11,
      contentType: 'text/plain'
    }
  })
  assert.equal(tool.name, 'read')
  assert.equal(tool.description, PHI_REMOTE_READ_DESCRIPTION)
  assert.deepEqual(tool.parameters.required, ['path'])
  const result = await tool.execute('call-1', { path: 'note.txt' }, undefined, {} as never)
  assert.equal(calls[0], 'note.txt')
  assert.equal(result.content[0]?.text, 'remote text')
  assert.deepEqual(result.details, {
    resolvedPath: 'ssh://cluster-a/project/note.txt',
    kind: 'file',
    fileSize: 11,
    contentType: 'text/plain'
  })
  const invalid = await tool.execute('call-2', {}, undefined, {} as never)
  assert.equal(invalid.isError, true)
  assert.equal(calls.length, 1)
})
