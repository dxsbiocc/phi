import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONFIGURATION_FOREIGN_RULE,
  CONFIGURATION_PERSONA,
  CONFIGURATION_PROJECT_RULE,
  CONFIGURATION_REMOTE_ROOT,
  rpcSessionConfigurationOracle
} from './helpers/rpcSessionConfigurationOracle'

type Oracle = Awaited<ReturnType<typeof rpcSessionConfigurationOracle>>

function system(f: Oracle, index: number): string {
  const request = f.selection.base.provider.requests[index]
  assert.ok(request, 'the real provider must have received this explicit turn')
  return request.messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    )
    .join('\n')
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1
}

function persistentHistory(messages: unknown[]): unknown[] {
  return messages.map((value) => {
    const message = value as Record<string, unknown>
    return Object.fromEntries(
      ['role', 'content', 'provider', 'model', 'stopReason', 'toolCallId', 'toolName', 'isError']
        .filter((key) => message[key] !== undefined)
        .map((key) => [key, message[key]])
    )
  })
}

function assertPhiContext(f: Oracle, index: number): void {
  const actual = system(f, index)
  assert.equal(occurrences(actual, '§ Phi Role'), 1)
  assert.equal(occurrences(actual, CONFIGURATION_PERSONA), 1)
  assert.equal(occurrences(actual, CONFIGURATION_PROJECT_RULE), 1)
  assert.equal(occurrences(actual, '<phi_user_persona>'), 1)
  assert.equal(occurrences(actual, '<repo-rules>'), 1)
  assert.ok(actual.includes(CONFIGURATION_REMOTE_ROOT))
  assert.ok(!actual.includes(f.selection.base.cwd), 'the local journal anchor is not the workspace')
  assert.ok(!actual.includes(CONFIGURATION_FOREIGN_RULE), 'implicit disk sources remain excluded')
  assert.ok(!actual.includes('Helpful, trusted assistant for load-bearing changes in Oh My Pi'))
}

test(
  'public context discovery lets a higher priority source shadow same-depth standalone AGENTS',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcSessionConfigurationOracle({ injectPhi: false })
    t.after(() => f.close())
    assert.equal(
      (await f.prompt('DISCOVERY-CONTRACT: inspect the configured context.')).status,
      'completed'
    )
    const actual = system(f, 0)
    assert.equal(occurrences(actual, CONFIGURATION_PROJECT_RULE), 0)
    assert.equal(occurrences(actual, CONFIGURATION_FOREIGN_RULE), 1)
    assert.ok(actual.includes('<repo-rules>'))
    const observed = (await f.observations()).find((entry) => entry.type === 'before_agent_start')
    assert.ok(observed)
    assert.deepEqual(observed.current, observed.base)
    assert.ok(observed.base?.some((block) => block.includes(CONFIGURATION_FOREIGN_RULE)))
  }
)

test(
  'public prompt construction replaces implicit context with Phi persona and trusted project rules exactly once',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcSessionConfigurationOracle({ injectPhi: true })
    t.after(() => f.close())
    assert.equal(
      (await f.prompt('PHI-CONTEXT-CONTRACT: answer the research question.')).status,
      'completed'
    )
    assertPhiContext(f, 0)
    const observed = (await f.observations()).find((entry) => entry.type === 'before_agent_start')
    assert.ok(observed)
    assert.ok(observed.base?.some((block) => block.includes(CONFIGURATION_FOREIGN_RULE)))
    const rebuilt = (await f.observations()).find((entry) => entry.type === 'trusted_rebuild')
    assert.ok(rebuilt)
    const base = rebuilt.base?.join('\n') ?? ''
    assert.ok(base.length > 0, 'the real public SDK builder supplies the operational prompt')
    assert.equal(occurrences(base, CONFIGURATION_PROJECT_RULE), 1)
    assert.ok(!base.includes(CONFIGURATION_FOREIGN_RULE))
    assert.ok(!base.includes(CONFIGURATION_PERSONA))
    assert.deepEqual(observed.current, observed.base)
    assert.equal(f.selection.base.provider.requests.length, 1)
  }
)

test(
  'Phi prompt replacement survives public reload, model selection, and journal resume without replay',
  { timeout: 45000 },
  async (t) => {
    const f = await rpcSessionConfigurationOracle({ injectPhi: true })
    t.after(() => f.close())
    assert.equal((await f.prompt('FIRST-CONFIGURED-TURN')).status, 'completed')
    const state = await f.selection.state()
    const initialMessages = await f.selection.messages()
    assert.equal(
      initialMessages.filter((message) => (message as Record<string, unknown>).role === 'user')
        .length,
      1
    )
    await f.reload()
    assert.equal(f.selection.base.provider.requests.length, 1, 'reload performs no provider turn')
    await f.selection.select(1)
    assert.equal(
      f.selection.base.provider.requests.length,
      1,
      'model control performs no provider turn'
    )
    assert.equal((await f.prompt('SECOND-CONFIGURED-TURN')).status, 'completed')
    const beforeResume = await f.selection.messages()
    await f.reopen()
    assert.equal(
      f.selection.base.provider.requests.length,
      2,
      'fresh resume performs no provider turn'
    )
    assert.equal((await f.selection.state()).sessionId, state.sessionId)
    assert.deepEqual(
      persistentHistory(await f.selection.messages()),
      persistentHistory(beforeResume)
    )
    assert.equal((await f.prompt('THIRD-CONFIGURED-TURN')).status, 'completed')
    assert.equal(f.selection.base.provider.requests.length, 3)
    for (let index = 0; index < 3; index++) assertPhiContext(f, index)
    const observations = (await f.observations()).filter(
      (entry) => entry.type === 'before_agent_start'
    )
    assert.equal(observations.length, 3)
    for (const observation of observations) {
      assert.ok(!observation.base?.join('\n').includes(CONFIGURATION_PERSONA))
      assert.ok(!observation.base?.join('\n').includes('<phi_user_persona>'))
    }
    const finalMessages = await f.selection.messages()
    const userMessages = finalMessages.filter(
      (message) => (message as Record<string, unknown>).role === 'user'
    )
    assert.equal(
      userMessages.length,
      3,
      'only three explicit prompts enter the configured session history'
    )
    assert.ok(!JSON.stringify(userMessages).includes(CONFIGURATION_PERSONA))
  }
)
