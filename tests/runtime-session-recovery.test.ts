import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { getOmpBridge } from '../src/main/agent/engine/omp-bridge'
import { agentRunCompletions } from '../src/main/agent/plan/execution/agent-run-completions'
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
  'aborting or disposing a session the worker lost is a no-op, not an error',
  { skip: !hasBun },
  async () => {
    await withFakeWorker(async (dir) => {
      const { session } = await createRuntimeAgentSession({
        noTools: true,
        cwd: dir,
        sessionManager: createRuntimeSessionManager(dir)
      })
      await assert.rejects(getOmpBridge().request('crash'))

      await session.abort()
      await session.dispose()
    })
  }
)

test(
  'disposing a runtime session abandons pending host-run completions',
  { skip: !hasBun },
  async () => {
    await withFakeWorker(async (dir) => {
      const { session } = await createRuntimeAgentSession({
        noTools: true,
        cwd: dir,
        sessionManager: createRuntimeSessionManager(dir)
      })
      const completion = agentRunCompletions.expect(session.runtimeSessionId, 'plan-step-run')

      await session.dispose()

      assert.deepEqual(await completion, {
        id: 'plan-step-run',
        state: 'cancelled',
        origin: 'host',
        error: 'Runtime session disposed'
      })
    })
  }
)
