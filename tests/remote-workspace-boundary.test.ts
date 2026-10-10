import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Project } from '../src/main/agent/projects'
import type { RemoteHostProfile } from '../src/main/agent/remote-hosts'
import { ensureRemoteProjectAnchor } from '../src/main/agent/remote-project-anchor'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import { remoteUrlGuardDecision } from '../src/main/agent/agents/remote-url-guard'
import {
  resolveRemoteBashContext,
  resolveAuthorizedRemoteConnectionConfig,
  resolveRemoteWorkspacePath,
  withAuthorizedRemoteWorkspacePath,
  type RemoteWorkspaceBoundaryDependencies
} from '../src/main/agent/remote-workspace-boundary'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'

function fixture(): {
  root: string
  agentDir: string
  project: Project
  manifest: PhiSessionManifest
  commands: string[]
  hosts: string[]
  closed: () => number
  dependencies: RemoteWorkspaceBoundaryDependencies
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-remote-boundary-'))
  const agentDir = join(base, 'phi')
  const root = join(base, 'project')
  mkdirSync(root)
  const project: Project = {
    id: 'project-a',
    name: 'Project A',
    location: {
      kind: 'ssh',
      hostProfileId: 'host-a',
      remoteRoot: root,
      canonicalRoot: realpathSync(root)
    },
    workingDirectory: root,
    workingDirectoryRealPath: realpathSync(root),
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-09-24T00:00:00.000Z'
  }
  const manifest = {
    sessionId: 'session-a',
    kind: 'project',
    projectId: project.id,
    projectLocation: project.location,
    cwd: ensureRemoteProjectAnchor(project.id, agentDir)
  } as PhiSessionManifest
  const commands: string[] = []
  const hosts: string[] = []
  let closeCount = 0
  const dependencies: RemoteWorkspaceBoundaryDependencies = {
    agentDir,
    getManifest: (id) => (id === manifest.sessionId ? manifest : null),
    getProject: (id) => (id === project.id ? project : undefined),
    getHostProfile: (id): RemoteHostProfile | undefined =>
      id === 'host-a' ? { id, label: 'Cluster A', hostAlias: 'cluster-a' } : undefined,
    connectImpl: async (config): Promise<RemoteSshSession> => {
      hosts.push(config.host)
      return {
        exec: async (command) => {
          commands.push(command)
          const result = spawnSync('sh', ['-c', command], {
            encoding: 'utf-8',
            timeout: 3_000,
            maxBuffer: 1_000_000
          })
          return {
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            code: result.status,
            signal: result.signal
          }
        },
        readTextFile: async () => {
          throw new Error('unbounded read is not part of authorization')
        },
        writeTextFile: async () => {
          throw new Error('write is not part of authorization')
        },
        mkdirp: async () => {
          throw new Error('write is not part of authorization')
        },
        exists: async () => {
          throw new Error('extra probe is not part of authorization')
        },
        uploadFile: async () => {
          throw new Error('upload is not part of authorization')
        },
        close: async () => {
          closeCount += 1
        }
      }
    }
  }
  return {
    root,
    agentDir,
    project,
    manifest,
    commands,
    hosts,
    closed: () => closeCount,
    dependencies,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

test('relative and absolute paths resolve to the same SSH project file', async () => {
  const sample = fixture()
  try {
    mkdirSync(join(sample.root, 'data'))
    writeFileSync(join(sample.root, 'data', 'sample.txt'), 'remote data')
    const request = {
      sessionId: sample.manifest.sessionId,
      projectId: sample.project.id,
      path: 'data/sample.txt',
      mode: 'existing'
    }
    const relative = await resolveRemoteWorkspacePath(request, sample.dependencies)
    const absolute = await resolveRemoteWorkspacePath(
      { ...request, path: join(sample.root, 'data', 'sample.txt') },
      sample.dependencies
    )
    assert.equal(relative.path, realpathSync(join(sample.root, 'data', 'sample.txt')))
    assert.equal(relative.path, absolute.path)
    assert.equal(relative.relativePath, 'data/sample.txt')
    assert.deepEqual(sample.hosts, ['cluster-a', 'cluster-a'])
    assert.equal(sample.closed(), 2)
  } finally {
    sample.cleanup()
  }
})

test('two project IDs on different hosts cannot mix even with the same remote path', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'shared.txt'), 'same path')
    const second: Project = {
      ...sample.project,
      id: 'project-b',
      location: {
        kind: 'ssh',
        hostProfileId: 'host-b',
        remoteRoot: sample.root,
        canonicalRoot: realpathSync(sample.root)
      }
    }
    const secondManifest = {
      ...sample.manifest,
      sessionId: 'session-b',
      projectId: second.id,
      projectLocation: second.location,
      cwd: ensureRemoteProjectAnchor(second.id, sample.agentDir)
    } as PhiSessionManifest
    const dependencies: RemoteWorkspaceBoundaryDependencies = {
      ...sample.dependencies,
      getManifest: (id) =>
        id === 'session-a' ? sample.manifest : id === 'session-b' ? secondManifest : null,
      getProject: (id) =>
        id === 'project-a' ? sample.project : id === 'project-b' ? second : undefined,
      getHostProfile: (id) =>
        id === 'host-a'
          ? { id, label: 'Cluster A', hostAlias: 'cluster-a' }
          : id === 'host-b'
            ? { id, label: 'Cluster B', hostAlias: 'cluster-b' }
            : undefined
    }
    const base = { path: 'shared.txt', mode: 'existing' }
    const a = await resolveRemoteWorkspacePath(
      { ...base, sessionId: 'session-a', projectId: 'project-a' },
      dependencies
    )
    const b = await resolveRemoteWorkspacePath(
      { ...base, sessionId: 'session-b', projectId: 'project-b' },
      dependencies
    )
    assert.equal(a.path, b.path)
    assert.equal(a.hostAlias, 'cluster-a')
    assert.equal(b.hostAlias, 'cluster-b')
    await assert.rejects(
      resolveRemoteWorkspacePath(
        { ...base, sessionId: 'session-a', projectId: 'project-b' },
        dependencies
      ),
      /不匹配/
    )
    assert.deepEqual(sample.hosts, ['cluster-a', 'cluster-b'])
  } finally {
    sample.cleanup()
  }
})

