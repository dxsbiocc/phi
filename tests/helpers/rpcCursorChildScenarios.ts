import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { rpcCursorChildFixture } from './rpcCursorChildFixture'
import { createRunId } from '../../src/main/agent/session/session-store'

export type CursorChildMode = 'text' | 'repeat' | 'tool' | 'stop' | 'parallel' | 'queued-stop'
async function until(check: () => boolean, label: string): Promise<void> {
  const started = Date.now()
  while (!check()) {
    assert.ok(Date.now() - started < 15000, label)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
async function childMessages(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { message?: Record<string, unknown> })
    .flatMap((entry) => (entry.message ? [entry.message] : []))
}

/** Production-selected Cursor children, real private authority, actual native gateway and journals. */
export async function runCursorChildScenario(mode: CursorChildMode): Promise<void> {
  const stopping = mode === 'stop' || mode === 'queued-stop'
  const f = await rpcCursorChildFixture(mode === 'parallel', mode === 'queued-stop')
  try {
    const { sessionId, nativeName } = await f.create()
    const count = mode === 'parallel' ? 2 : 1
    f.f.provider.enqueue({
      tool: {
        name: 'task',
        id: 'cursor-child-task',
        args: {
          context: 'Trusted real Cursor child recovery',
          tasks: Array.from({ length: count }, () => ({
            agent: nativeName,
            task: 'Finish the requested private answer.',
            solutionSpace: 'Retain partial output and completed work.'
          }))
        }
      }
    })
    if (!stopping) f.f.provider.enqueue({ text: 'The parent reports the actual child outcome.' })
    if (mode === 'parallel')
      f.cursor.enqueue(
        { text: 'CHILD_PARALLEL_A.', hold: true },
        { text: 'CHILD_PARALLEL_B.', hold: true },
        { text: 'CHILD_FINISHED_A.' },
        { text: 'CHILD_FINISHED_B.' }
      )
    else if (mode === 'repeat')
      f.cursor.enqueue(
        { text: 'CHILD_RETAINED_PARTIAL.', hold: true },
        { text: 'CHILD_SECOND_PARTIAL.', hold: true }
      )
    else if (mode === 'tool')
      f.cursor.enqueue(
        {
          text: 'CHILD_TOOL_PARTIAL.',
          tool: { name: 'todo', args: {}, id: 'child-completed-todo' },
          hold: true
        },
        { text: 'CHILD_TOOL_REMAINDER.' }
      )
    else if (stopping)
      f.cursor.enqueue({
        text: 'CHILD_STOP_PARTIAL.',
        hold: true,
        keepOpen: mode === 'stop'
      })
    else
      f.cursor.enqueue(
        { text: 'CHILD_RETAINED_PARTIAL.', hold: true },
        { text: 'CHILD_REMAINDER.' }
      )
    const run = f.f.runners.startRun({
      sessionId: f.f.phi.sessionId,
      runId: createRunId(),
      execute: async () => {
        await f.f.engine.sessions.prompt({ sessionId, text: 'Delegate the Cursor recovery check.' })
      }
    })
    if (stopping) {
      await until(
        () => f.cursor.requests.length === 1 && f.observedText('CHILD_STOP_PARTIAL.'),
        'real child Cursor partial must be visible before stop'
      )
      if (f.barrier) {
        await until(
          () => existsSync(f.barrier!.ready),
          'real automatic continuation must be queued'
        )
        const ready = JSON.parse(await readFile(f.barrier.ready, 'utf8'))
        assert.deepEqual(
          { queued: ready.queued, ownedCount: ready.ownedCount },
          { queued: true, ownedCount: 1 }
        )
        assert.equal(ready.nativeId, [...f.children.values()][0].nativeId)
        assert.equal(f.cursor.requests.length, 1, 'dequeue barrier must precede the continuation')
      }
      assert.equal(run.outcome, undefined)
      f.f.runners.stopRun(run.sessionId)
      const abort = f.f.engine.sessions.abort({ sessionId })
      void abort.catch(() => undefined)
      // The test releases only after the genuine SDK continuation signal observes production stop.
      if (f.barrier) {
        try {
          await until(
            () => existsSync(f.barrier!.aborted),
            'production stop must abort the SDK dequeue'
          )
        } finally {
          await writeFile(f.barrier.release, '', { mode: 0o600 })
        }
      }
      await abort
      await run.done
      assert.equal(run.outcome, 'stopped')
      assert.equal(f.cursor.requests.length, 1, 'stop must not admit a continuation')
      console.log(
        JSON.stringify({
          mode,
          bundle: f.diagnostics[0],
          stopped: run.outcome,
          owned: [...f.children.values()].map((child) => ({
            verified: child.verified,
            status: child.status
          })),
          lifecycle: f.diagnostics.filter(
            (value) => value && typeof value === 'object' && 'lifecycle' in value
          ),
          journals: await Promise.all(
            [...f.children.values()].map(async (child) => {
              const last = (await childMessages(child.childSessionFile))
                .filter((message) => message.role === 'assistant')
                .at(-1)
              return { stopReason: last?.stopReason, errorMessage: last?.errorMessage }
            })
          )
        })
      )
      assert.ok(
        [...f.children.values()].every((child) => child.verified && child.status === 'aborted')
      )
      if (f.barrier) {
        const shutdown = JSON.parse(await readFile(f.barrier.shutdown, 'utf8'))
        assert.deepEqual(shutdown, { ownedRemaining: false, detached: true })
        for (const child of f.children.values())
          assert.equal(
            (await childMessages(child.childSessionFile)).some(
              (message) => message.customType === 'cursor-stream-continuation'
            ),
            false,
            'a cancelled queued automatic message must never be delivered'
          )
      }
      if (!f.f.engine.sessions.has(sessionId)) {
        f.f.resume()
        await f.f.engine.sessions.create(f.f.params(sessionId))
      }
      assert.equal(f.cursor.requests.length, 1, 'recovery must not flush a stale automatic message')
      f.f.provider.enqueue({ text: 'EXPLICIT_PARENT_AFTER_STOP' })
      const next = f.f.runners.startRun({
        sessionId: run.sessionId,
        runId: createRunId(),
        execute: async () => {
          await f.f.engine.sessions.prompt({
            sessionId,
            text: 'A new explicit request, without delegation.'
          })
        }
      })
      await next.done
      assert.equal(next.outcome, 'completed')
      assert.equal(
        f.cursor.requests.length,
        1,
        'old child must stay stopped after the next explicit prompt'
      )
      assert.equal(f.f.provider.requests.length, 2)
    } else {
      await run.done
      assert.equal(run.outcome, 'completed')
      assert.equal(f.f.provider.requests.length, 2, 'the parent task must never replay')
    }
    assert.equal(f.children.size, count)
    const children = [...f.children.values()]
    assert.equal(new Set(children.map((child) => child.id)).size, count)
    assert.equal(new Set(children.map((child) => child.nativeId)).size, count)
    for (const child of children) {
      assert.equal(child.verified, true)
      assert.equal(child.parentRunId, run.runId)
      assert.equal(child.parentToolCallId, 'cursor-child-task')
      const messages = await childMessages(child.childSessionFile)
      const serialized = JSON.stringify(messages)
      const last = messages.filter((message) => message.role === 'assistant').at(-1)
      if (mode === 'parallel') {
        assert.equal(child.status, 'completed')
        assert.equal(serialized.split('CHILD_PARALLEL_').length - 1, 1)
        assert.match(serialized, /CHILD_FINISHED_[AB]/)
      } else if (mode === 'repeat') {
        assert.equal(child.status, 'failed')
        assert.equal(serialized.split('CHILD_RETAINED_PARTIAL.').length - 1, 1)
        assert.equal(serialized.split('CHILD_SECOND_PARTIAL.').length - 1, 1)
        assert.equal(last?.errorMessage, 'Cursor stream ended before turnEnded')
      } else if (mode === 'tool') {
        assert.equal(child.status, 'completed')
        assert.equal(
          messages.filter(
            (message) =>
              message.role === 'toolResult' && message.toolCallId === 'child-completed-todo'
          ).length,
          1
        )
        assert.match(serialized, /CHILD_TOOL_REMAINDER/)
      } else if (mode === 'text') {
        assert.equal(child.status, 'completed')
        assert.equal(serialized.split('CHILD_RETAINED_PARTIAL.').length - 1, 1)
        assert.match(serialized, /CHILD_REMAINDER/)
      } else if (mode === 'queued-stop') {
        // Stopping before dequeue never emits another assistant message. The
        // owned child is aborted while its original provider EOF stays truthful.
        assert.equal(last?.stopReason, 'error')
        assert.equal(last?.errorMessage, 'Cursor stream ended before turnEnded')
        assert.equal(serialized.split('CHILD_STOP_PARTIAL.').length - 1, 1)
      } else assert.equal(last?.stopReason, 'aborted')
    }
    assert.equal(f.cursor.requests.length, mode === 'parallel' ? 4 : stopping ? 1 : 2)
    console.log(
      JSON.stringify({
        mode,
        verifiedChildren: count,
        cursorRequests: f.cursor.requests.length,
        mainRequests: f.f.provider.requests.length,
        statuses: children.map((child) => child.status),
        productionBundle: f.diagnostics[0]
      })
    )
  } finally {
    if (f.barrier) await writeFile(f.barrier.release, '', { mode: 0o600 })
    await f.close()
  }
}
