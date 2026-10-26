import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'

import { KernelSessionFactory } from '../src/main/agent/engine/kernel-session-factory'
import { SessionRoutingEngine } from '../src/main/agent/engine/session-routing-engine'
import {
  appendSessionEvent,
  createPhiSession,
  deletePhiSession,
  findPhiSessionById,
  listPhiSessions,
  readSessionEvents
} from '../src/main/agent/session/session-store'
import { FakeKernelClient, legacyEngine, params } from './helpers/kernelSessionFactoryFake'

test('rollback drill keeps chats readable with the switch off and resumes them when re-enabled', async (t) => {
  const agentDir = process.env.PI_CODING_AGENT_DIR!
  const local = createPhiSession({
    kind: 'ordinary',
    cwd: '/candidate/local',
    cwdRealPath: '/candidate/local',
    permissionMode: 'auto',
    model: { providerId: 'test', modelId: 'model' }
  })
  const remoteLocation = {
    kind: 'ssh' as const,
    hostProfileId: 'ssh-config:rollback',
    remoteRoot: '/srv/candidate',
    canonicalRoot: '/srv/candidate'
  }
  const remote = createPhiSession({
    kind: 'project',
    projectId: 'rollback-project',
    projectLocation: remoteLocation,
    cwd: '/candidate/remote-anchor',
    cwdRealPath: '/candidate/remote-anchor',
    permissionMode: 'ask',
    model: { providerId: 'test', modelId: 'model' }
  })
  t.after(() => {
    deletePhiSession(local.sessionId)
    deletePhiSession(remote.sessionId)
  })
  const legacyFiles = [local, remote].map((session) => {
    const path = join(session.dir, 'legacy-before-kernel.jsonl')
    const bytes = Buffer.from(`legacy ${session.sessionId}\n`)
    writeFileSync(path, bytes)
    return { path, bytes }
  })

  const client = new FakeKernelClient()
  const makeFactory = (): KernelSessionFactory =>
    new KernelSessionFactory({
      mode: 'both',
      launchLocal: async () => ({
        client,
        greeting: {
          protocol: { major: 1, minor: 0 },
          kernel: { version: '0.1.0', ompVersion: '18.10.3' },
          kernelInstanceId: 'rollback-local',
          controllerGeneration: 1,
          capabilities: [],
          lastSeq: 0,
          runtime: { home: '/candidate/home', agentDir }
        },
        close: async () => undefined
      }),
      launchRemote: async () => ({
        client,
        greeting: {
          protocol: { major: 1, minor: 0 },
          kernel: { version: '0.1.0', ompVersion: '18.10.3' },
          kernelInstanceId: 'rollback-remote',
          controllerGeneration: 1,
          capabilities: [],
          lastSeq: 0,
          runtime: { home: '/srv/phi-home', agentDir: '/srv/phi-home/agent' }
        },
        runtimeRoot: '/srv/phi-runtime',
        close: async () => undefined
      })
    })

  let factory = makeFactory()
  let engine = new SessionRoutingEngine(legacyEngine(), () => factory)
  const createParams = [
    {
      ...params('rollback-local-runtime'),
      agentDir,
      cwd: local.manifest.cwd,
      phiSessionId: local.sessionId
    },
    {
      ...params('rollback-remote-runtime'),
      agentDir,
      cwd: remote.manifest.cwd,
      phiSessionId: remote.sessionId,
      remoteProject: {
        phiSessionId: remote.sessionId,
        projectId: 'rollback-project',
        location: remoteLocation,
        contextFiles: []
      }
    }
  ]
  for (const create of createParams) {
    await engine.sessions.create(create)
    await engine.sessions.prompt({ sessionId: create.sessionId, text: 'candidate result' })
    appendSessionEvent(create.phiSessionId, {
      type: 'assistant_message',
      runId: `${create.sessionId}-run`,
      text: `latest result for ${create.sessionId}`
    })
  }
  assert.equal(findPhiSessionById(local.sessionId)?.kernelRuntimeRef?.host.kind, 'local')
  assert.equal(findPhiSessionById(remote.sessionId)?.kernelRuntimeRef?.host.kind, 'ssh')
  await engine.stop()

  engine = new SessionRoutingEngine(legacyEngine(), () => undefined)
  const listed = listPhiSessions().filter((item) =>
    [local.sessionId, remote.sessionId].includes(item.sessionId)
  )
  assert.equal(listed.length, 2)
  for (const session of [local, remote]) {
    assert.match(String(readSessionEvents(session.sessionId).at(-1)?.text), /latest result/u)
    await assert.rejects(
      engine.history.open({
        agentDir,
        path: `phi-session:${session.sessionId}`,
        cwd: session.manifest.cwd
      }),
      /re-enable the kernel route.*roll back/iu
    )
  }
  for (const file of legacyFiles) assert.deepEqual(readFileSync(file.path), file.bytes)

  factory = makeFactory()
  engine = new SessionRoutingEngine(legacyEngine(), () => factory)
  for (const original of createParams) {
    const reopened = {
      ...original,
      sessionId: `${original.sessionId}-reopened`,
      sessionManager: {
        kind: 'open' as const,
        cwd: original.cwd,
        path: `phi-session:${original.phiSessionId}`
      }
    }
    await engine.sessions.create(reopened)
    await engine.sessions.prompt({
      sessionId: reopened.sessionId,
      text: 'continued after re-enable'
    })
  }
  for (const file of legacyFiles) assert.deepEqual(readFileSync(file.path), file.bytes)
  await engine.stop()
})