test('root escape, dangling symlink, and foreign absolute path fail closed', async () => {
  const sample = fixture()
  try {
    const outside = join(sample.agentDir, 'outside.txt')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(sample.root, 'escape'))
    symlinkSync(join(sample.agentDir, 'missing'), join(sample.root, 'dangling'))
    const base = { sessionId: 'session-a', projectId: 'project-a', mode: 'existing' }
    await assert.rejects(
      resolveRemoteWorkspacePath({ ...base, path: 'escape' }, sample.dependencies),
      /超出项目根目录/
    )
    await assert.rejects(
      resolveRemoteWorkspacePath({ ...base, path: 'dangling' }, sample.dependencies),
      /悬空符号链接/
    )
    await assert.rejects(
      resolveRemoteWorkspacePath({ ...base, path: outside }, sample.dependencies),
      /不属于当前项目/
    )
    await assert.rejects(
      resolveRemoteWorkspacePath({ ...base, path: '../outside.txt' }, sample.dependencies),
      /父目录跳转/
    )
    assert.deepEqual(sample.hosts, ['cluster-a', 'cluster-a'])
    assert.equal(sample.closed(), 2)
  } finally {
    sample.cleanup()
  }
})

test('new file authorization verifies its parent and rejects symlink or existing leaf', async () => {
  const sample = fixture()
  try {
    mkdirSync(join(sample.root, 'data'))
    symlinkSync(join(sample.root, 'data'), join(sample.root, 'inside-parent'))
    const outsideDir = join(sample.agentDir, 'outside-dir')
    mkdirSync(outsideDir)
    symlinkSync(outsideDir, join(sample.root, 'outside-parent'))
    symlinkSync(join(sample.agentDir, 'missing-parent'), join(sample.root, 'dangling-parent'))
    const base = { sessionId: 'session-a', projectId: 'project-a', mode: 'create' }
    const target = await resolveRemoteWorkspacePath(
      { ...base, path: 'inside-parent/new.txt' },
      sample.dependencies
    )
    assert.equal(target.path, join(realpathSync(join(sample.root, 'data')), 'new.txt'))
    await assert.rejects(
      resolveRemoteWorkspacePath({ ...base, path: 'outside-parent/new.txt' }, sample.dependencies),
      /超出项目根目录/
    )
    await assert.rejects(
      resolveRemoteWorkspacePath({ ...base, path: 'dangling-parent/new.txt' }, sample.dependencies),
      /父目录不可访问/
    )
    writeFileSync(join(sample.root, 'data', 'already.txt'), 'existing')
    await assert.rejects(
      resolveRemoteWorkspacePath({ ...base, path: 'data/already.txt' }, sample.dependencies),
      /已存在/
    )
    symlinkSync(join(sample.root, 'missing'), join(sample.root, 'data', 'dangling'))
    await assert.rejects(
      resolveRemoteWorkspacePath({ ...base, path: 'data/dangling' }, sample.dependencies),
      /符号链接/
    )
  } finally {
    sample.cleanup()
  }
})

test('newline and quotes in a file name survive NUL-delimited authorization', async () => {
  const sample = fixture()
  try {
    const name = "line\nwith 'quotes'.txt"
    writeFileSync(join(sample.root, name), 'content')
    const target = await resolveRemoteWorkspacePath(
      { sessionId: 'session-a', projectId: 'project-a', path: name, mode: 'existing' },
      sample.dependencies
    )
    assert.equal(target.path, realpathSync(join(sample.root, name)))
    assert.equal(target.relativePath, name)
  } finally {
    sample.cleanup()
  }
})

