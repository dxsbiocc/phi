import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  OmpBridge,
  OmpBridgeAbortError,
  OmpBridgeTimeoutError
} from '../src/main/agent/engine/omp-bridge'

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

test('worker error detail survives bridge rejection', async () => {
  await withAgentDir(async () => {
    const bridge = newBridge()
    try {
      await assert.rejects(
        bridge.request('test.errorDetail'),
        (error: Error & { detail?: string }) => {
          assert.equal(error.message, 'probe failed')
          assert.equal(error.detail, 'server stderr detail')
          assert.equal(error.stack, 'fixture stack')
          return true
        }
      )
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function spawnFake(agentDir: string): ReturnType<typeof spawn> {
  return spawn(process.execPath, [FAKE_WORKER], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

test('a stdin error rejects pending requests and retires the worker instead of crashing', async () => {
  await withAgentDir(async () => {
    const children: ReturnType<typeof spawn>[] = []
    const bridge = new OmpBridge((_path, agentDir) => {
      const child = spawnFake(agentDir)
      children.push(child)
      return child as never
    })
    try {
      const hung = bridge.request('test.hang')
      const rejection = assert.rejects(hung, /EPIPE/)
      children[0].stdin?.emit('error', new Error('write EPIPE'))
      await rejection
      assert.equal(bridge.hasSession('s1'), false)
      // The retired generation is replaced on the next request.
      await bridge.request('session.create', { sessionId: 's2' })
      assert.equal(children.length, 2)
    } finally {
      await bridge.stop()
    }
  })
})

test('a write to a destroyed worker stdin rejects the request', async () => {
  await withAgentDir(async () => {
    const bridge = new OmpBridge((_path, agentDir) => {
      const child = spawnFake(agentDir)
      child.stdin?.destroy()
      return child as never
    })
    try {
      await assert.rejects(bridge.request('session.create', { sessionId: 's1' }))
    } finally {
      await bridge.stop()
    }
  })
})

test('stop() escalates to SIGKILL when the worker ignores SIGTERM', async () => {
  await withAgentDir(async () => {
    const bridge = newBridge()
    const { pid } = await bridge.request<{ pid: number }>('test.ignoreSigterm')
    assert.equal(isAlive(pid), true)
    const startedAt = Date.now()
    await bridge.stop()
    assert.equal(isAlive(pid), false)
    assert.ok(Date.now() - startedAt < 2000, 'stop stays inside the quit budget')
  })
})

test('request timeout rejects with a typed error and ignores the late response', async () => {
  await withAgentDir(async () => {
    const bridge = newBridge()
    try {
      const slow = bridge.request('test.slow', { delayMs: 150 }, { timeoutMs: 30 })
      await assert.rejects(slow, (error: unknown) => {
        assert.ok(error instanceof OmpBridgeTimeoutError)
        assert.equal(error.method, 'test.slow')
        return true
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      assert.deepEqual(await bridge.request('echo'), null)
    } finally {
      await bridge.stop()
    }
  })
})

test('an aborted signal rejects the request and removes it', async () => {
  await withAgentDir(async () => {
    const bridge = newBridge()
    try {
      const controller = new AbortController()
      const hung = bridge.request('test.hang', undefined, { signal: controller.signal })
      controller.abort()
      await assert.rejects(hung, OmpBridgeAbortError)
      await assert.rejects(
        bridge.request('test.hang', undefined, { signal: controller.signal }),
        OmpBridgeAbortError
      )
    } finally {
      await bridge.stop()
    }
  })
})

test('a timed-out session.abort stops the worker so its sessions fail visibly', async () => {
  await withAgentDir(async () => {
    const bridge = newBridge()
    try {
      await bridge.request('session.create', { sessionId: 's1' })
      await bridge.request('test.hangAbort')
      const prompt = bridge.request('test.hang')
      const promptRejection = assert.rejects(prompt, /OMP worker stopped/)
      await assert.rejects(
        bridge.request('session.abort', { sessionId: 's1' }, { timeoutMs: 50 }),
        OmpBridgeTimeoutError
      )
      await promptRejection
      assert.equal(bridge.hasSession('s1'), false)
    } finally {
      await bridge.stop()
    }
  })
})
