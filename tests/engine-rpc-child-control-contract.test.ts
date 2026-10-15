import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { controlUntil, rpcChildControlOracle } from './helpers/rpcChildControlOracle'

test(
  'native parallel background children have separate jobs, owner-only waits, and suppressed automatic delivery',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcChildControlOracle()
    t.after(f.close)
    assert.equal((await f.launch()).sessionSettled, false)
    const main = await f.connection.request<{ isStreaming: boolean; hasPendingAsyncWork: boolean }>(
      { type: 'get_state' }
    )
    assert.equal(main.isStreaming, false)
    assert.equal(
      main.hasPendingAsyncWork,
      false,
      'owned acknowledgements suppress automatic wake without stopping children'
    )
    const running = await f.list()
    assert.deepEqual(running.map((child) => child.id).sort(), ['control-a', 'control-b'])
    assert.ok(running.every((child) => child.parentToolCallId === 'parallel-control-task'))
    assert.deepEqual(running.map((child) => child.index).sort(), [0, 1])
    assert.notEqual(running[0].sessionFile, running[1].sessionFile)
    const suppressed = (await f.trace()).filter((entry) => entry.type === 'delivery_suppressed')
    assert.deepEqual(suppressed.map((entry) => entry.id).sort(), ['control-a', 'control-b'])
    assert.ok(suppressed.every((entry) => entry.owner === 'Main' && entry.suppressed === true))
    const trace = await f.trace()
    assert.ok(
      trace.some((entry) => entry.type === 'spawn_preflight' && entry.job === undefined),
      'native speculative preflight can precede manager registration'
    )
    assert.ok(
      trace.findIndex((entry) => entry.type === 'admission_released') <
        trace.findIndex((entry) => entry.type === 'delivery_suppressed')
    )
    const waiting = f.wait('control-a')
    await f.release('control-a')
    assert.equal((await waiting).status, 'completed')
    assert.deepEqual(
      (await f.list()).map((child) => child.id),
      ['control-b']
    )
    const a = await f.messages('control-a')
    assert.match(JSON.stringify(a.messages), /CHILD_A_COMPLETE/)
    await f.release('control-b')
    assert.equal((await f.wait('control-b')).status, 'completed')
    assert.deepEqual(await f.list(), [])
    assert.equal(f.requests.filter((request) => request.actor === 'root').length, 2)
    assert.equal(f.requests.filter((request) => request.actor === 'A').length, 2)
    assert.equal(f.requests.filter((request) => request.actor === 'B').length, 2)
  }
)

test(
  'public targeted steer reaches only its running child while cancelling its peer preserves the parent',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcChildControlOracle()
    t.after(f.close)
    await f.launch()
    await f.connection.request({
      type: 'steer_subagent',
      subagentId: 'control-a',
      message: 'STEER_ONLY_CHILD_A'
    })
    assert.deepEqual(
      await f.connection.request({ type: 'cancel_subagent', subagentId: 'absent-child' }),
      { cancelled: false }
    )
    assert.deepEqual(
      await f.connection.request({ type: 'cancel_subagent', subagentId: 'control-b' }),
      { cancelled: true }
    )
    await controlUntil(
      async () => (await f.list()).every((child) => child.id !== 'control-b'),
      'peer native terminal'
    )
    assert.deepEqual(
      (await f.list()).map((child) => child.id),
      ['control-a']
    )
    await f.release('control-a')
    assert.equal((await f.wait('control-a')).status, 'completed')
    const a = await f.messages('control-a'),
      b = await f.messages('control-b')
    assert.match(JSON.stringify(a.messages), /STEER_ONLY_CHILD_A/)
    assert.doesNotMatch(JSON.stringify(b.messages), /STEER_ONLY_CHILD_A/)
    const parent = await f.connection.request<{ messages: unknown[] }>({ type: 'get_messages' })
    assert.doesNotMatch(JSON.stringify(parent.messages), /STEER_ONLY_CHILD_A/)
    assert.equal(f.requests.filter((request) => request.actor === 'root').length, 2)
    assert.equal(f.requests.filter((request) => request.actor === 'B').length, 1)
    assert.ok(
      f.requests
        .filter((request) => request.actor === 'A')
        .slice(1)
        .some((request) => JSON.stringify(request.messages).includes('STEER_ONLY_CHILD_A'))
    )
    await assert.rejects(
      f.connection.request({
        type: 'steer_subagent',
        subagentId: 'control-a',
        message: 'LATE_STEER_MUST_NOT_REVIVE'
      }),
      /Subagent not running/
    )
  }
)

test(
  'fresh official CLI resume has no live child controls or remembered child transcript authority and performs no replay',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcChildControlOracle()
    t.after(f.close)
    await f.launch()
    const previous = await f.list()
    assert.equal(previous.length, 2)
    const file = previous.find((child) => child.id === 'control-a')!.sessionFile!
    assert.match(await readFile(file, 'utf8'), /INITIAL_CHILD_A/)
    const state = await f.connection.request<{ sessionId: string }>({ type: 'get_state' })
    const count = f.requests.length
    await f.reopen()
    assert.equal(
      (await f.connection.request<{ sessionId: string }>({ type: 'get_state' })).sessionId,
      state.sessionId
    )
    assert.deepEqual(await f.list(), [])
    assert.deepEqual(
      await f.connection.request({ type: 'cancel_subagent', subagentId: 'control-a' }),
      { cancelled: false }
    )
    await assert.rejects(
      f.connection.request({
        type: 'steer_subagent',
        subagentId: 'control-a',
        message: 'COLD_MUST_NOT_REVIVE'
      }),
      /Subagent not running/
    )
    await assert.rejects(
      f.connection.request({ type: 'get_subagent_messages', sessionFile: file }),
      /Unknown subagent session file/
    )
    assert.match(await readFile(file, 'utf8'), /INITIAL_CHILD_A/)
    assert.equal(
      f.requests.length,
      count,
      'cold resume and rejected controls perform no provider work'
    )
  }
)
