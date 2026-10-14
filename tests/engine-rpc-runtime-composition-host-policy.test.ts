import assert from 'node:assert/strict'
import test from 'node:test'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { PhiTool, PhiToolApproval } from '../src/main/agent/engine/types'
import type {
  RpcApprovalDecision,
  RpcApprovalEvent
} from '../src/main/agent/engine/rpc/approval-bridge'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Host approval did not arrive')
    await delay(5)
  }
}
test(
  'production raw host write/exec requires real approval; denied/stop/reentrant retirement never executes and live scripts cannot demote risk',
  { timeout: 90_000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    let effects = 0,
      answer: ((decision: RpcApprovalDecision) => void) | undefined,
      classification: PhiToolApproval | undefined = 'read'
    const tools: PhiTool[] = (['write', 'exec'] as const).map((approval) => ({
      name: `desktop_${approval}`,
      site: 'host',
      approval,
      label: `Private ${approval}`,
      description: 'A real temporary effect',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value']
      },
      async execute(_id, input) {
        effects++
        await writeFile(join(f.f.scope.projectRoot, `${input.value}.txt`), 'effect')
        return { content: [{ type: 'text', text: 'effect completed' }] }
      }
    }))
    const events: RpcApprovalEvent[] = []
    let retireAtTerminal = false
    const runtime = await f.create({
      tools,
      hostApprovalFor: () => classification,
      approval: {
        shouldGate: () => true,
        requestToolApproval: () =>
          new Promise((resolve) => {
            answer = resolve
          }),
        onEvent: (event) => {
          events.push(event)
          if (retireAtTerminal && event.type === 'approval_approved') {
            void runtime.stop()
          }
        }
      }
    })
    for (const name of ['desktop_write', 'desktop_exec']) {
      answer = undefined
      await f.sdk.enqueue(
        { tool: { name, args: { value: name }, id: 'same-host-id' } },
        { text: 'effect acknowledged' }
      )
      const before = effects
      const turn = runtime.prompt(`phi-host-approve-${name}`, 'Call the host tool')
      await until(() => !!answer)
      assert.equal(effects, before)
      await assert.rejects(access(join(f.f.scope.projectRoot, `${name}.txt`)))
      assert.equal(events.at(-1)!.type, 'approval_requested')
      assert.equal(events.at(-1)!.request.sessionId, f.f.scope.phiSessionId)
      answer!('approved')
      assert.equal((await turn).outcome, 'completed')
      assert.equal(effects, before + 1)
    }
    answer = undefined
    await f.sdk.enqueue(
      { tool: { name: 'desktop_write', args: { value: 'denied' }, id: 'host-denied' } },
      { text: 'denied acknowledged' }
    )
    const denied = runtime.prompt('phi-host-denied', 'Call denied host tool')
    await until(() => !!answer)
    answer!('denied')
    assert.equal((await denied).outcome, 'failed')
    await assert.rejects(access(join(f.f.scope.projectRoot, 'denied.txt')))
    answer = undefined
    await f.sdk.enqueue({
      tool: { name: 'desktop_exec', args: { value: 'stopped' }, id: 'host-stopped' }
    })
    const stopped = runtime.prompt('phi-host-stopped', 'Call pending host tool')
    await until(() => !!answer)
    await runtime.stop()
    answer!('approved')
    assert.equal((await stopped).outcome, 'aborted')
    await assert.rejects(access(join(f.f.scope.projectRoot, 'stopped.txt')))
    answer = undefined
    classification = 'exec'
    await f.sdk.enqueue(
      { tool: { name: 'desktop_write', args: { value: 'policy-changed' }, id: 'host-policy' } },
      { text: 'policy change acknowledged' }
    )
    const changed = runtime.prompt('phi-host-policy', 'Call host tool with live policy')
    await until(() => !!answer)
    classification = undefined
    answer!('approved')
    assert.equal((await changed).outcome, 'failed')
    await assert.rejects(access(join(f.f.scope.projectRoot, 'policy-changed.txt')))
    classification = 'read'
    answer = undefined
    retireAtTerminal = true
    await f.sdk.enqueue({
      tool: { name: 'desktop_write', args: { value: 'terminal-reentry' }, id: 'host-reentry' }
    })
    const retired = runtime.prompt('phi-host-reentry', 'Stop at terminal observer')
    await until(() => !!answer)
    answer!('approved')
    assert.equal((await retired).outcome, 'aborted')
    await assert.rejects(access(join(f.f.scope.projectRoot, 'terminal-reentry.txt')))
    retireAtTerminal = false
    await f.sdk.enqueue({ text: 'next host run works' })
    assert.equal((await runtime.prompt('phi-host-next', 'Next explicit turn')).outcome, 'completed')
    assert.equal(effects, 2)
  }
)

test(
  'unclassified raw host tool has no launch/provider/effect authority',
  { timeout: 20_000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    let effects = 0
    const tool: PhiTool = {
      name: 'unclassified_host',
      site: 'host',
      label: 'Unclassified',
      description: 'Must not be admitted',
      parameters: { type: 'object', properties: {} },
      async execute() {
        effects++
        return { content: [] }
      }
    }
    await assert.rejects(
      f.create({ tools: [tool] }),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        /explicit trusted approval classification/u.test(error.cause.message)
    )
    assert.equal(effects, 0)
    assert.equal((await f.sdk.snapshot()).providerRequests.length, 0)
    assert.equal(f.leases.length, 0)
    assert.equal(f.adopted.length, 0)
  }
)
