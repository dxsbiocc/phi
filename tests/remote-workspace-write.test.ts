import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Project } from '../src/main/agent/projects'
import { ensureRemoteProjectAnchor } from '../src/main/agent/remote-project-anchor'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import {
  RemoteWorkspaceWriteManager,
  type RemoteWriteDependencies,
  type RemoteWriteRequest
} from '../src/main/agent/remote-workspace-write'
import {
  buildRemoteWorkspaceWriteTool,
  PHI_REMOTE_WRITE_DESCRIPTION
} from '../src/main/agent/remote-workspace-write-tool'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'

function fixture(): {
  base: string
  root: string
  outside: string
  anchor: string
  dependencies: RemoteWriteDependencies
  beforeInput: (fn: () => void) => void
  replaceInput: (fn: (command: string, input: string) => Promise<RemoteExecResult>) => void
  closeCount: () => number
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-remote-write-'))
  const root = join(base, 'server-project')
  const outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  const agentDir = join(base, 'phi')
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
    workingDirectoryRealPath: location.canonicalRoot,
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
  let beforeInput: (() => void) | undefined
  let replaceInput: ((command: string, input: string) => Promise<RemoteExecResult>) | undefined
  let closeCount = 0
  const run = (command: string, input?: string): RemoteExecResult => {
    const result = spawnSync('bash', ['-c', command], {
      input,
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 2_000_000
    })
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      code: result.status,
      signal: result.signal
    }
  }
  const dependencies: RemoteWriteDependencies = {
    agentDir,
    getManifest: (id) => (id === manifest.sessionId ? manifest : null),
    getProject: (id) => (id === project.id ? project : undefined),
    getHostProfile: (id) =>
      id === 'host-a' ? { id, label: 'Cluster A', hostAlias: 'cluster-a' } : undefined,
    connectImpl: async (): Promise<RemoteSshSession> => ({
      exec: async (command) => run(command),
      execWithInput: async (command, input) => {
        beforeInput?.()
        return replaceInput ? replaceInput(command, input) : run(command, input)
      },
      readTextFile: async () => {
        throw new Error('not used')
      },
      writeTextFile: async () => {
        throw new Error('must not overwrite')
      },
      mkdirp: async () => {
        throw new Error('not used')
      },
      exists: async () => {
        throw new Error('not used')
      },
      uploadFile: async () => {
        throw new Error('must not use SFTP overwrite')
      },
      close: async () => {
        closeCount += 1
      }
    })
  }
  return {
    base,
    root,
    outside,
    anchor: manifest.cwd,
    dependencies,
    beforeInput: (fn: () => void) => {
      beforeInput = fn
    },
    replaceInput: (fn: (command: string, input: string) => Promise<RemoteExecResult>) => {
      replaceInput = fn
    },
    closeCount: () => closeCount,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

function request(path: string, content = 'hello'): RemoteWriteRequest {
  return {
    sessionId: 'session-a',
    projectId: 'project-a',
    requestId: 'request-a',
    toolCallId: 'tool-a',
    path,
    content
  }
}

test('ordinary remote write creates exact text on server without touching local anchor', async () => {
  const f = fixture()
  try {
    const result = await new RemoteWorkspaceWriteManager(f.dependencies).create(
      request('new.txt', 'α\nβ')
    )
    assert.deepEqual(result, {
      status: 'created',
      path: `ssh://cluster-a${realpathSync(f.root)}/new.txt`,
      bytes: 5
    })
    assert.equal(readFileSync(join(f.root, 'new.txt'), 'utf8'), 'α\nβ')
    assert.equal(existsSync(join(f.anchor, 'new.txt')), false)
    assert.deepEqual(readdirSync(f.root), ['new.txt'])
    assert.equal(f.closeCount(), 1)
    const unusual = "line\nwith 'quote'.txt"
    const empty = await new RemoteWorkspaceWriteManager(f.dependencies).create({
      ...request(unusual, ''),
      requestId: 'request-empty'
    })
    assert.equal(empty.status, 'created')
    assert.equal(readFileSync(join(f.root, unusual), 'utf8'), '')
    assert.equal(existsSync(join(f.anchor, unusual)), false)
  } finally {
    f.cleanup()
  }
})

test('existing file, directory, symlink, and a concurrent create never get overwritten', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'existing.txt'), 'old')
    mkdirSync(join(f.root, 'directory'))
    symlinkSync(join(f.outside, 'target'), join(f.root, 'link'))
    assert.equal(spawnSync('mkfifo', [join(f.root, 'pipe')]).status, 0)
    for (const path of ['existing.txt', 'directory', 'link', 'pipe']) {
      await assert.rejects(
        new RemoteWorkspaceWriteManager(f.dependencies).create(request(path)),
        /已存在|符号链接/
      )
    }
    f.beforeInput(() => writeFileSync(join(f.root, 'raced.txt'), 'winner'))
    await assert.rejects(
      new RemoteWorkspaceWriteManager(f.dependencies).create(request('raced.txt', 'loser')),
      /已存在/
    )
    assert.equal(readFileSync(join(f.root, 'existing.txt'), 'utf8'), 'old')
    assert.equal(readFileSync(join(f.root, 'raced.txt'), 'utf8'), 'winner')
    assert.equal(
      readdirSync(f.root).some((name) => name.startsWith('.phi-write-')),
      false
    )
  } finally {
    f.cleanup()
  }
})

