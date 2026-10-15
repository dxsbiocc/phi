import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { rpcSessionCompactionOracle } from './helpers/rpcSessionCompactionOracle'

type Oracle = Awaited<ReturnType<typeof rpcSessionCompactionOracle>>

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Expected real compaction boundary was not reached')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function seed(f: Oracle, repeats = 350): Promise<void> {
  f.enqueue(
    { tool: { name: 'read', args: { path: 'retained-source.txt' }, id: 'original-read' } },
    { text: 'The original source was read successfully.' }
  )
  assert.equal(
    (
      await f.connection.prompt(
        'ORIGINAL-ARCHIVE: read the source. ' +
          'alpha beta gamma delta retained source fact 123456789.\n'.repeat(repeats)
      )
    ).status,
    'completed'
  )
  f.enqueue({ text: 'The second source turn is complete.' })
  assert.equal(
    (
      await f.connection.prompt(
        'SECOND-ARCHIVE: preserve these facts. ' +
          'theta lambda omicron actual context 987654321.\n'.repeat(repeats)
      )
    ).status,
    'completed'
  )
  assert.equal((await f.observations()).filter((entry) => entry.type === 'tool_execute').length, 1)
  const result = (await f.messages()).find(
    (message) => (message as Record<string, unknown>).role === 'toolResult'
  ) as Record<string, unknown>
  assert.equal(result.toolCallId, 'original-read')
  assert.equal(result.isError, false, 'the original read must really have completed')
}

function history(messages: unknown[]): unknown[] {
  return messages.map((value) => {
    const message = value as Record<string, unknown>
    return Object.fromEntries(
      ['role', 'content', 'provider', 'model', 'stopReason', 'toolCallId', 'toolName', 'isError']
        .filter((key) => message[key] !== undefined)
        .map((key) => [key, message[key]])
    )
  })
}

test(
  'manual compaction commits a real summary, reduces context, and resumes without tool replay',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcSessionCompactionOracle()
    t.after(() => f.close())
    await seed(f)
    const before = await f.state()
    const oldEntries = await f.journal()
    const requestCount = f.selection.base.provider.requests.length
    const nativeCount = f.requests.length
    const result = await f.compact('Keep the source facts and completed read status')
    const after = await f.state()
    assert.match(result.summary, /Compacted source facts/)
    assert.equal(typeof result.firstKeptEntryId, 'string')
    assert.ok(oldEntries.some((entry) => entry.id === result.firstKeptEntryId))
    assert.ok(Number.isFinite(result.tokensBefore) && result.tokensBefore >= 0)
    assert.ok(after.contextUsage!.tokens < before.contextUsage!.tokens)
    assert.equal(after.contextUsage!.contextWindow, before.contextUsage!.contextWindow)
    assert.equal(after.isCompacting, false)
    assert.equal(after.autoCompactionEnabled, true)
    const entries = await f.journal()
    assert.equal(entries.filter((entry) => entry.type === 'compaction').length, 1)
    assert.equal(entries.findLast((entry) => entry.type === 'compaction')?.summary, result.summary)
    for (const entry of oldEntries) assert.ok(entries.some((retained) => retained.id === entry.id))
    const summaries = f.requests.slice(nativeCount)
    assert.ok(summaries.length >= 2, 'soft compaction may fan out its long and short summaries')
    assert.ok(
      summaries.every((request) => request.summary),
      'idle compaction never restarts the agent'
    )
    assert.equal(f.selection.base.provider.requests.length - requestCount, summaries.length)
    const observations = await f.observations()
    assert.equal(observations.filter((entry) => entry.type === 'session_compact').length, 1)
    assert.equal(observations.filter((entry) => entry.type === 'tool_execute').length, 1)
    assert.equal(
      f.frames.filter((frame) => frame.type === 'auto_compaction_start').length,
      0,
      'manual compaction is observed through its public hook and response'
    )
    const activeHistory = history(await f.messages())
    assert.equal((activeHistory[0] as Record<string, unknown>).role, 'compactionSummary')
    await f.reopen(after.sessionFile)
    const restored = await f.state()
    assert.equal(restored.sessionId, before.sessionId)
    assert.equal(restored.autoCompactionEnabled, true)
    assert.deepEqual(history(await f.messages()), activeHistory)
    assert.equal(
      f.selection.base.provider.requests.length,
      requestCount + summaries.length,
      'fresh resume performs no provider work'
    )
    f.enqueue({ text: 'The next explicit answer used the compacted history.' })
    assert.equal(
      (await f.connection.prompt('NEXT-EXPLICIT: answer from the saved summary.')).status,
      'completed'
    )
    assert.equal(f.selection.base.provider.requests.length, requestCount + summaries.length + 1)
    assert.match(
      JSON.stringify(f.selection.base.provider.requests.at(-1)?.messages),
      /Compacted source facts/
    )
    assert.equal(
      (await f.observations()).filter((entry) => entry.type === 'tool_execute').length,
      1
    )
  }
)

