import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
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
  RemoteWorkspaceMutationManager,
  RemoteWorkspaceReadBasis,
  applyRemoteReplace,
  type RemoteMutationDependencies,
  type RemoteEditRequest
} from '../src/main/agent/remote-workspace-edit'
import type { RemoteWriteRequest } from '../src/main/agent/remote-workspace-write'
import {
  buildRemoteWorkspaceEditTool,
  PHI_REMOTE_EDIT_DESCRIPTION
} from '../src/main/agent/remote-workspace-edit-tool'
import { readRemoteWorkspacePath } from '../src/main/agent/remote-workspace-read'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'

function fixture(): {
  root: string
  outside: string
  anchor: string
  basis: RemoteWorkspaceReadBasis
  dependencies: RemoteMutationDependencies
  observe: (path: string, sessionId?: string) => Promise<void>
  beforeInput: (callback: () => void) => void
  replaceInput: (callback: (command: string, content: string) => Promise<RemoteExecResult>) => void
  setHostAlias: (alias: string) => void
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-remote-edit-'))
  const root = join(base, 'project')
  const outside = join(base, 'outside')
  const agentDir = join(base, 'phi')
  mkdirSync(root)
  mkdirSync(outside)
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
    permissionMode: 'auto',
    pathAvailable: true,
    createdAt: '2026-09-24T00:00:00.000Z'
  } as Project
  const anchor = ensureRemoteProjectAnchor(project.id, agentDir)
  const manifest = (sessionId: string): PhiSessionManifest =>
    ({
      sessionId,
      kind: 'project',
      projectId: project.id,
      projectLocation: location,
      cwd: anchor
    }) as PhiSessionManifest
  let onInput: (() => void) | undefined
  let hostAlias = 'cluster-a'
  let inputOverride: ((command: string, content: string) => Promise<RemoteExecResult>) | undefined
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
  const basis = new RemoteWorkspaceReadBasis()
  const dependencies: RemoteMutationDependencies = {
    basis,
    agentDir,
    getManifest: (id) => (id === 'session-a' || id === 'session-b' ? manifest(id) : null),
    getProject: (id) => (id === project.id ? project : undefined),
    getHostProfile: (id) => (id === 'host-a' ? { id, label: 'Cluster A', hostAlias } : undefined),
    connectImpl: async (): Promise<RemoteSshSession> => ({
      exec: async (command) => run(command),
      execWithInput: async (command, content) => {
        onInput?.()
        return inputOverride ? inputOverride(command, content) : run(command, content)
      },
      readTextFile: async () => {
        throw new Error('unbounded read not allowed')
      },
      writeTextFile: async () => {
        throw new Error('in-place write not allowed')
      },
      mkdirp: async () => {
        throw new Error('not used')
      },
      exists: async () => {
        throw new Error('not used')
      },
      uploadFile: async () => {
        throw new Error('SFTP overwrite not allowed')
      },
      close: async () => undefined
    })
  }
  const observe = async (path: string, sessionId = 'session-a'): Promise<void> => {
    const result = await readRemoteWorkspacePath(
      { sessionId, projectId: project.id, path },
      {
        ...dependencies,
        onFileRead: (authorized, content) =>
          basis.record(
            authorized.sessionId,
            authorized.projectId,
            authorized.hostAlias,
            authorized.path,
            content
          )
      }
    )
    assert.equal(result.kind, 'file')
  }
  return {
    root,
    outside,
    anchor,
    basis,
    dependencies,
    observe,
    beforeInput: (callback) => {
      onInput = callback
    },
    replaceInput: (callback) => {
      inputOverride = callback
    },
    setHostAlias: (alias) => {
      hostAlias = alias
    },
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

function writeRequest(path: string, content: string, requestId = 'write-a'): RemoteWriteRequest {
  return {
    sessionId: 'session-a',
    projectId: 'project-a',
    requestId,
    toolCallId: `tool-${requestId}`,
    path,
    content
  }
}

function editRequest(
  path: string,
  old_string: string,
  new_string: string,
  requestId = 'edit-a'
): RemoteEditRequest {
  return {
    sessionId: 'session-a',
    projectId: 'project-a',
    requestId,
    toolCallId: `tool-${requestId}`,
    path,
    old_string,
    new_string
  }
}

test('ordinary read → edit → write updates the remote file and never touches the local anchor', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'note.txt'), 'alpha\nβeta\n')
    chmodSync(join(f.root, 'note.txt'), 0o640)
    await f.observe('note.txt')
    const manager = new RemoteWorkspaceMutationManager(f.dependencies)
    const edited = await manager.edit(editRequest('note.txt', 'βeta', 'gamma'))
    assert.equal(edited.status, 'updated')
    assert.equal(readFileSync(join(f.root, 'note.txt'), 'utf8'), 'alpha\ngamma\n')
    const written = await manager.write(writeRequest('note.txt', 'full replacement'))
    assert.equal(written.status, 'updated')
    assert.equal(readFileSync(join(f.root, 'note.txt'), 'utf8'), 'full replacement')
    assert.equal(statSync(join(f.root, 'note.txt')).mode & 0o777, 0o640)
    assert.equal(existsSync(join(f.anchor, 'note.txt')), false)
    assert.deepEqual(readdirSync(f.root), ['note.txt'])
  } finally {
    f.cleanup()
  }
})

