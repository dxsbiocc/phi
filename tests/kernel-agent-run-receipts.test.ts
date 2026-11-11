import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { AgentCancelledError, type AgentRunRequest } from '../src/main/agent/agents/runner'
import {
  AgentRunRegistry,
  type AgentLaunchInput,
  type AgentRunAdmission,
  type AgentRunSnapshot
} from '../src/main/agent/agents/registry'
import { KernelAgentRunReceiptStore } from '../src/kernel/agent-runs/receipt-store'

function fixture(): { root: string; agentDir: string; sessionDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'phi-agent-receipts-'))
  const agentDir = join(root, 'agent')
  const sessionDir = join(agentDir, 'phi-kernel', 'sessions', 'session-1')
  mkdirSync(sessionDir, { recursive: true })
  return { root, agentDir, sessionDir }
}

function input(requestId: string): AgentLaunchInput {
  return {
    requestId,
    agent: 'PlanStep',
    task: 'Inspect the inputs.',
    runner: async () => ({ text: 'completed', toolCalls: 1 }),
    background: true,
    origin: 'host'
  }
}

function lines(sessionDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(sessionDir, 'agent-runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function writeReceipts(sessionDir: string, receipts: readonly Record<string, unknown>[]): void {
  writeFileSync(
    join(sessionDir, 'agent-runs.jsonl'),
    `${receipts.map((receipt) => JSON.stringify(receipt)).join('\n')}\n`
  )
}

function admissionFor(
  store: KernelAgentRunReceiptStore,
  sessionId = 'session-1'
): AgentRunAdmission {
  return {
    nextRunId: () => store.nextRunId(sessionId),
    accept: (runId, launch) => store.accept(sessionId, runId, launch),
    started: (runId, snapshot) => store.started(sessionId, runId, snapshot),
    unknown: (runId, error) => store.unknown(sessionId, runId, error)
  }
}

test('agent-run admission fsyncs accepted, started and terminal receipts in order', async () => {
  const f = fixture()
  const store = new KernelAgentRunReceiptStore(f.agentDir)
  try {
    await store.openSession('session-1', f.sessionDir)
    const registry = new AgentRunRegistry({
      admission: {
        accept: (runId, launch) => store.accept('session-1', runId, launch),
        started: (runId, snapshot) => store.started('session-1', runId, snapshot),
        unknown: (runId, error) => store.unknown('session-1', runId, error)
      }
    })
    const handle = await registry.start(input('request-1'))
    const finished = await handle.done
    await store.finish('session-1', finished)

    assert.deepEqual(
      lines(f.sessionDir).map((receipt) => receipt.state),
      ['accepted', 'started', 'terminal']
    )
    assert.equal(store.getByRequest('session-1', 'request-1')?.state, 'done')
    assert.equal(statSync(join(f.sessionDir, 'agent-runs.jsonl')).mode & 0o777, 0o600)

    await assert.rejects(
      store.accept('session-1', 'run_duplicate', input('request-1')),
      (error: unknown) => {
        const duplicate = error as { code?: string; detail?: { state?: string } }
        assert.equal(duplicate.code, 'DUPLICATE_REQUEST')
        assert.equal(duplicate.detail?.state, 'done')
        return true
      }
    )
  } finally {
    await store.closeSession('session-1')
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('reopen records accepted-without-started as UNKNOWN once and never retries it', async () => {
  const f = fixture()
  const first = new KernelAgentRunReceiptStore(f.agentDir)
  const second = new KernelAgentRunReceiptStore(f.agentDir)
  const third = new KernelAgentRunReceiptStore(f.agentDir)
  try {
    await first.openSession('session-1', f.sessionDir)
    await first.accept('session-1', 'run_1', input('request-accepted'))
    await first.closeSession('session-1')

    await second.openSession('session-1', f.sessionDir)
    assert.equal(second.getByRequest('session-1', 'request-accepted')?.state, 'unknown')
    assert.deepEqual(
      lines(f.sessionDir).map((receipt) => receipt.state),
      ['accepted', 'terminal']
    )
    await second.closeSession('session-1')

    await third.openSession('session-1', f.sessionDir)
    assert.equal(lines(f.sessionDir).length, 2)
    await assert.rejects(
      third.accept('session-1', 'run_2', input('request-accepted')),
      (error: unknown) => (error as { code?: string }).code === 'DUPLICATE_REQUEST'
    )
  } finally {
    await first.closeSession('session-1')
    await second.closeSession('session-1')
    await third.closeSession('session-1')
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('reopen records started-without-terminal as UNKNOWN and retains its child id', async () => {
  const f = fixture()
  const first = new KernelAgentRunReceiptStore(f.agentDir)
  const second = new KernelAgentRunReceiptStore(f.agentDir)
  try {
    await first.openSession('session-1', f.sessionDir)
    await first.accept('session-1', 'run_1', input('request-started'))
    const snapshot: AgentRunSnapshot = {
      id: 'run_1',
      agent: 'PlanStep',
      task: 'Inspect the inputs.',
      state: 'queued',
      background: true,
      origin: 'host',
      startedAt: Date.now()
    }
    await first.started('session-1', 'run_1', snapshot)
    await first.closeSession('session-1')

    await second.openSession('session-1', f.sessionDir)
    const recovered = second.getByRequest('session-1', 'request-started')
    assert.equal(recovered?.state, 'unknown')
    assert.equal(recovered?.runId, 'run_1')
    assert.deepEqual(
      lines(f.sessionDir).map((receipt) => receipt.state),
      ['accepted', 'started', 'terminal']
    )
  } finally {
    await first.closeSession('session-1')
    await second.closeSession('session-1')
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('cancellation after durable registration records exactly one cancelled terminal', async () => {
  const f = fixture()
  const store = new KernelAgentRunReceiptStore(f.agentDir)
  let request!: AgentRunRequest
  try {
    await store.openSession('session-1', f.sessionDir)
    const registry = new AgentRunRegistry({
      admission: {
        accept: (runId, launch) => store.accept('session-1', runId, launch),
        started: (runId, snapshot) => store.started('session-1', runId, snapshot),
        unknown: (runId, error) => store.unknown('session-1', runId, error)
      }
    })
    const launch = input('request-cancel')
    launch.runner = async (next) => {
      request = next
      return new Promise((_, reject) => {
        next.signal?.addEventListener('abort', () => reject(new AgentCancelledError('PlanStep')))
      })
    }
    const handle = await registry.start(launch)
    assert.ok(request)
    assert.equal(registry.stop(handle.id), true)
    const finished = await handle.done
    await store.finish('session-1', finished)
    await store.finish('session-1', finished)

    assert.equal(finished.state, 'cancelled')
    assert.equal(lines(f.sessionDir).filter((receipt) => receipt.state === 'terminal').length, 1)
  } finally {
    await store.closeSession('session-1')
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('a restarted session continues its persisted run_N sequence', async () => {
  const f = fixture()
  const first = new KernelAgentRunReceiptStore(f.agentDir)
  const second = new KernelAgentRunReceiptStore(f.agentDir)
  try {
    await first.openSession('session-1', f.sessionDir)
    const firstRegistry = new AgentRunRegistry({ admission: admissionFor(first) })
    const firstRun = await firstRegistry.start(input('request-1'))
    assert.equal(firstRun.id, 'run_1')
    await first.finish('session-1', await firstRun.done)
    await first.closeSession('session-1')

    await second.openSession('session-1', f.sessionDir)
    const secondRegistry = new AgentRunRegistry({ admission: admissionFor(second) })
    const secondRun = await secondRegistry.start(input('request-2'))
    assert.equal(secondRun.id, 'run_2')
    await second.finish('session-1', await secondRun.done)

    assert.deepEqual(
      lines(f.sessionDir)
        .map((receipt) => receipt.runId)
        .filter((runId): runId is string => typeof runId === 'string'),
      ['run_1', 'run_1', 'run_2', 'run_2']
    )
  } finally {
    await first.closeSession('session-1')
    await second.closeSession('session-1')
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('a journal that reused a run id across requests still opens', async () => {
  const f = fixture()
  const store = new KernelAgentRunReceiptStore(f.agentDir)
  const at = '2026-11-11T00:00:00.000Z'
  writeReceipts(f.sessionDir, [
    {
      state: 'accepted',
      requestId: 'request-plan',
      agent: 'PlanStep',
      task: 'Plan the work.',
      origin: 'tool',
      background: false,
      at
    },
    { state: 'started', requestId: 'request-plan', runId: 'run_1', startedAt: 1, at },
    { state: 'terminal', requestId: 'request-plan', runId: 'run_1', status: 'done', at },
    {
      state: 'accepted',
      requestId: 'request-visualization',
      agent: 'Visualization',
      task: 'Draw the result.',
      origin: 'tool',
      background: false,
      at
    },
    {
      state: 'started',
      requestId: 'request-visualization',
      runId: 'run_2',
      startedAt: 2,
      at
    },
    {
      state: 'terminal',
      requestId: 'request-visualization',
      runId: 'run_2',
      status: 'cancelled',
      at
    },
    {
      state: 'accepted',
      requestId: 'request-visualization-retry',
      agent: 'Visualization',
      task: 'Draw the result again.',
      origin: 'tool',
      background: false,
      at
    },
    {
      state: 'started',
      requestId: 'request-visualization-retry',
      runId: 'run_1',
      startedAt: 3,
      at
    },
    {
      state: 'terminal',
      requestId: 'request-visualization-retry',
      runId: 'run_1',
      status: 'error',
      at
    }
  ])
  try {
    await store.openSession('session-1', f.sessionDir)

    assert.deepEqual(
      store.list('session-1').map((run) => [run.requestId, run.state]),
      [
        ['request-plan', 'done'],
        ['request-visualization', 'cancelled'],
        ['request-visualization-retry', 'error']
      ]
    )
    // The run index follows the latest start when an old journal reused an id.
    assert.equal(store.getByRun('session-1', 'run_1')?.requestId, 'request-visualization-retry')
    assert.equal(store.getByRun('session-1', 'run_2')?.requestId, 'request-visualization')

    const registry = new AgentRunRegistry({ admission: admissionFor(store) })
    const next = await registry.start(input('request-next'))
    assert.equal(next.id, 'run_3')
    await store.finish('session-1', await next.done)
  } finally {
    await store.closeSession('session-1')
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('repeating a child start for the same request is still rejected', async () => {
  const f = fixture()
  const store = new KernelAgentRunReceiptStore(f.agentDir)
  const at = '2026-11-11T00:00:00.000Z'
  writeReceipts(f.sessionDir, [
    {
      state: 'accepted',
      requestId: 'request-1',
      agent: 'PlanStep',
      task: 'Plan the work.',
      origin: 'tool',
      background: false,
      at
    },
    { state: 'started', requestId: 'request-1', runId: 'run_1', startedAt: 1, at },
    { state: 'started', requestId: 'request-1', runId: 'run_2', startedAt: 2, at }
  ])
  try {
    await assert.rejects(
      store.openSession('session-1', f.sessionDir),
      /agent-run receipt repeats a child start/
    )
  } finally {
    await store.closeSession('session-1')
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('a request is settled when never accepted or terminal, not while it is open', async () => {
  const f = fixture()
  const first = new KernelAgentRunReceiptStore(f.agentDir)
  const second = new KernelAgentRunReceiptStore(f.agentDir)
  try {
    assert.equal(first.requestSettled('session-1', 'anything'), false, 'unopened session')
    await first.openSession('session-1', f.sessionDir)
    await first.accept('session-1', 'run_1', input('request-open'))
    assert.equal(first.requestSettled('session-1', 'request-open'), false)
    assert.equal(first.requestSettled('session-1', 'request-never-accepted'), true)
    await first.closeSession('session-1')

    await second.openSession('session-1', f.sessionDir)
    assert.equal(second.requestSettled('session-1', 'request-open'), true, 'reopen settles it')
  } finally {
    await first.closeSession('session-1')
    await second.closeSession('session-1')
    rmSync(f.root, { recursive: true, force: true })
  }
})
