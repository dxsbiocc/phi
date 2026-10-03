import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import type { TerminalWorkspaceRef } from '../src/shared/terminalTypes'
import { TerminalError } from '../src/main/terminal/terminal-error'
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
    label: 'Project Alpha'
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
    label: basename('/real/trusted-tasks')
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

test('rejects SSH projects as remote_unsupported before resolving a local directory', () => {
  let realDirectoryCalled = false
  assertTerminalError(
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
          }),
          realDirectory: () => {
            realDirectoryCalled = true
            return '/unexpected'
          }
        })
      ),
    'remote_unsupported'
  )
  assert.equal(realDirectoryCalled, false)
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
    label: 'tasks-real'
  })
  assert.deepEqual(realDirectoryCalls, ['/trusted/tasks'])
})