test('write still creates an absent file, while an unread existing file cannot be modified', async () => {
  const f = fixture()
  try {
    const manager = new RemoteWorkspaceMutationManager(f.dependencies)
    const created = await manager.write(writeRequest('new.txt', 'created'))
    assert.equal(created.status, 'created')
    assert.equal(readFileSync(join(f.root, 'new.txt'), 'utf8'), 'created')
    await assert.rejects(
      manager.write(writeRequest('new.txt', 'overwrite', 'write-b')),
      /请先用 read/
    )
    await assert.rejects(manager.edit(editRequest('new.txt', 'created', 'changed')), /请先用 read/)
    assert.equal(readFileSync(join(f.root, 'new.txt'), 'utf8'), 'created')
  } finally {
    f.cleanup()
  }
})

test('stale read basis and another session basis are rejected until a new read', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'note.txt'), 'first')
    await f.observe('note.txt')
    writeFileSync(join(f.root, 'note.txt'), 'someone else')
    const manager = new RemoteWorkspaceMutationManager(f.dependencies)
    await assert.rejects(manager.edit(editRequest('note.txt', 'first', 'ours')), /已变化/)
    await assert.rejects(manager.write(writeRequest('note.txt', 'blind')), /请先用 read/)
    await assert.rejects(
      manager.edit({ ...editRequest('note.txt', 'someone else', 'other'), sessionId: 'session-b' }),
      /请先用 read/
    )
    await f.observe('note.txt')
    assert.equal(
      (await manager.edit(editRequest('note.txt', 'someone else', 'ours', 'edit-b'))).status,
      'updated'
    )
    assert.equal(readFileSync(join(f.root, 'note.txt'), 'utf8'), 'ours')
  } finally {
    f.cleanup()
  }
})

test('a changed SSH host alias cannot reuse the previous host read basis', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'note.txt'), 'before')
    await f.observe('note.txt')
    f.setHostAlias('cluster-b')
    const manager = new RemoteWorkspaceMutationManager(f.dependencies)
    await assert.rejects(manager.edit(editRequest('note.txt', 'before', 'after')), /请先用 read/)
    assert.equal(readFileSync(join(f.root, 'note.txt'), 'utf8'), 'before')
    await f.observe('note.txt')
    assert.equal(
      (await manager.edit(editRequest('note.txt', 'before', 'after', 'edit-b'))).status,
      'updated'
    )
  } finally {
    f.cleanup()
  }
})

test('concurrent change during staged transfer is rejected without damaging either version', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'note.txt'), 'before')
    await f.observe('note.txt')
    f.beforeInput(() => writeFileSync(join(f.root, 'note.txt'), 'winner'))
    const manager = new RemoteWorkspaceMutationManager(f.dependencies)
    await assert.rejects(manager.write(writeRequest('note.txt', 'loser')), /已变化/)
    assert.equal(readFileSync(join(f.root, 'note.txt'), 'utf8'), 'winner')
    assert.deepEqual(readdirSync(f.root), ['note.txt'])
  } finally {
    f.cleanup()
  }
})

