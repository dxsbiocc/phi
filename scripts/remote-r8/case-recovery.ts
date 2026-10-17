import assert from 'node:assert/strict'

import { history, journal, toolResultText, type CaseContext } from './case-context'

/** Case 3: kill the owned transport, expect a failed old prompt, then an explicit same-journal resume. */
export async function runRecoveryCase(c: CaseContext): Promise<void> {
  const { remote, app, markers } = c
  const old = c.proxy
  assert.ok(old)
  const saved = await journal(remote, c.phiSessionId)
  const priorHistory = history(old)
  const count = app.provider.requests.length
  const generations = remote.generations.length
  const oldNonce = remote.rpc.at(-1)?.nonce
  const disconnect = await remote.abruptDisconnectLatest()
  const rejected = c.run(old, 'Do not automatically dispatch after the captured transport loss.')
  await rejected.done
  assert.equal(rejected.outcome, 'failed')
  assert.equal(
    app.provider.requests.length,
    count,
    'Transport loss must not automatically replay or reconnect a prompt'
  )
  await c.dispose(old)
  c.proxy = undefined
  const at = performance.now()
  const proxy = await c.attach(c.phiSessionId, true)
  c.proxy = proxy
  const reconnectMs = performance.now() - at
  assert.equal(
    app.provider.requests.length,
    count,
    'Explicit restore alone must not invoke a model or tool'
  )
  assert.ok(remote.generations.length > generations)
  assert.notEqual(remote.rpc.at(-1)?.nonce, oldNonce)
  const resumed = await journal(remote, c.phiSessionId)
  assert.equal(resumed.path, saved.path)
  assert.equal(resumed.ompSessionId, saved.ompSessionId)
  assert.deepEqual(
    resumed.entries.slice(0, saved.entries.length),
    saved.entries,
    'Explicit restore must preserve every saved native entry in order'
  )
  assert.ok(
    resumed.entries
      .slice(saved.entries.length)
      .every((entry) => entry.type === 'custom' && entry.customType === 'session_exit'),
    'Explicit restore may append only OMP session_exit diagnostics'
  )
  assert.deepEqual(history(proxy), priorHistory)
  app.provider.enqueue(
    { tool: { name: 'read', id: 'r8-reconnected-read', args: { path: 'input.txt' } } },
    { text: 'Explicit new request after the genuine transport loss completed.' }
  )
  const fresh = c.run(proxy, 'Now explicitly read the existing edited input.txt once.')
  await fresh.done
  assert.equal(fresh.outcome, 'completed')
  assert.equal(app.provider.requests.length, count + 2)
  assert.match(
    toolResultText(app.provider.requests.at(-1)!, 'r8-reconnected-read'),
    new RegExp(markers.edited)
  )
  assert.equal(
    c.tools.filter((t) => ['edit', 'bash', 'task'].includes(t.name)).length,
    3,
    'No implicit repeat of effects or delegation'
  )
  c.complete({
    case: 'ssh-loss-reconnect-explicit-original-journal',
    phiSessionId: c.phiSessionId,
    ...disconnect,
    disconnectBoundary: 'idle after confirmed durable checkpoint',
    oldProxyRejected: true,
    noImplicitProviderReplay: true,
    sameOmpSessionId: true,
    sameJournal: true,
    samePersistedEntries: true,
    samePublicHistory: true,
    freshAttestedGeneration: true,
    reconnectAndExplicitRestoreMs: reconnectMs,
    newExplicitReadRequests: 2
  })
}
