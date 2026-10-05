import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { OmpBridge } from '../src/main/agent/omp/omp-bridge'

const FAKE_WORKER = join(process.cwd(), 'tests/helpers/fakeOmpWorker.mjs')

function newBridge(): OmpBridge {
  return new OmpBridge((_workerPath, agentDir) =>
    spawn(process.execPath, [FAKE_WORKER], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: ['pipe', 'pipe', 'pipe']
    })
  )
}

async function withAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-bridge-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    return await run(agentDir)
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(agentDir, { recursive: true, force: true })
  }
}

function readLogEvents(agentDir: string): Array<Record<string, unknown>> {
  const dir = join(agentDir, 'logs')
  try {
    return readdirSync(dir).flatMap((file) =>
      readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    )
  } catch {
    return []
  }
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('a created session is tracked, and lost when the worker exits', async () => {
  await withAgentDir(async () => {
    const bridge = newBridge()
    try {
      await bridge.request('session.create', { sessionId: 's1' })
      assert.equal(bridge.hasSession('s1'), true)

      await assert.rejects(bridge.request('crash'), /OMP worker exited \(3\)/)
      assert.equal(bridge.hasSession('s1'), false)
    } finally {
      await bridge.stop()
    }
  })
})

test('an unexpected worker exit is logged with its stderr; a deliberate stop is not', async () => {
  await withAgentDir(async (agentDir) => {
    const bridge = newBridge()
    await bridge.request('session.create', { sessionId: 's1' })
    await assert.rejects(bridge.request('crash'))
    await waitFor(() => readLogEvents(agentDir).some((e) => e.event === 'omp_worker_exited'))

    const exit = readLogEvents(agentDir).find((e) => e.event === 'omp_worker_exited')
    assert.equal(exit?.level, 'error')
    const metadata = exit?.metadata as { reason: string; lostSessions: number; stderrTail: string }
    assert.equal(metadata.reason, '3')
    assert.equal(metadata.lostSessions, 1)
    assert.match(metadata.stderrTail, /fake worker crashed/)

    await bridge.request('session.create', { sessionId: 's2' })
    await bridge.stop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(readLogEvents(agentDir).filter((e) => e.event === 'omp_worker_exited').length, 1)
  })
})

test('a replaced worker exiting late does not wipe the new worker or fail its requests', async () => {
  await withAgentDir(async () => {
    const bridge = newBridge()
    try {
      const first = await bridge.request<{ pid: number }>('inspect')
      // stop() detaches the old child immediately; its exit event arrives after the next
      // request has already started a replacement.
      const stopping = bridge.stop()
      await bridge.request('session.create', { sessionId: 'kept' })
      const second = await bridge.request<{ pid: number }>('inspect')
      assert.notEqual(second.pid, first.pid)

      await stopping
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(bridge.hasSession('kept'), true)
      await bridge.request('session.prompt', { sessionId: 'kept' })
    } finally {
      await bridge.stop()
    }
  })
})

test('the worker is restarted on demand after it exited', async () => {
  await withAgentDir(async () => {
    const bridge = newBridge()
    try {
      const first = await bridge.request<{ pid: number }>('inspect')
      await assert.rejects(bridge.request('crash'))
      const second = await bridge.request<{ pid: number }>('inspect')
      assert.notEqual(second.pid, first.pid)
    } finally {
      await bridge.stop()
    }
  })
})

test('sanity: the fake worker really forgets sessions across restarts', async () => {
  await withAgentDir(async () => {
    const bridge = newBridge()
    try {
      await bridge.request('session.create', { sessionId: 's1' })
      await assert.rejects(bridge.request('crash'))
      await assert.rejects(
        bridge.request('session.prompt', { sessionId: 's1' }),
        /Unknown session: s1/
      )
    } finally {
      await bridge.stop()
    }
  })
})

test('host requests deliver runtime context separately from tool parameters', async () => {
  await withAgentDir(async () => {
    const bridge = newBridge()
    try {
      bridge.registerHostHandler(
        'office.read',
        (
          params,
          context?: { originSessionId?: string; agentRunId?: string; toolCallId?: string }
        ) => ({
          params,
          context
        })
      )
      const result = await bridge.request('test.hostRequest', {
        method: 'office.read',
        hostParams: { sheet: 'Sheet1', range: 'A1:B3' },
        context: {
          originSessionId: 'runtime-main',
          agentRunId: 'child-run',
          toolCallId: 'tool-apply-1',
          forged: 'ignored'
        }
      })

      assert.deepEqual(result, {
        params: { sheet: 'Sheet1', range: 'A1:B3' },
        context: {
          originSessionId: 'runtime-main',
          agentRunId: 'child-run',
          toolCallId: 'tool-apply-1'
        }
      })
    } finally {
      await bridge.stop()
    }
  })
})