test(
  'raw compact serializes normal control commands until its summary finishes',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcSessionCompactionOracle()
    t.after(() => f.close())
    await seed(f)
    await assert.rejects(
      f.connection.request({ type: 'abort_compaction' }),
      /Unknown command: abort_compaction/
    )
    const release = f.holdSummaries()
    t.after(release)
    const compact = f.compact()
    void compact.catch(() => {})
    await until(() => f.requests.some((request) => request.summary))
    let aborted = false
    let stateRead = false
    const abort = f.connection.abort().then(() => {
      aborted = true
    })
    const state = f.state().then((value) => {
      stateRead = true
      return value
    })
    // This real background command overtakes the serial tail and proves the
    // preceding normal control frames have reached the official dispatcher.
    await f.connection.request({ type: 'btw_cancel', recordId: 'absent-contract-record' })
    assert.equal(aborted, false, 'abort is queued behind raw compact')
    assert.equal(stateRead, false, 'get_state is also queued behind raw compact')
    release()
    await compact
    await abort
    assert.equal((await state).isCompacting, false)
    assert.equal((await f.journal()).filter((entry) => entry.type === 'compaction').length, 1)
  }
)

test(
  'public extension compaction remains cancellable through abort without changing history',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcSessionCompactionOracle()
    t.after(() => f.close())
    await seed(f)
    const before = history(await f.messages())
    const count = f.requests.length
    f.summary({ text: 'held real summary', hold: true })
    const compact = f.extensionCompact()
    void compact.catch(() => {})
    await until(() => f.requests.slice(count).some((request) => request.summary))
    assert.equal((await f.state()).isCompacting, true)
    await assert.rejects(
      f.connection.request({ type: 'abort_compaction' }),
      /Unknown command: abort_compaction/
    )
    await f.connection.abort()
    const stoppedCount = f.requests.length
    const result = await compact
    assert.equal(
      result.status,
      'completed',
      'ctx.compact reports errors through callbacks rather than failing its slash-command result'
    )
    assert.equal(result.agentInvoked, false)
    const observations = await f.observations()
    assert.equal(
      observations.filter((entry) => entry.type === 'extension_compact_completed').length,
      0
    )
    const error = observations.findLast((entry) => entry.type === 'extension_compact_error')
    assert.equal(error?.name, 'Error')
    assert.equal(
      error?.message,
      'Interrupted by user',
      'the public callback does not preserve a typed cancellation sentinel'
    )
    assert.equal((await f.state()).isCompacting, false)
    assert.equal(
      f.requests.length,
      stoppedCount,
      'no summary retry is dispatched after abort acknowledges'
    )
    assert.deepEqual(history(await f.messages()), before)
    assert.equal((await f.journal()).filter((entry) => entry.type === 'compaction').length, 0)
    assert.ok(
      f.requests.slice(count).every((request) => request.summary),
      'cancel does not dispatch a user turn'
    )
    assert.equal(
      (await f.observations()).filter((entry) => entry.type === 'tool_execute').length,
      1
    )
  }
)

test(
  'raw busy compact interrupts and resumes a live turn, requiring Phi to own busy admission',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcSessionCompactionOracle()
    t.after(() => f.close())
    await seed(f)
    const count = f.requests.length
    f.enqueue({ text: 'held live answer', hold: true })
    const prompt = f.connection.prompt('BUSY-RAW: keep this current turn open.')
    void prompt.catch(() => {})
    await until(() => f.requests.length === count + 1)
    assert.equal((await f.state()).isStreaming, true)
    f.enqueue({ text: 'The interrupted turn resumed automatically after compaction.' })
    await f.compact()
    assert.equal(
      (await prompt).status,
      'completed',
      'the SDK completes the original prompt ticket after its automatic continuation'
    )
    await until(() => f.requests.slice(count).filter((request) => !request.summary).length === 2)
    await until(async () => (await f.state()).isSettled)
    assert.ok(f.requests.slice(count).filter((request) => request.summary).length >= 2)
    assert.equal(
      (await f.observations()).filter((entry) => entry.type === 'tool_execute').length,
      1
    )
  }
)

