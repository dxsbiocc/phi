import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ensureRemoteProjectAnchor,
  isRemoteProjectAnchorPath,
  remoteProjectAnchorPath
} from '../src/main/agent/remote-project-anchor'
import {
  appendSessionEvent,
  createPhiSession,
  findPhiSessionById,
  readSessionEvents
} from '../src/main/agent/session/session-store'
import { listSessions } from '../src/main/agent/session/sessions'

async function withPhiDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-session-'))
  const agentDir = join(root, 'phi-home')
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    return await run(agentDir)
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
}

test('SSH project IDs get distinct private local anchors without copying project files', async () => {
  await withPhiDir(async (agentDir) => {
    const a = ensureRemoteProjectAnchor('project-a', agentDir)
    const b = ensureRemoteProjectAnchor('project-b', agentDir)
    assert.notEqual(a, b)
    assert.equal(a, remoteProjectAnchorPath('project-a', agentDir))
    assert.equal(statSync(a).mode & 0o777, 0o700)
    assert.equal(statSync(join(agentDir, 'remote-project-anchors')).mode & 0o777, 0o700)
    assert.deepEqual(readdirSync(a), [])
    assert.equal(isRemoteProjectAnchorPath(join(a, 'private-file'), agentDir), true)
    assert.equal(isRemoteProjectAnchorPath(join(agentDir, 'sessions', 'other'), agentDir), false)
    assert.throws(() => ensureRemoteProjectAnchor('../escape', agentDir), /ID 无效/)
  })
})

test('remote session history survives offline with project ID and SSH location intact', async () => {
  await withPhiDir(async (agentDir) => {
    const anchor = ensureRemoteProjectAnchor('project-a', agentDir)
    const location = {
      kind: 'ssh' as const,
      hostProfileId: 'host-a',
      remoteRoot: '/cluster/work',
      canonicalRoot: '/data/work'
    }
    const session = createPhiSession({
      kind: 'project',
      projectId: 'project-a',
      projectLocation: location,
      cwd: anchor,
      cwdRealPath: anchor,
      permissionMode: 'ask'
    })
    appendSessionEvent(session.sessionId, {
      type: 'user_message',
      content: 'offline draft and history',
      runId: 'run-1'
    })
    const restored = findPhiSessionById(session.sessionId)
    assert.equal(restored?.projectId, 'project-a')
    assert.deepEqual(restored?.projectLocation, location)
    assert.equal(restored?.cwd, anchor)
    assert.equal(readSessionEvents(session.sessionId)[0].content, 'offline draft and history')
    assert.equal((await listSessions(anchor))[0]?.phiSessionId, session.sessionId)
    assert.throws(
      () =>
        createPhiSession({
          kind: 'project',
          projectLocation: location,
          cwd: anchor,
          cwdRealPath: anchor,
          permissionMode: 'ask'
        }),
      /绑定项目 ID/
    )
  })
})

test('an existing symlink cannot redirect a private anchor outside Phi', async () => {
  await withPhiDir(async (agentDir) => {
    const outside = mkdtempSync(join(tmpdir(), 'phi-anchor-outside-'))
    try {
      mkdirSync(join(agentDir, 'remote-project-anchors'), { recursive: true })
      symlinkSync(outside, remoteProjectAnchorPath('project-a', agentDir))
      assert.throws(() => ensureRemoteProjectAnchor('project-a', agentDir), /锚点路径无效/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
