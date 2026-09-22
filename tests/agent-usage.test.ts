import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AgentRunRegistry } from '../src/main/agent/agents/registry'
import { createAgentRunner, type AgentSessionLike } from '../src/main/agent/agents/runner'
import { AgentUsageCollector, type AgentRunUsageRecord } from '../src/main/agent/agents/usage'
import {
  appendAgentUsageRecord,
  getAgentUsageDir,
  pruneAgentUsageLogs,
  readAgentUsageRecords
} from '../src/main/agent/agents/usage-log'
import { formatUsageReport, summarizeUsage } from '../src/main/agent/agents/usage-report'

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'phi-agent-usage-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A clock that advances 10ms per read, so durations are deterministic. */
function steppedClock(): () => number {
  let value = 1_000
  return () => {
    const current = value
    value += 10
    return current
  }
}

function assistant(usage: Record<string, number>, model = 'claude-test'): unknown {
  return { role: 'assistant', model, usage, content: [] }
}

const USAGE_A = { input: 100, output: 20, cacheRead: 0, cacheWrite: 400, totalTokens: 520 }
const USAGE_B = { input: 30, output: 50, cacheRead: 400, cacheWrite: 10, totalTokens: 490 }

// ── collector ─────────────────────────────────────────────────────────────

test('the collector sums token usage over assistant turns and keeps the first turn as fixed overhead', () => {
  const collector = new AgentUsageCollector({
    agent: 'Database',
    task: 'find TP53',
    clock: steppedClock()
  })
  collector.assistantMessage(assistant(USAGE_A))
  collector.assistantMessage(assistant({ ...USAGE_B, reasoningTokens: 7 }, 'claude-final'))
  collector.assistantMessage({ role: 'assistant' }) // no usage: not a counted turn
  collector.assistantMessage(undefined)

  const record = collector.finish('completed', 'done')
  assert.equal(record.turns, 2)
  assert.deepEqual(record.usage, {
    input: 130,
    output: 70,
    cacheRead: 400,
    cacheWrite: 410,
    reasoning: 7,
    total: 1010
  })
  // What the model was sent on turn one: system prompt + tool schemas + task, cached or not.
  assert.equal(record.firstTurnPromptTokens, 500)
  assert.equal(record.model, 'claude-final')
  assert.equal(record.agent, 'Database')
  assert.equal(record.taskChars, 'find TP53'.length)
  assert.equal(record.reportChars, 'done'.length)
  assert.equal(record.status, 'completed')
})

test('the collector records each tool call by name, argument keys and sizes, never by content', () => {
  const collector = new AgentUsageCollector({ agent: 'Database', task: 't', clock: steppedClock() })
  const args = {
    database: 'rest-json/uniprot',
    domain: 'protein',
    filters: [{ token: 'sk-secretsecret1' }]
  }
  collector.toolStarted('c1', 'db_query', args)
  collector.toolEnded('c1', { resultChars: 4200, isError: false })
  collector.toolStarted('c2', 'db_query', { query: 'x' })
  collector.toolEnded('c2', {
    resultChars: 60,
    isError: true,
    errorText: 'invalid_query: filters 与 rawQuery 不能同时使用。 token=sk-abcdefgh12345678'
  })

  const record = collector.finish('completed', '')
  assert.equal(record.toolCalls, 2)
  assert.equal(record.toolErrors, 1)
  assert.equal(record.toolResultChars, 4260)
  const [first, second] = record.tools
  assert.equal(first.name, 'db_query')
  assert.deepEqual(first.argKeys, ['database', 'domain', 'filters'])
  assert.equal(first.argChars, JSON.stringify(args).length)
  assert.equal(first.resultChars, 4200)
  assert.equal(first.durationMs, 10)
  assert.equal(first.isError, false)
  assert.equal(second.isError, true)
  assert.match(second.errorHead ?? '', /invalid_query/)

  const serialized = JSON.stringify(record)
  assert.ok(!serialized.includes('rest-json/uniprot'), 'argument values must not be recorded')
  assert.ok(!serialized.includes('sk-secretsecret1'))
  assert.ok(!serialized.includes('sk-abcdefgh12345678'), 'error text is redacted')
})