test(
  'automatic maintenance emits a threshold boundary and commits summaries with maintenance enabled',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcSessionCompactionOracle()
    t.after(() => f.close())
    await seed(f, 700)
    await f.policy(70)
    const before = await f.state()
    assert.equal(before.autoCompactionEnabled, true)
    assert.ok(before.contextUsage!.percent < 70)
    const count = f.requests.length
    const start = f.frames.length
    f.enqueue({ text: 'The explicit threshold-crossing answer is complete.' })
    assert.equal(
      (
        await f.connection.prompt(
          'CROSS-THRESHOLD: ' + 'tau sigma actual additional retained data 123456789.\n'.repeat(400)
        )
      ).status,
      'completed'
    )
    await until(async () => (await f.journal()).some((entry) => entry.type === 'compaction'))
    await until(async () => (await f.state()).isSettled)
    const events = f.frames.slice(start)
    const beginning = events.findIndex((frame) => frame.type === 'auto_compaction_start')
    const ending = events.findIndex(
      (frame) => frame.type === 'auto_compaction_end' && frame.result !== undefined
    )
    assert.ok(beginning >= 0 && ending > beginning)
    assert.equal(events[beginning].reason, 'threshold')
    assert.equal(events[beginning].action, 'context-full')
    assert.equal(events[ending].aborted, false)
    assert.equal(events[ending].willRetry, false)
    assert.equal(
      f.requests.slice(count).filter((request) => !request.summary).length,
      1,
      'only the explicit user turn invokes the agent'
    )
    const summaries = f.requests.slice(count).filter((request) => request.summary)
    assert.ok(summaries.length >= 2, 'automatic soft compaction performs genuine summary requests')
    const after = await f.state()
    assert.equal(after.autoCompactionEnabled, true)
    assert.ok(after.contextUsage!.percent < 70)
    assert.equal(
      (await f.observations()).filter((entry) => entry.type === 'tool_execute').length,
      1
    )
    await f.reopen(after.sessionFile)
    assert.equal((await f.state()).sessionId, before.sessionId)
    assert.equal(
      f.requests.length,
      count + summaries.length + 1,
      'journal resume does not replay maintenance or tools'
    )
  }
)

test(
  'auto-compaction toggles are transient; private startup percentages survive journal rotation',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcSessionCompactionOracle()
    t.after(() => f.close())
    const before = await f.state()
    const originalConfig = await readFile(join(f.selection.base.agentDir, 'config.yml'), 'utf8')
    await f.connection.request({ type: 'set_auto_compaction', enabled: false })
    assert.equal((await f.state()).autoCompactionEnabled, false)
    assert.equal(
      await readFile(join(f.selection.base.agentDir, 'config.yml'), 'utf8'),
      originalConfig
    )
    assert.equal((await f.journal()).filter((entry) => entry.type === 'compaction').length, 0)
    await f.reopen(before.sessionFile)
    assert.equal(
      (await f.state()).autoCompactionEnabled,
      true,
      'raw toggle is not persisted in the SDK journal'
    )
    await f.connection.request({ type: 'set_auto_compaction', enabled: true })
    assert.equal((await f.state()).autoCompactionEnabled, true)
    for (const percent of [70, 80, 90] as const) {
      const observation = await f.policy(percent)
      const configured = observation.configuredPolicy as Record<string, unknown>
      assert.equal(
        configured.thresholdPercent,
        percent,
        'this is an authored startup policy snapshot, not a generic effective getter'
      )
      assert.equal(configured.thresholdTokens, -1)
      assert.deepEqual(configured.methodOrder, ['soft'])
      assert.equal(observation.autoCompactionEnabled, true)
      assert.equal((await f.state()).sessionId, before.sessionId)
    }
    assert.equal(
      f.selection.base.provider.requests.length,
      1,
      'policy rotation performs no new model work'
    )
    assert.equal(f.requests.length, 0)
  }
)
