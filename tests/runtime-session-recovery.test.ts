import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { getOmpBridge } from '../src/main/agent/omp/omp-bridge'
import {
  createRuntimeAgentSession,
  createRuntimeSessionManager
} from '../src/main/agent/runtime/runtime-adapter'

// The bridge spawns `bun`; without it there is no worker to talk to.
const hasBun = spawnSync('bun', ['--version']).status === 0
const FAKE_WORKER = join(process.cwd(), 'tests/helpers/fakeOmpWorker.mjs')

async function withFakeWorker<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'phi-recovery-'))
  const previous = {
    worker: process.env.PHI_OMP_WORKER_PATH,
    agentDir: process.env.PI_CODING_AGENT_DIR
  }
  process.env.PHI_OMP_WORKER_PATH = FAKE_WORKER
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    return await run(dir)
  } finally {
    await getOmpBridge().stop()
    for (const [key, value] of [
      ['PHI_OMP_WORKER_PATH', previous.worker],
      ['PI_CODING_AGENT_DIR', previous.agentDir]
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

test(
  'a prompt after the worker died recreates the session instead of failing "Unknown session"',
  { skip: !hasBun },
  async () => {
    await withFakeWorker(async (dir) => {
      const { session } = await createRuntimeAgentSession({
        cwd: dir,
        sessionManager: createRuntimeSessionManager(dir)
      })
      await session.prompt('first')
      const bridge = getOmpBridge()
      assert.equal(bridge.hasSession(session.runtimeSessionId), true)

      await assert.rejects(bridge.request('crash'))
      assert.equal(bridge.hasSession(session.runtimeSessionId), false)

      await session.prompt('second')
      assert.equal(bridge.hasSession(session.runtimeSessionId), true)
    })
  }
)

test(
  'recovery reopens the session file so the conversation carries over',
  { skip: !hasBun },
  async () => {
    await withFakeWorker(async (dir) => {
      const file = join(dir, 'session.jsonl')
      writeFileSync(file, '{}\n')
      const { session } = await createRuntimeAgentSession({
        cwd: dir,
        sessionManager: createRuntimeSessionManager(dir)
      })
      session.sessionFile = file
      const bridge = getOmpBridge()
      await assert.rejects(bridge.request('crash'))

      await session.prompt('resume')
      const inspected = await bridge.request<{
        sessions: Record<string, { manager?: { kind: string; path?: string } }>
      }>('inspect')
      assert.deepEqual(inspected.sessions[session.runtimeSessionId].manager, {
        kind: 'open',
        cwd: dir,
        path: file
      })
    })
  }
)

test(
  'recovery preserves the main-process Office availability decision',
  { skip: !hasBun },
  async () => {
    await withFakeWorker(async (dir) => {
      const { session } = await createRuntimeAgentSession({
        cwd: dir,
        officeEnabled: true,
        sessionManager: createRuntimeSessionManager(dir)
      })
      const bridge = getOmpBridge()
      await assert.rejects(bridge.request('crash'))
      await session.prompt('resume')

      const inspected = await bridge.request<{
        sessions: Record<string, { officeEnabled?: boolean }>
      }>('inspect')
      assert.equal(inspected.sessions[session.runtimeSessionId].officeEnabled, true)
    })
  }
)

test('concurrent calls on a lost session share one recreation', { skip: !hasBun }, async () => {
  await withFakeWorker(async (dir) => {
    const { session } = await createRuntimeAgentSession({
      cwd: dir,
      sessionManager: createRuntimeSessionManager(dir)
    })
    const bridge = getOmpBridge()
    await assert.rejects(bridge.request('crash'))

    await Promise.all([session.prompt('a'), session.prompt('b')])
    assert.equal(bridge.hasSession(session.runtimeSessionId), true)
  })
})

test(
  'aborting or disposing a session the worker lost is a no-op, not an error',
  { skip: !hasBun },
  async () => {
    await withFakeWorker(async (dir) => {
      const { session } = await createRuntimeAgentSession({
        cwd: dir,
        sessionManager: createRuntimeSessionManager(dir)
      })
      await assert.rejects(getOmpBridge().request('crash'))

      await session.abort()
      await session.dispose()
    })
  }
)
