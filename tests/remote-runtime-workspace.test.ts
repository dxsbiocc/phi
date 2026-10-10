import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openRemoteRuntimeWorkspace } from '../src/main/agent/remote-runtime/workspace'
import { createLocalShellSession, installSetsidShim } from './helpers/localShellSession'

test('remote runtime workspace expands a tilde root through the SSH host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-runtime-workspace-'))
  const project = join(root, 'project')
  const home = join(root, 'home')
  const runtime = join(home, '.phi', 'runtime')
  const shim = join(root, 'shim')
  for (const path of [project, runtime, shim]) mkdirSync(path, { recursive: true })
  const previousHome = process.env.HOME
  process.env.HOME = home
  const restoreSetsid = installSetsidShim(shim)
  try {
    const workspace = await openRemoteRuntimeWorkspace(
      {
        runtimeSessionId: 'runtime-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        configuredRoot: '~/.phi/runtime'
      },
      undefined,
      () => ({
        sessionId: 'session-1',
        projectId: 'project-1',
        hostAlias: 'local-bash',
        remoteRoot: realpathSync(project),
        canonicalRoot: realpathSync(project),
        cacheKey: 'local',
        config: {
          remoteRoot: realpathSync(project),
          canonicalRoot: realpathSync(project),
          connect: async () => createLocalShellSession(realpathSync(project))
        }
      })
    )

    assert.equal(workspace.projectRoot, realpathSync(project))
    assert.equal(workspace.runtimeRoot, realpathSync(runtime))
    assert.equal((await workspace.runtimeHost.fs.stat('.')).kind, 'directory')
    await workspace.close?.()
  } finally {
    restoreSetsid()
    process.env.HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
})
