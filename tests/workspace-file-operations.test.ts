import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  deleteWorkspaceFile,
  renameWorkspaceFile,
  validateWorkspaceFileOperation
} from '../src/main/workspace-file-operations'
import { ensureRemoteProjectAnchor } from '../src/main/agent/remote-project-anchor'
import type { Project } from '../src/main/agent/projects'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import type { RemoteWorkspaceBoundaryDependencies } from '../src/main/agent/remote-workspace-boundary'
import { createLocalShellSession } from './helpers/localShellSession'
import { remoteWorkspaceUri } from '../src/shared/remoteWorkspacePath'
import {
  downloadRemoteWorkspaceFileToPath,
  validateRemoteWorkspaceDownloadRequest
} from '../src/main/agent/remote-workspace-file-download'
import type { WrapperResultDownloadProgress } from '../src/shared/wrapperResultTypes'

function workspaceFixture(): {
  root: string
  outside: string
  dependencies: RemoteWorkspaceBoundaryDependencies
  local: (path: string) => { kind: 'local'; rootPath: string; path: string }
  remote: (path: string) => { kind: 'remote'; sessionId: string; projectId: string; path: string }
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-workspace-file-'))
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
  const project = { id: 'project-a', location } as Project
  const manifest = {
    sessionId: 'session-a',
    kind: 'project',
    projectId: project.id,
    projectLocation: location,
    cwd: ensureRemoteProjectAnchor(project.id, agentDir)
  } as PhiSessionManifest
  const dependencies: RemoteWorkspaceBoundaryDependencies = {
    agentDir,
    getManifest: (id) => (id === 'session-a' ? manifest : null),
    getProject: (id) => (id === project.id ? project : undefined),
    getHostProfile: (id) =>
      id === 'host-a' ? { id, label: 'Cluster', hostAlias: 'cluster-a' } : undefined,
    connectImpl: async () => createLocalShellSession(root)
  }
  const local = (path: string): { kind: 'local'; rootPath: string; path: string } => ({
    kind: 'local' as const,
    rootPath: root,
    path
  })
  const remote = (
    path: string
  ): { kind: 'remote'; sessionId: string; projectId: string; path: string } => ({
    kind: 'remote' as const,
    sessionId: 'session-a',
    projectId: project.id,
    path
  })
  return {
    root,
    outside,
    dependencies,
    local,
    remote,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

test('local file and directory rename preserve content and reject an existing target', async () => {
  const f = workspaceFixture()
  try {
    const source = join(f.root, 'note.txt')
    writeFileSync(source, 'hello')
    writeFileSync(join(f.root, 'existing.txt'), 'keep')
    await assert.rejects(
      renameWorkspaceFile({ ...f.local(source), newName: 'existing.txt' }),
      /已存在/
    )
    const renamed = await renameWorkspaceFile({ ...f.local(source), newName: '新名称.txt' })
    assert.equal(renamed.path, join(f.root, '新名称.txt'))
    assert.equal(readFileSync(renamed.path, 'utf8'), 'hello')
    assert.equal(existsSync(source), false)
    const directory = join(f.root, 'folder')
    mkdirSync(directory)
    writeFileSync(join(directory, 'child.txt'), 'child')
    const moved = await renameWorkspaceFile({ ...f.local(directory), newName: 'renamed folder' })
    assert.equal(readFileSync(join(moved.path, 'child.txt'), 'utf8'), 'child')
  } finally {
    f.cleanup()
  }
})

test('local delete uses trash and refuses root, traversal and symlink escapes', async () => {
  const f = workspaceFixture()
  const trashed: string[] = []
  const dependencies = {
    trashItem: async (path: string) => {
      trashed.push(path)
    }
  }
  try {
    const source = join(f.root, 'note.txt')
    writeFileSync(source, 'hello')
    await deleteWorkspaceFile(f.local(source), dependencies)
    assert.deepEqual(trashed, [realpathSync(source)])
    symlinkSync(f.outside, join(f.root, 'escape'))
    symlinkSync(source, join(f.root, 'alias.txt'))
    writeFileSync(join(f.outside, 'secret'), 'keep')
    for (const path of [
      f.root,
      join(f.outside, 'secret'),
      join(f.root, 'escape', 'secret'),
      join(f.root, 'alias.txt')
    ]) {
      await assert.rejects(
        deleteWorkspaceFile(f.local(path), dependencies),
        /根目录|目录外|符号链接/
      )
    }
    assert.equal(trashed.length, 1)
    assert.equal(readFileSync(join(f.outside, 'secret'), 'utf8'), 'keep')
  } finally {
    f.cleanup()
  }
})

test('file operations reject extra fields and invalid single names before any side effect', () => {
  for (const newName of [
    '',
    ' ',
    '.',
    '..',
    '../name',
    'a/b',
    'a\\b',
    'a\0b',
    'a\tb',
    'a\nb',
    'a\u007fb',
    '\uFFFD',
    '\ud800',
    '你'.repeat(86)
  ]) {
    assert.throws(
      () =>
        validateWorkspaceFileOperation(
          { kind: 'local', rootPath: '/tmp', path: '/tmp/file', newName },
          true
        ),
      /名称无效/
    )
  }
  assert.throws(
    () =>
      validateWorkspaceFileOperation({ kind: 'local', rootPath: '/tmp', path: '/tmp/../secret' }),
    /绝对路径/
  )
  assert.throws(
    () =>
      validateWorkspaceFileOperation({
        kind: 'remote',
        sessionId: 's',
        projectId: 'p',
        path: '/project/file',
        host: 'attacker'
      }),
    /绝对路径/
  )
})

test('local mutations cannot target canonical remote anchors or directories containing them', async () => {
  const f = workspaceFixture()
  try {
    const agentDir = join(f.root, 'private-phi')
    const anchor = ensureRemoteProjectAnchor('project-a', agentDir)
    const source = join(anchor, 'manifest.json')
    writeFileSync(source, 'private anchor')
    const dependencies = {
      agentDir,
      trashItem: async () => {
        throw new Error('anchor must never be trashed')
      }
    }
    for (const path of [source, anchor, agentDir]) {
      await assert.rejects(deleteWorkspaceFile(f.local(path), dependencies), /锚点/)
      await assert.rejects(
        renameWorkspaceFile({ ...f.local(path), newName: 'renamed' }, dependencies),
        /锚点/
      )
    }
    const alias = join(f.outside, 'alias-root')
    symlinkSync(anchor, alias)
    await assert.rejects(
      deleteWorkspaceFile(
        { kind: 'local', rootPath: alias, path: join(alias, 'manifest.json') },
        dependencies
      ),
      /锚点/
    )
    assert.equal(readFileSync(source, 'utf8'), 'private anchor')
  } finally {
    f.cleanup()
  }
})

test('remote rename safely handles quoted names, rejects overwrites and supports directories', async () => {
  const f = workspaceFixture()
  try {
    const source = join(f.root, "source 'quoted'.txt")
    const newName = "$(touch marker) 'renamed'.txt"
    writeFileSync(source, 'remote bytes')
    const result = await renameWorkspaceFile({ ...f.remote(source), newName }, f.dependencies)
    assert.equal(result.path, remoteWorkspaceUri('cluster-a', join(realpathSync(f.root), newName)))
    assert.equal(readFileSync(join(f.root, newName), 'utf8'), 'remote bytes')
    assert.equal(existsSync(join(f.root, 'marker')), false)
    await assert.rejects(
      renameWorkspaceFile(
        { ...f.remote(join(f.root, newName)), newName: newName },
        { ...f.dependencies, getManifest: () => null }
      ),
      /不匹配/
    )
    writeFileSync(join(f.root, 'existing.txt'), 'keep')
    await assert.rejects(
      renameWorkspaceFile(
        { ...f.remote(join(f.root, newName)), newName: 'existing.txt' },
        f.dependencies
      ),
      /已存在/
    )
    const directory = join(f.root, 'folder')
    mkdirSync(directory)
    writeFileSync(join(directory, 'child'), 'child')
    await renameWorkspaceFile({ ...f.remote(directory), newName: 'new folder' }, f.dependencies)
    assert.equal(readFileSync(join(f.root, 'new folder', 'child'), 'utf8'), 'child')
  } finally {
    f.cleanup()
  }
})

test('remote recursive delete is project-bound and does not follow child symlinks', async () => {
  const f = workspaceFixture()
  const dependencies = {
    ...f.dependencies,
    trashItem: async () => {
      throw new Error('must not use local trash')
    }
  }
  try {
    const folder = join(f.root, 'delete me')
    mkdirSync(folder)
    writeFileSync(join(f.outside, 'keep.txt'), 'keep')
    symlinkSync(f.outside, join(folder, 'outside-link'))
    symlinkSync(f.outside, join(f.root, 'escape'))
    writeFileSync(join(folder, 'child'), 'child')
    for (const path of [f.root, join(f.root, 'escape', 'keep.txt'), join(f.outside, 'keep.txt')]) {
      await assert.rejects(
        deleteWorkspaceFile(f.remote(path), dependencies),
        /根目录|符号链接|不属于/
      )
    }
    await assert.rejects(
      deleteWorkspaceFile({ ...f.remote(folder), sessionId: 'other' }, dependencies),
      /不匹配/
    )
    await deleteWorkspaceFile(f.remote(folder), dependencies)
    assert.equal(existsSync(folder), false)
    assert.equal(readFileSync(join(f.outside, 'keep.txt'), 'utf8'), 'keep')
  } finally {
    f.cleanup()
  }
})

test('remote file download streams exact bytes, verifies SHA-256 and reports shared progress', async () => {
  const f = workspaceFixture()
  try {
    const content = Buffer.alloc(1024 * 1024 + 19, 0x37)
    const source = join(f.root, "report 'quoted'.bin")
    const destination = join(f.outside, 'saved.bin')
    writeFileSync(source, content)
    const { sessionId, projectId, path } = f.remote(source)
    const request = { sessionId, projectId, path }
    const progress: WrapperResultDownloadProgress[] = []
    const result = await downloadRemoteWorkspaceFileToPath(
      { ...request, requestId: 'workspace_download_001' },
      destination,
      { ...f.dependencies, onProgress: (value) => progress.push(value) }
    )
    assert.deepEqual(readFileSync(destination), content)
    assert.equal(result.bytes, content.length)
    assert.equal(result.sha256, `sha256:${createHash('sha256').update(content).digest('hex')}`)
    assert.equal(result.remoteDigestVerified, true)
    assert.ok(progress.some((value) => value.phase === 'downloading'))
    assert.ok(progress.some((value) => value.phase === 'saving'))
    assert.ok(progress.every((value) => value.requestId === 'workspace_download_001'))
  } finally {
    f.cleanup()
  }
})

test('remote download rejects wrong binding, project root, outside symlink and invalid request', async () => {
  const f = workspaceFixture()
  try {
    writeFileSync(join(f.outside, 'secret'), 'private')
    symlinkSync(join(f.outside, 'secret'), join(f.root, 'escape'))
    const destination = join(f.outside, 'must-not-save')
    const download = (
      path: string,
      projectId = 'project-a'
    ): ReturnType<typeof downloadRemoteWorkspaceFileToPath> =>
      downloadRemoteWorkspaceFileToPath(
        { sessionId: 'session-a', projectId, path, requestId: 'workspace_download_002' },
        destination,
        f.dependencies
      )
    await assert.rejects(download(join(f.root, 'escape')), /超出项目/)
    await assert.rejects(download(f.root), /只能下载文件/)
    await assert.rejects(download(join(f.root, 'file'), 'other'), /不匹配/)
    assert.equal(existsSync(destination), false)
    assert.throws(
      () =>
        validateRemoteWorkspaceDownloadRequest({
          sessionId: 's',
          projectId: 'p',
          path: '/project/../secret',
          requestId: 'download_001'
        }),
      /绝对文件路径/
    )
    assert.throws(
      () =>
        validateRemoteWorkspaceDownloadRequest({
          sessionId: 's',
          projectId: 'p',
          path: '/project/file',
          requestId: 'download_001',
          destination: '/tmp/file'
        }),
      /绝对文件路径/
    )
  } finally {
    f.cleanup()
  }
})

test('remote download refuses changed saved connection after SSH authorization and supports abort', async () => {
  const f = workspaceFixture()
  try {
    const source = join(f.root, 'note.txt')
    writeFileSync(source, 'hello')
    const { sessionId, projectId, path } = f.remote(source)
    const request = { sessionId, projectId, path }
    let changed = false
    const connectImpl = f.dependencies.connectImpl!
    const getHostProfile = f.dependencies.getHostProfile!
    const destination = join(f.outside, 'must-not-save')
    await assert.rejects(
      downloadRemoteWorkspaceFileToPath(
        { ...request, requestId: 'workspace_download_003' },
        destination,
        {
          ...f.dependencies,
          getHostProfile: (id, dir) => {
            const profile = getHostProfile(id, dir)
            return changed && profile ? { ...profile, hostAlias: 'new-host' } : profile
          },
          connectImpl: async (config) => {
            const session = await connectImpl(config)
            changed = true
            return session
          }
        }
      ),
      /连接已变化/
    )
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      downloadRemoteWorkspaceFileToPath(
        { ...request, requestId: 'workspace_download_004' },
        destination,
        { ...f.dependencies, signal: controller.signal }
      ),
      { name: 'AbortError' }
    )
    assert.equal(existsSync(destination), false)
  } finally {
    f.cleanup()
  }
})

test('remote workspace download cancellation preserves the chosen local file', async () => {
  const f = workspaceFixture()
  try {
    const source = join(f.root, 'cancel.bin')
    const destination = join(f.outside, 'existing.bin')
    writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 0x37))
    writeFileSync(destination, 'keep existing')
    const controller = new AbortController()
    await assert.rejects(
      downloadRemoteWorkspaceFileToPath(
        {
          sessionId: 'session-a',
          projectId: 'project-a',
          path: source,
          requestId: 'workspace_cancel_001'
        },
        destination,
        {
          ...f.dependencies,
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.phase === 'downloading' && progress.bytesDownloaded > 0) controller.abort()
          }
        }
      ),
      { code: 'ABORTED' }
    )
    assert.equal(controller.signal.aborted, true)
    assert.equal(readFileSync(destination, 'utf8'), 'keep existing')
  } finally {
    f.cleanup()
  }
})
