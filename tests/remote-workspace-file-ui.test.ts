import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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
  listRemoteWorkspaceDirectory,
  previewRemoteWorkspaceFile
} from '../src/main/agent/remote-workspace-file-ui'
import type { RemoteWorkspaceBoundaryDependencies } from '../src/main/agent/remote-workspace-boundary'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'

function fixture(): {
  root: string
  outside: string
  anchor: string
  dependencies: RemoteWorkspaceBoundaryDependencies
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-remote-file-ui-'))
  const root = join(base, 'project')
  const outside = join(base, 'outside')
  const agentDir = join(base, 'phi')
  mkdirSync(root)
  mkdirSync(outside)
  const canonicalRoot = realpathSync(root)
  const location = {
    kind: 'ssh' as const,
    hostProfileId: 'host-a',
    remoteRoot: root,
    canonicalRoot
  }
  const project = {
    id: 'project-a',
    name: 'Remote',
    location,
    workingDirectory: root,
    workingDirectoryRealPath: canonicalRoot,
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-09-24T00:00:00Z'
  } as Project
  const anchor = ensureRemoteProjectAnchor(project.id, agentDir)
  const manifest = {
    sessionId: 'session-a',
    kind: 'project',
    projectId: project.id,
    projectLocation: location,
    cwd: anchor
  } as PhiSessionManifest
  const dependencies: RemoteWorkspaceBoundaryDependencies = {
    agentDir,
    getManifest: (id) => (id === manifest.sessionId ? manifest : null),
    getProject: (id) => (id === project.id ? project : undefined),
    getHostProfile: (id) =>
      id === 'host-a' ? { id, label: 'Cluster A', hostAlias: 'cluster-a' } : undefined,
    connectImpl: async (): Promise<RemoteSshSession> => ({
      exec: async (command) => {
        const result = spawnSync('bash', ['-c', command], {
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
      },
      readTextFile: async () => {
        throw new Error('unbounded read not allowed')
      },
      writeTextFile: async () => {
        throw new Error('write not allowed')
      },
      mkdirp: async () => {
        throw new Error('not used')
      },
      exists: async () => {
        throw new Error('not used')
      },
      uploadFile: async () => {
        throw new Error('not used')
      },
      close: async () => undefined
    })
  }
  return {
    root,
    outside,
    anchor,
    dependencies,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

function request(path: string): { sessionId: string; projectId: string; path: string } {
  return { sessionId: 'session-a', projectId: 'project-a', path }
}

test('remote file sidebar maps T02 directory entries into SSH URIs and bounded text preview', async () => {
  const f = fixture()
  try {
    const nested = join(f.root, 'sub')
    mkdirSync(nested)
    writeFileSync(join(nested, "line\n'quote'.txt"), 'α\nβ')
    const root = await listRemoteWorkspaceDirectory(request('.'), f.dependencies)
    assert.equal(root.rootPath, `ssh://cluster-a${realpathSync(f.root)}`)
    assert.equal(root.rootLabel, 'cluster-a')
    assert.equal(root.entries[0]?.kind, 'directory')
    const child = await listRemoteWorkspaceDirectory(request('sub'), f.dependencies)
    assert.equal(child.entries.length, 1)
    assert.match(child.entries[0].path, /line%0A'quote'\.txt/)
    const preview = await previewRemoteWorkspaceFile(
      request("sub/line\n'quote'.txt"),
      f.dependencies
    )
    assert.equal(preview.kind, 'text')
    assert.equal(preview.content, 'α\nβ')
    assert.equal(preview.bytes, 5)
    assert.equal(preview.truncated, false)
    assert.equal(readFileSync(join(nested, "line\n'quote'.txt"), 'utf8'), 'α\nβ')
    assert.equal(preview.path.startsWith('ssh://cluster-a/'), true)
  } finally {
    f.cleanup()
  }
})

test('remote UI read rejects wrong project, raw SSH URL, escape link and binary content', async () => {
  const f = fixture()
  try {
    symlinkSync(f.outside, join(f.root, 'escape'))
    writeFileSync(join(f.root, 'binary.dat'), Buffer.from([0, 1, 2]))
    await assert.rejects(
      previewRemoteWorkspaceFile({ ...request('binary.dat'), projectId: 'other' }, f.dependencies),
      /会话与项目不匹配/
    )
    await assert.rejects(
      previewRemoteWorkspaceFile(request('ssh://cluster-a/project/file'), f.dependencies),
      /不能传入 ssh:\/\//
    )
    await assert.rejects(
      listRemoteWorkspaceDirectory(request('escape'), f.dependencies),
      /超出项目根目录/
    )
    await assert.rejects(
      previewRemoteWorkspaceFile(request('binary.dat'), f.dependencies),
      /二进制/
    )
    await assert.rejects(
      listRemoteWorkspaceDirectory(request('binary.dat'), f.dependencies),
      /不是目录/
    )
  } finally {
    f.cleanup()
  }
})