test('a tool that never finished (cancelled run) is recorded as unfinished', () => {
  const collector = new AgentUsageCollector({ agent: 'Wrapper', task: 't', clock: steppedClock() })
  collector.toolStarted('c1', 'wrapper_wait', { run_id: 'wrun_1' })
  const record = collector.finish('cancelled', '')
  assert.equal(record.status, 'cancelled')
  assert.equal(record.tools[0].unfinished, true)
  assert.equal(record.tools[0].durationMs, undefined)
})

test('a very long run keeps the total tool count but caps the per-call list', () => {
  const collector = new AgentUsageCollector({ agent: 'Wrapper', task: 't', clock: steppedClock() })
  for (let index = 0; index < 150; index += 1) {
    collector.toolStarted(`c${index}`, 'read', { path: '/x' })
    collector.toolEnded(`c${index}`, { resultChars: 1, isError: false })
  }
  const record = collector.finish('completed', '')
  assert.equal(record.toolCalls, 150)
  assert.equal(record.toolResultChars, 150)
  assert.equal(record.tools.length, 100)
  assert.equal(record.toolsTruncated, true)
})

// ── runner ────────────────────────────────────────────────────────────────

type Listener = (event: unknown) => void

function fakeSession(options: {
  onPrompt: (emit: Listener) => Promise<void> | void
  message?: unknown
}): AgentSessionLike {
  const listeners = new Set<Listener>()
  const emit: Listener = (event) => listeners.forEach((listener) => listener(event))
  return {
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async prompt() {
      await options.onPrompt(emit)
    },
    async abort() {
      // nothing to stop in a fake session
    },
    async dispose() {
      // nothing to release
    },
    getLastAssistantMessage() {
      return (options.message ?? {
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Report body' }]
      }) as never
    }
  }
}

function scriptedTurns(emit: Listener): void {
  emit({ type: 'message_end', message: assistant(USAGE_A) })
  emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'db_search',
    args: { query: 'p53' }
  })
  emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'db_search',
    result: { content: [{ type: 'text', text: 'x'.repeat(300) }] }
  })
  emit({ type: 'message_end', message: assistant(USAGE_B) })
}

test('the runner reports one usage record per run, tagged with the run id', async () => {
  const records: AgentRunUsageRecord[] = []
  const run = createAgentRunner({
    agent: 'Database',
    createSession: async () => fakeSession({ onPrompt: scriptedTurns }),
    onUsage: (record) => records.push(record),
    clock: steppedClock()
  })

  const result = await run({ task: 'find TP53', runId: 'arun_7' })

  assert.equal(result.text, 'Report body')
  assert.equal(records.length, 1)
  const [record] = records
  assert.equal(record.runId, 'arun_7')
  assert.equal(record.status, 'completed')
  assert.equal(record.turns, 2)
  assert.equal(record.usage.total, 1010)
  assert.equal(record.toolCalls, 1)
  assert.equal(record.tools[0].resultChars, 300)
  assert.equal(record.reportChars, 'Report body'.length)
  assert.ok(record.durationMs > 0)
  assert.ok(!Number.isNaN(Date.parse(record.timestamp)))
})

