import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import type { TerminalWorkspaceRef } from '../src/shared/terminalTypes'
import { TerminalError } from '../src/main/terminal/terminal-error'
import { shellQuote } from '../src/main/agent/wrappers/remote-ssh-session'
import {
  resolveTerminalWorkspace,
  type TerminalWorkspaceDependencies
} from '../src/main/terminal/terminal-workspace'

function localProject(
  path: string,
  name = 'Project Alpha'
): NonNullable<ReturnType<TerminalWorkspaceDependencies['getProject']>> {
  return {
    name,
    location: { kind: 'local' as const, path, realPath: path }
  }
}

function dependencies(
  overrides: Partial<TerminalWorkspaceDependencies> = {}
): TerminalWorkspaceDependencies {
  return {
    getProject: () => undefined,
    noProjectTaskFolder: () => '/trusted/tasks',
    realDirectory: (path) => path,
    isRemoteAnchor: () => false,
    resolveRemoteWorkspaceHostBinding: () => {
      throw new Error('unexpected remote workspace resolution')
    },
    ...overrides
  }
}

function assertTerminalError(action: () => unknown, code: TerminalError['code']): TerminalError {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof TerminalError)
  assert.equal(caught.code, code)
  assert.ok(caught.message.length > 0)
  return caught
}

test('resolves a local project through realDirectory and preserves project identity', () => {
  const realDirectoryCalls: string[] = []
  const deps = dependencies({
    getProject: (projectId) => (projectId === 'alpha' ? localProject('/display/alpha') : undefined),
    realDirectory: (path) => {
      realDirectoryCalls.push(path)
      return '/real/alpha'
    }
  })

  assert.deepEqual(resolveTerminalWorkspace({ kind: 'project', projectId: 'alpha' }, deps), {
    workspaceKey: 'project:alpha',
    cwd: '/real/alpha',
    label: 'Project Alpha',
    launch: { kind: 'local', localCwd: '/real/alpha' }
  })
  assert.deepEqual(realDirectoryCalls, ['/display/alpha'])
})