test('symlink parent escape and unbound project are rejected before content transfer', async () => {
  const f = fixture()
  try {
    symlinkSync(f.outside, join(f.root, 'escape'))
    await assert.rejects(
      new RemoteWorkspaceWriteManager(f.dependencies).create(request('escape/file.txt')),
      /超出项目根目录/
    )
    await assert.rejects(
      new RemoteWorkspaceWriteManager(f.dependencies).create({
        ...request('file.txt'),
        projectId: 'other'
      }),
      /会话与项目不匹配/
    )
    assert.equal(existsSync(join(f.outside, 'file.txt')), false)
  } finally {
    f.cleanup()
  }
})

test('parent replaced after authorization cannot redirect publication outside the project', async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'sub'))
    f.beforeInput(() => {
      renameSync(join(f.root, 'sub'), join(f.root, 'moved'))
      symlinkSync(f.outside, join(f.root, 'sub'))
    })
    await assert.rejects(
      new RemoteWorkspaceWriteManager(f.dependencies).create(request('sub/file.txt')),
      /父目录已移出项目根目录/
    )
    assert.equal(existsSync(join(f.outside, 'file.txt')), false)
    assert.equal(existsSync(join(f.root, 'moved', 'file.txt')), false)
  } finally {
    f.cleanup()
  }
})

test('write failure cleans staging; disconnect reports unknown and never retries', async () => {
  const f = fixture()
  try {
    let calls = 0
    f.replaceInput(async (command, input) => {
      calls += 1
      if (calls === 1) return { stdout: '', stderr: '', code: 76, signal: null }
      assert.match(command, /perl/)
      assert.equal(input, 'hello')
      throw new Error('SSH disconnected')
    })
    const manager = new RemoteWorkspaceWriteManager(f.dependencies)
    await assert.rejects(manager.create(request('failure.txt')), /临时文件写入失败/)
    const result = await manager.create({ ...request('unknown.txt'), requestId: 'request-b' })
    assert.equal(result.status, 'unknown')
    assert.equal(calls, 2)
    assert.equal(existsSync(join(f.root, 'failure.txt')), false)
    assert.equal(existsSync(join(f.root, 'unknown.txt')), false)
  } finally {
    f.cleanup()
  }
})

test('truncated SSH stdin cannot publish a partial file and removes staging', async () => {
  const f = fixture()
  try {
    f.replaceInput(async (command) => {
      const result = spawnSync('bash', ['-c', command], {
        input: 'short',
        encoding: 'utf8',
        timeout: 3000
      })
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        code: result.status,
        signal: result.signal
      }
    })
    await assert.rejects(
      new RemoteWorkspaceWriteManager(f.dependencies).create(
        request('partial.txt', 'longer-content')
      ),
      /内容传输失败/
    )
    assert.equal(existsSync(join(f.root, 'partial.txt')), false)
    assert.deepEqual(readdirSync(f.root), [])
  } finally {
    f.cleanup()
  }
})

test('cancel closes the bound SSH session and reports an unknown outcome', async () => {
  const f = fixture()
  try {
    let release!: () => void
    f.replaceInput(
      () =>
        new Promise<RemoteExecResult>((_resolve, reject) => {
          release = () => reject(new Error('closed'))
        })
    )
    const manager = new RemoteWorkspaceWriteManager(f.dependencies)
    const pending = manager.create(request('pending.txt'))
    while (!release) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      manager.cancel({ sessionId: 'session-a', projectId: 'project-a', requestId: 'request-a' }),
      true
    )
    release()
    const result = await pending
    assert.equal(result.status, 'unknown')
    assert.equal(f.closeCount() >= 1, true)
  } finally {
    f.cleanup()
  }
})

test('write tool keeps the ordinary name and exposes unknown outcomes', async () => {
  const tool = buildRemoteWorkspaceWriteTool(async () => ({
    status: 'unknown',
    reason: 'connection_lost',
    resultUnknown: true,
    message: 'check server'
  }))
  assert.equal(tool.name, 'write')
  assert.equal(tool.description, PHI_REMOTE_WRITE_DESCRIPTION)
  const result = await tool.execute(
    'call',
    { path: 'x', content: 'y' },
    () => undefined,
    {} as never,
    new AbortController().signal
  )
  assert.equal(result.isError, true)
  assert.deepEqual(result.details, { resultUnknown: true })
})