test('project and host identity come from Phi state, never request fields', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'x.txt'), 'x')
    const base = { sessionId: 'session-a', projectId: 'project-a', path: 'x.txt', mode: 'existing' }
    await assert.rejects(
      resolveRemoteWorkspacePath({ ...base, projectId: 'project-b' }, sample.dependencies),
      /不匹配/
    )
    await assert.rejects(
      resolveRemoteWorkspacePath({ ...base, host: 'attacker' }, sample.dependencies),
      /只能包含会话、项目、路径和操作类型/
    )
    await assert.rejects(
      resolveRemoteWorkspacePath(
        { ...base, path: 'ssh://attacker/etc/passwd' },
        sample.dependencies
      ),
      /不能传入 ssh:\/\//
    )
    await assert.rejects(
      resolveRemoteWorkspacePath(base, {
        ...sample.dependencies,
        getManifest: () => ({
          ...sample.manifest,
          projectLocation: {
            kind: 'ssh',
            hostProfileId: 'host-b',
            remoteRoot: sample.root,
            canonicalRoot: realpathSync(sample.root)
          }
        })
      }),
      /不匹配/
    )
    assert.deepEqual(sample.hosts, [])
    assert.equal(
      remoteUrlGuardDecision('read', { path: 'ssh://attacker/etc/passwd' }).allowed,
      false
    )
  } finally {
    sample.cleanup()
  }
})

test('SSH changes and offline errors do not turn into local filesystem access', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'x.txt'), 'x')
    const request = {
      sessionId: 'session-a',
      projectId: 'project-a',
      path: 'x.txt',
      mode: 'existing'
    }
    await assert.rejects(
      resolveRemoteWorkspacePath(request, {
        ...sample.dependencies,
        getProject: () => ({
          ...sample.project,
          location: {
            kind: 'ssh',
            hostProfileId: 'host-a',
            remoteRoot: sample.root,
            canonicalRoot: '/other/project'
          }
        })
      }),
      /不匹配/
    )
    await assert.rejects(
      resolveRemoteWorkspacePath(request, {
        ...sample.dependencies,
        connectImpl: async () => {
          throw new Error('SSH offline')
        }
      }),
      /SSH offline/
    )
    assert.deepEqual(sample.commands, [])
  } finally {
    sample.cleanup()
  }
})

test('Bash context pins cwd and states that commands are not file-sandboxed', async () => {
  const sample = fixture()
  try {
    const context = await resolveRemoteBashContext(
      { sessionId: 'session-a', projectId: 'project-a' },
      sample.dependencies
    )
    assert.equal(context.cwd, realpathSync(sample.root))
    assert.equal(context.hostAlias, 'cluster-a')
    assert.match(context.approvalScope, /Shell 命令可访问项目目录之外/)
    await assert.rejects(
      resolveRemoteBashContext(
        { sessionId: 'session-a', projectId: 'project-a', host: 'attacker' },
        sample.dependencies
      ),
      /只能包含会话和项目 ID/
    )
  } finally {
    sample.cleanup()
  }
})

test('authorized operation runs before SSH session closes', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'x.txt'), 'x')
    const result = await withAuthorizedRemoteWorkspacePath(
      { sessionId: 'session-a', projectId: 'project-a', path: 'x.txt', mode: 'existing' },
      async (authorized) => {
        assert.equal(sample.closed(), 0)
        return authorized.relativePath
      },
      sample.dependencies
    )
    assert.equal(result, 'x.txt')
    assert.equal(sample.closed(), 1)
  } finally {
    sample.cleanup()
  }
})

test('notebook SSH configuration is resolved only from its authorized session project', () => {
  const sample = fixture()
  try {
    const dependencies: RemoteWorkspaceBoundaryDependencies = {
      ...sample.dependencies,
      getHostProfile: (id) =>
        id === 'host-a'
          ? {
              id,
              label: 'Cluster A',
              hostAlias: 'cluster-a',
              user: 'notebook-user',
              port: 2222,
              identityFile: '/tmp/phi-notebook-key'
            }
          : undefined
    }
    const authorized = resolveAuthorizedRemoteConnectionConfig(
      { sessionId: 'session-a', projectId: 'project-a' },
      dependencies
    )
    assert.deepEqual(authorized.connection, {
      host: 'cluster-a',
      user: 'notebook-user',
      port: 2222,
      identityFile: '/tmp/phi-notebook-key'
    })
    assert.throws(
      () =>
        resolveAuthorizedRemoteConnectionConfig(
          { sessionId: 'session-a', projectId: 'other-project' },
          dependencies
        ),
      /不匹配/
    )
  } finally {
    sample.cleanup()
  }
})