test('truncated transfer and connection loss preserve the prior file and invalidate uncertain basis', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'note.txt'), 'before')
    await f.observe('note.txt')
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
    const manager = new RemoteWorkspaceMutationManager(f.dependencies)
    await assert.rejects(
      manager.write(writeRequest('note.txt', 'longer replacement')),
      /内容传输不完整/
    )
    assert.equal(readFileSync(join(f.root, 'note.txt'), 'utf8'), 'before')
    assert.deepEqual(readdirSync(f.root), ['note.txt'])
    await f.observe('note.txt')
    f.replaceInput(async () => {
      throw new Error('SSH disconnected')
    })
    const unknown = await manager.edit(editRequest('note.txt', 'before', 'after'))
    assert.equal(unknown.status, 'unknown')
    assert.equal(readFileSync(join(f.root, 'note.txt'), 'utf8'), 'before')
    await assert.rejects(manager.write(writeRequest('note.txt', 'blind', 'write-b')), /请先用 read/)
  } finally {
    f.cleanup()
  }
})

test('cancel closes the in-flight SSH update and leaves its outcome unknown', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'note.txt'), 'before')
    await f.observe('note.txt')
    let release!: () => void
    f.replaceInput(
      () =>
        new Promise<RemoteExecResult>((_resolve, reject) => {
          release = () => reject(new Error('SSH closed'))
        })
    )
    const manager = new RemoteWorkspaceMutationManager(f.dependencies)
    const pending = manager.edit(editRequest('note.txt', 'before', 'after'))
    while (!release) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      manager.cancel({ sessionId: 'session-a', projectId: 'project-a', requestId: 'edit-a' }),
      true
    )
    release()
    assert.equal((await pending).status, 'unknown')
    assert.equal(readFileSync(join(f.root, 'note.txt'), 'utf8'), 'before')
  } finally {
    f.cleanup()
  }
})

test('directories, special files and escaped symlinks are refused', async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'directory'))
    assert.equal(spawnSync('mkfifo', [join(f.root, 'pipe')]).status, 0)
    symlinkSync(join(f.outside, 'file.txt'), join(f.root, 'escape'))
    const manager = new RemoteWorkspaceMutationManager(f.dependencies)
    for (const path of ['directory', 'pipe', 'escape']) {
      await assert.rejects(manager.write(writeRequest(path, 'bad', `write-${path}`)))
      await assert.rejects(manager.edit(editRequest(path, 'old', 'new', `edit-${path}`)))
    }
    assert.equal(existsSync(join(f.outside, 'file.txt')), false)
  } finally {
    f.cleanup()
  }
})

test('a read-only existing file is not replaced through directory write permission', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'readonly.txt'), 'before')
    chmodSync(join(f.root, 'readonly.txt'), 0o444)
    await f.observe('readonly.txt')
    await assert.rejects(
      new RemoteWorkspaceMutationManager(f.dependencies).write(
        writeRequest('readonly.txt', 'after')
      ),
      /不可写/
    )
    assert.equal(readFileSync(join(f.root, 'readonly.txt'), 'utf8'), 'before')
  } finally {
    f.cleanup()
  }
})

test('replace mode refuses ambiguous or missing old text and supports replace_all', () => {
  assert.throws(() => applyRemoteReplace('one two one', 'one', 'x'), /出现多次/)
  assert.throws(() => applyRemoteReplace('one two', 'missing', 'x'), /不匹配/)
  assert.equal(applyRemoteReplace('one two one', 'one', 'x', true), 'x two x')
})

test('ordinary edit tool keeps OMP replace arguments and remote result shape', async () => {
  const tool = buildRemoteWorkspaceEditTool(async () => ({
    status: 'updated',
    path: 'ssh://cluster-a/project/note.txt',
    bytes: 5,
    oldText: 'before',
    newText: 'after',
    diff: '-before\n+after',
    firstChangedLine: 1
  }))
  assert.equal(tool.name, 'edit')
  assert.equal(tool.description, PHI_REMOTE_EDIT_DESCRIPTION)
  const result = await tool.execute(
    'call',
    { path: 'note.txt', old_string: 'before', new_string: 'after' },
    () => undefined,
    {} as never,
    new AbortController().signal
  )
  assert.equal(result.isError, undefined)
  assert.deepEqual(result.details, {
    path: 'ssh://cluster-a/project/note.txt',
    resolvedPath: 'ssh://cluster-a/project/note.txt',
    diff: '-before\n+after',
    firstChangedLine: 1,
    oldText: 'before',
    newText: 'after'
  })
})
