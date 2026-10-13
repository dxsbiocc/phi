import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  RpcApprovalDecision,
  RpcApprovalEvent
} from '../src/main/agent/engine/rpc/approval-bridge'
import type { PhiTool } from '../src/main/agent/engine/types'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Composition event did not arrive')
    await delay(5)
  }
}
test(
  'production native write/edit/bash waits for genuine approval; denial and stop have no effect and next run works',
  { timeout: 90_000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    f.beforeLaunch(async (path) => {
      await writeFile(
        join(dirname(path), 'home/.omp/agent/config.yml'),
        JSON.stringify({ edit: { mode: 'replace' }, compaction: { enabled: false } }),
        { mode: 0o600 }
      )
    })
    const events: RpcApprovalEvent[] = []
    let answer: ((decision: RpcApprovalDecision) => void) | undefined
    const runtime = await f.create({
      approval: {
        shouldGate: () => true,
        requestToolApproval: () =>
          new Promise((resolve) => {
            answer = resolve
          }),
        onEvent: (event) => {
          events.push(event)
        }
      }
    })
    const effect = join(f.f.scope.projectRoot, 'effect.txt')
    for (const name of ['write', 'edit', 'bash'] as const) {
      if (name === 'edit') await writeFile(effect, 'before\n')
      const args =
        name === 'write'
          ? { path: 'effect.txt', content: 'after\n' }
          : name === 'edit'
            ? { path: 'effect.txt', old_string: 'before', new_string: 'after' }
            : { command: 'printf bash-after > effect.txt' }
      const before = await readFile(effect, 'utf8').catch(() => undefined)
      answer = undefined
      await f.sdk.enqueue(
        { tool: { name, args, id: 'reused-provider-call' } },
        { text: 'approved complete' }
      )
      const turn = runtime.prompt(`phi-effect-${name}`, `Perform ${name}`)
      await until(() => !!answer)
      assert.equal(await readFile(effect, 'utf8').catch(() => undefined), before)
      const pending = events.at(-1)!
      assert.equal(pending.type, 'approval_requested')
      assert.equal(pending.sessionId, f.f.scope.phiSessionId)
      assert.equal(pending.runId, `phi-effect-${name}`)
      answer!('approved')
      assert.equal((await turn).outcome, 'completed')
      assert.match(await readFile(effect, 'utf8'), name === 'bash' ? /bash-after/ : /after/)
    }
    answer = undefined
    await f.sdk.enqueue(
      { tool: { name: 'write', args: { path: 'denied.txt', content: 'no' }, id: 'denied' } },
      { text: 'denial observed' }
    )
    const denied = runtime.prompt('phi-denied-run', 'write denied file')
    await until(() => !!answer)
    await assert.rejects(access(join(f.f.scope.projectRoot, 'denied.txt')))
    answer!('denied')
    assert.equal((await denied).outcome, 'failed')
    await assert.rejects(access(join(f.f.scope.projectRoot, 'denied.txt')))
    answer = undefined
    await f.sdk.enqueue({
      tool: { name: 'write', args: { path: 'stopped.txt', content: 'no' }, id: 'stopped' }
    })
    const stopped = runtime.prompt('phi-stopped-run', 'wait for approval and stop')
    await until(() => !!answer)
    await runtime.stop()
    assert.equal((await stopped).outcome, 'aborted')
    answer!('approved')
    await assert.rejects(access(join(f.f.scope.projectRoot, 'stopped.txt')))
    assert.equal(runtime.isReady, true)
    await f.sdk.enqueue({ text: 'usable next run' })
    assert.equal((await runtime.prompt('phi-next-run', 'next explicit run')).outcome, 'completed')
  }
)

test(
  'production host bridge hydrates complete large final details and structured errors before checkpoint/history',
  { timeout: 90_000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    const text = Array.from({ length: 360_000 }, (_, i) =>
      String.fromCodePoint(0x4e00 + (i % 20000))
    ).join('')
    assert.ok(Buffer.byteLength(text) > 1024 * 1024)
    f.beforeLaunch(async (path) => {
      await writeFile(
        join(dirname(path), 'home/.omp/agent/config.yml'),
        JSON.stringify({ compaction: { enabled: false } }),
        { mode: 0o600 }
      )
    })
    let error = false
    const tool: PhiTool = {
      name: 'desktop_payload',
      approval: 'read',
      site: 'host',
      label: 'Private payload',
      description: 'Return a private fixture payload',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value']
      },
      async execute(_callId, input, _update, context) {
        assert.equal(input.value, 'expected')
        assert.equal(context.cwd, f.f.scope.projectRoot)
        return {
          content: [{ type: 'text', text }],
          details: {
            exact: text.slice(-1000),
            marker: error ? 'structured error' : 'success details'
          },
          isError: error
        }
      }
    }
    const runtime = await f.create({ tools: [tool] })
    for (const fail of [false, true]) {
      error = fail
      await f.sdk.enqueue(
        {
          tool: {
            name: tool.name,
            args: { value: 'expected', ignored: 'projected away' },
            id: 'reused-host-call'
          }
        },
        { text: 'host result consumed' }
      )
      const turn = await runtime.prompt(`phi-host-${fail}`, 'Call desktop payload once')
      assert.equal(turn.outcome, 'completed')
      const result = turn.snapshot.messages.findLast(
        (value) => (value as { role?: string }).role === 'toolResult'
      ) as { content: Array<{ text: string }>; details: { marker: string }; isError: boolean }
      assert.ok(
        result.content[0].text === text,
        `Exact large host text differs: ${result.content[0].text.slice(0, 200)}`
      )
      assert.equal(result.details.marker, fail ? 'structured error' : 'success details')
      assert.equal(result.isError, fail)
      const request = (await f.sdk.snapshot()).providerRequests.at(-1)!
      assert.ok(JSON.stringify(request.body).includes(text))
      assert.ok(!JSON.stringify(turn.snapshot.messages).includes('phi_host_result_receipt'))
    }
  }
)