test('a run that fails, is cancelled or times out still reports its usage', async () => {
  const failed: AgentRunUsageRecord[] = []
  const failRun = createAgentRunner({
    agent: 'Database',
    createSession: async () =>
      fakeSession({
        onPrompt: scriptedTurns,
        message: { stopReason: 'error', errorMessage: 'boom' }
      }),
    onUsage: (record) => failed.push(record)
  })
  await assert.rejects(failRun({ task: 't' }))
  assert.equal(failed.length, 1)
  assert.equal(failed[0].status, 'failed')
  assert.equal(failed[0].turns, 2)

  const controller = new AbortController()
  const cancelled: AgentRunUsageRecord[] = []
  const cancelRun = createAgentRunner({
    agent: 'Wrapper',
    createSession: async () =>
      fakeSession({
        onPrompt: async (emit) => {
          emit({ type: 'message_end', message: assistant(USAGE_A) })
          controller.abort()
        }
      }),
    onUsage: (record) => cancelled.push(record)
  })
  await assert.rejects(cancelRun({ task: 't', signal: controller.signal }))
  assert.equal(cancelled[0].status, 'cancelled')

  const timedOut: AgentRunUsageRecord[] = []
  const timeoutRun = createAgentRunner({
    agent: 'Wrapper',
    timeoutMs: 5,
    createSession: async () =>
      fakeSession({ onPrompt: () => new Promise((resolve) => setTimeout(resolve, 30)) }),
    onUsage: (record) => timedOut.push(record)
  })
  await assert.rejects(timeoutRun({ task: 't' }))
  assert.equal(timedOut[0].status, 'timeout')
})

test('a broken usage sink never breaks the run', async () => {
  const run = createAgentRunner({
    agent: 'Database',
    createSession: async () => fakeSession({ onPrompt: scriptedTurns }),
    onUsage: () => {
      throw new Error('disk full')
    }
  })
  const result = await run({ task: 't' })
  assert.equal(result.text, 'Report body')
})

test('the registry hands each run its own id so usage can be matched to the run card', async () => {
  const registry = new AgentRunRegistry()
  const seen: Array<string | undefined> = []
  const handle = registry.launch({
    agent: 'Database',
    task: 't',
    background: false,
    runner: async (request) => {
      seen.push(request.runId)
      return { text: 'ok', toolCalls: 0 }
    }
  })
  await handle.done
  assert.equal(seen[0], handle.id)
})

// ── log ───────────────────────────────────────────────────────────────────

function sampleRecord(overrides: Partial<AgentRunUsageRecord> = {}): AgentRunUsageRecord {
  return {
    version: 1,
    timestamp: '2026-09-21T08:00:00.000Z',
    agent: 'Database',
    status: 'completed',
    durationMs: 1200,
    taskChars: 40,
    reportChars: 300,
    turns: 3,
    firstTurnPromptTokens: 9000,
    usage: {
      input: 500,
      output: 200,
      cacheRead: 18000,
      cacheWrite: 9000,
      reasoning: 0,
      total: 27700
    },
    toolCalls: 2,
    toolErrors: 1,
    toolResultChars: 5000,
    tools: [
      {
        name: 'db_search',
        argKeys: ['query'],
        argChars: 20,
        resultChars: 4000,
        durationMs: 50,
        isError: false
      },
      {
        name: 'db_query',
        argKeys: ['domain'],
        argChars: 30,
        resultChars: 1000,
        durationMs: 90,
        isError: true,
        errorHead: 'invalid_query'
      }
    ],
    ...overrides
  }
}

test('usage records append as JSONL under the agent dir, one file per day, and read back', () => {
  const { dir, cleanup } = tempDir()
  try {
    const day = new Date('2026-09-21T08:00:00.000Z')
    appendAgentUsageRecord(dir, sampleRecord({ sessionId: 's1' }), day)
    appendAgentUsageRecord(dir, sampleRecord({ agent: 'Wrapper' }), day)
    appendAgentUsageRecord(dir, sampleRecord(), new Date('2026-09-22T08:00:00.000Z'))

    assert.deepEqual(readdirSync(getAgentUsageDir(dir)).sort(), [
      'agent-usage-2026-09-21.jsonl',
      'agent-usage-2026-09-22.jsonl'
    ])
    const records = readAgentUsageRecords(dir)
    assert.equal(records.length, 3)
    assert.equal(records[0].sessionId, 's1')
    assert.deepEqual(
      readAgentUsageRecords(dir, { since: new Date('2026-09-22T00:00:00.000Z') }).length,
      1
    )
  } finally {
    cleanup()
  }
})