test('uses the canonical real directory for a symlinked project root', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-terminal-workspace-'))
  try {
    const target = join(root, 'target')
    const link = join(root, 'link')
    mkdirSync(target)
    symlinkSync(target, link, 'dir')
    const deps = dependencies({
      getProject: () => localProject(link),
      realDirectory: (path) => {
        const realPath = realpathSync(path)
        return statSync(realPath).isDirectory() ? realPath : null
      }
    })

    assert.equal(
      resolveTerminalWorkspace({ kind: 'project', projectId: 'alpha' }, deps).cwd,
      realpathSync(target)
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolves the configured ordinary task folder without creating or replacing it', () => {
  const calls: string[] = []
  const deps = dependencies({
    noProjectTaskFolder: () => '/display/trusted-tasks',
    realDirectory: (path) => {
      calls.push(path)
      return '/real/trusted-tasks'
    }
  })

  assert.deepEqual(resolveTerminalWorkspace({ kind: 'ordinary' }, deps), {
    workspaceKey: 'ordinary',
    cwd: '/real/trusted-tasks',
    label: basename('/real/trusted-tasks'),
    launch: { kind: 'local', localCwd: '/real/trusted-tasks' }
  })
  assert.deepEqual(calls, ['/display/trusted-tasks'])
})

test('returns not_found when a project is not registered', () => {
  assertTerminalError(
    () =>
      resolveTerminalWorkspace(
        { kind: 'project', projectId: 'missing' },
        dependencies({ getProject: () => undefined })
      ),
    'not_found'
  )
})

test('resolves an SSH project to an exact user-initiated ssh -tt launch', () => {
  let userInitiated = false
  const remoteRoot = "/work/-project with space/'quote'/$cash/`tick`/line\nbreak"
  const workspace = resolveTerminalWorkspace(
    { kind: 'project', projectId: 'remote', sessionId: 'session-remote' },
    dependencies({
      getProject: () => ({
        name: 'Remote Project',
        location: {
          kind: 'ssh',
          hostProfileId: 'cluster-profile',
          remoteRoot,
          canonicalRoot: remoteRoot
        }
      }),
      noProjectTaskFolder: () => '/safe/local/tasks',
      realDirectory: (path) => path,
      resolveRemoteWorkspaceHostBinding: (input, options) => {
        assert.deepEqual(input, { sessionId: 'session-remote', projectId: 'remote' })
        userInitiated = options.userInitiated
        return {
          hostAlias: 'cluster-a',
          remoteRoot,
          connection: {
            host: 'cluster-a',
            user: 'researcher',
            port: 2202,
            identityFile: '/keys/id_ed25519',
            userInitiated: true
          }
        }
      },
      sshExecutable: () => '/fake/bin/ssh'
    })
  )

  assert.equal(userInitiated, true)
  assert.equal(workspace.workspaceKey, 'project:remote')
  assert.equal(workspace.cwd, remoteRoot)
  assert.equal(workspace.label, 'cluster-a · Remote Project')
  assert.equal(workspace.launch.kind, 'ssh')
  if (workspace.launch.kind !== 'ssh') throw new Error('expected SSH launch')
  assert.equal(workspace.launch.application, '/fake/bin/ssh')
  assert.equal(workspace.launch.localCwd, '/safe/local/tasks')
  assert.equal(workspace.launch.hostLabel, 'cluster-a')
  assert.deepEqual(workspace.launch.args, [
    '-tt',
    '-l',
    'researcher',
    '-p',
    '2202',
    '-i',
    '/keys/id_ed25519',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    'cluster-a',
    `cd -- ${shellQuote(remoteRoot)} || { printf '%s\\n' '远程项目目录不存在或无法进入，已停止启动终端。' >&2; exit 72; }\nexec "\${SHELL:-/bin/sh}" -il`
  ])
  assert.doesNotMatch(workspace.launch.args.join('\0'), /SendEnv|SetEnv/u)
})

test('requires a bound session for SSH projects without reporting remote_unsupported', () => {
  const error = assertTerminalError(
    () =>
      resolveTerminalWorkspace(
        { kind: 'project', projectId: 'remote' },
        dependencies({
          getProject: () => ({
            name: 'Remote',
            location: {
              kind: 'ssh',
              hostProfileId: 'cluster',
              remoteRoot: '/work/project',
              canonicalRoot: '/work/project'
            }
          })
        })
      ),
    'unavailable'
  )
  assert.doesNotMatch(error.message, /remote_unsupported/u)
})

test('rejects local paths that resolve into a remote project anchor', () => {
  assertTerminalError(
    () =>
      resolveTerminalWorkspace(
        { kind: 'project', projectId: 'remote-anchor' },
        dependencies({
          getProject: () => localProject('/display/anchor'),
          realDirectory: () => '/phi/remote-project-anchors/remote-anchor',
          isRemoteAnchor: (path) => path.startsWith('/phi/remote-project-anchors/')
        })
      ),
    'remote_unsupported'
  )
})

test('returns directory_missing for unavailable project and ordinary directories', () => {
  assertTerminalError(
    () =>
      resolveTerminalWorkspace(
        { kind: 'project', projectId: 'missing-directory' },
        dependencies({
          getProject: () => localProject('/missing/project'),
          realDirectory: () => null
        })
      ),
    'directory_missing'
  )
  assertTerminalError(
    () =>
      resolveTerminalWorkspace({ kind: 'ordinary' }, dependencies({ realDirectory: () => null })),
    'directory_missing'
  )
})

test('ignores renderer-supplied cwd and derives the ordinary workspace from trusted settings', () => {
  const untrustedRef = {
    kind: 'ordinary',
    cwd: '/renderer/injected',
    shell: '/renderer/shell',
    env: { SECRET: 'renderer' },
    workspaceKey: 'project:injected'
  } as unknown as TerminalWorkspaceRef
  const realDirectoryCalls: string[] = []
  const deps = dependencies({
    noProjectTaskFolder: () => '/trusted/tasks',
    realDirectory: (path) => {
      realDirectoryCalls.push(path)
      return '/trusted/tasks-real'
    }
  })

  assert.deepEqual(resolveTerminalWorkspace(untrustedRef, deps), {
    workspaceKey: 'ordinary',
    cwd: '/trusted/tasks-real',
    label: 'tasks-real',
    launch: { kind: 'local', localCwd: '/trusted/tasks-real' }
  })
  assert.deepEqual(realDirectoryCalls, ['/trusted/tasks'])
})