test('an unwritable usage dir is swallowed, and a corrupt line is skipped on read', () => {
  const { dir, cleanup } = tempDir()
  try {
    const blocker = join(dir, 'not-a-dir')
    writeFileSync(blocker, 'x')
    assert.doesNotThrow(() => appendAgentUsageRecord(blocker, sampleRecord()))

    appendAgentUsageRecord(dir, sampleRecord(), new Date('2026-09-21T08:00:00.000Z'))
    writeFileSync(
      join(getAgentUsageDir(dir), 'agent-usage-2026-09-21.jsonl'),
      `${JSON.stringify(sampleRecord())}\n{not json\n${JSON.stringify(sampleRecord({ agent: 'Wrapper' }))}\n`
    )
    assert.equal(readAgentUsageRecords(dir).length, 2)
    assert.deepEqual(readAgentUsageRecords(join(dir, 'missing')), [])
  } finally {
    cleanup()
  }
})

test('old usage logs are pruned by their date, other files are left alone', () => {
  const { dir, cleanup } = tempDir()
  try {
    const now = new Date('2026-09-21T12:00:00.000Z')
    appendAgentUsageRecord(dir, sampleRecord(), new Date('2026-07-01T00:00:00.000Z'))
    appendAgentUsageRecord(dir, sampleRecord(), new Date('2026-09-20T00:00:00.000Z'))
    const stray = join(getAgentUsageDir(dir), 'notes.txt')
    writeFileSync(stray, 'keep')
    utimesSync(stray, new Date('2020-01-01'), new Date('2020-01-01'))

    assert.equal(pruneAgentUsageLogs(dir, now), 1)
    assert.deepEqual(readdirSync(getAgentUsageDir(dir)).sort(), [
      'agent-usage-2026-09-20.jsonl',
      'notes.txt'
    ])
    assert.equal(existsSync(stray), true)
    assert.equal(pruneAgentUsageLogs(join(dir, 'missing'), now), 0)
  } finally {
    cleanup()
  }
})

// ── report ────────────────────────────────────────────────────────────────

test('the summary groups runs by agent and by tool', () => {
  const records = [
    sampleRecord(),
    sampleRecord({
      turns: 5,
      status: 'failed',
      firstTurnPromptTokens: 11000,
      usage: {
        input: 1500,
        output: 400,
        cacheRead: 30000,
        cacheWrite: 9000,
        reasoning: 0,
        total: 40900
      },
      toolCalls: 4,
      toolErrors: 2,
      toolResultChars: 9000,
      tools: [
        {
          name: 'db_query',
          argKeys: ['domain'],
          argChars: 30,
          resultChars: 3000,
          durationMs: 90,
          isError: true
        },
        {
          name: 'db_query',
          argKeys: ['domain'],
          argChars: 30,
          resultChars: 6000,
          durationMs: 110,
          isError: false
        }
      ]
    }),
    sampleRecord({ agent: 'Wrapper', turns: 2 })
  ]

  const summary = summarizeUsage(records)
  assert.deepEqual(
    summary.map((item) => item.agent),
    ['Database', 'Wrapper']
  )
  const database = summary[0]
  assert.equal(database.runs, 2)
  assert.deepEqual(database.statuses, { completed: 1, failed: 1 })
  assert.equal(database.meanTurns, 4)
  assert.equal(database.meanToolCalls, 3)
  assert.equal(database.meanFirstTurnPromptTokens, 10000)
  assert.equal(database.meanTokens.total, (27700 + 40900) / 2)
  assert.equal(database.meanTokens.output, 300)

  const dbQuery = database.tools.find((tool) => tool.name === 'db_query')
  assert.ok(dbQuery)
  assert.equal(dbQuery.calls, 3)
  assert.equal(dbQuery.errors, 2)
  assert.equal(dbQuery.meanResultChars, (1000 + 3000 + 6000) / 3)
  // Tools that cost the most result text come first.
  assert.equal(database.tools[0].name, 'db_query')
})

test('the report is readable text and says so when there is nothing to report', () => {
  assert.match(formatUsageReport([]), /no agent runs/i)
  const text = formatUsageReport(summarizeUsage([sampleRecord()]))
  assert.match(text, /Database/)
  assert.match(text, /db_query/)
  assert.match(text, /first turn/i)
})
