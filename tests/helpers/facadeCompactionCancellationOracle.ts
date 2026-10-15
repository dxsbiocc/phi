import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { mock } from 'node:test'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import type { RuntimeAgentSession } from '../../src/main/agent/runtime/runtime-adapter'
import { createRuntimeAgentSession } from '../../src/main/agent/runtime/runtime-adapter'
import { createAppRemoteSessionManager } from '../../src/main/agent/remote-session-routing'
import {
  createPhiSession,
  createRunId,
  findPhiSessionById
} from '../../src/main/agent/session/session-store'
import { remoteOmpJournalPath } from '../../src/main/agent/session/runtime-reference'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcFrame } from '../../src/main/agent/engine/rpc/types'

async function until(check: () => boolean): Promise<void> {
  const start = Date.now()
  while (!check()) {
    assert.ok(Date.now() - start < 15000, 'owned compaction boundary did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
/** Real app/CLI/controller cancellation, including a lost private terminal callback and live peer. */
export async function runCompactionCancellation(
  f: FacadeMetadataFixture,
  proxy: RuntimeAgentSession,
  options: {
    mode: string
    summaryRequests(): number
    marker: string
  }
): Promise<void> {
  const original = findPhiSessionById(f.phi.sessionId)!
  const journal = remoteOmpJournalPath(original.runtimeRef!)
  const oldJournal = await readFile(journal, 'utf8'),
    oldMarker = await stat(options.marker)
  const peerPhi = createPhiSession({
    kind: 'project',
    projectId: original.projectId,
    projectLocation: original.projectLocation,
    cwd: original.cwd,
    cwdRealPath: original.cwdRealPath,
    permissionMode: 'ask',
    model: original.model,
    thinkingLevel: original.thinkingLevel
  })
  const peer = (
    await createRuntimeAgentSession({
      cwd: original.cwd,
      agentDir: process.env.PI_CODING_AGENT_DIR!,
      model: f.model('model-a'),
      thinkingLevel: original.thinkingLevel,
      projectBound: true,
      sessionManager: createAppRemoteSessionManager(original.cwd, peerPhi.sessionId, false),
      remoteProject: { ...f.params('unused').remoteProject!, phiSessionId: peerPhi.sessionId }
    })
  ).session
  let primaryClosed = false,
    peerClosed = false
  void f.channels[0].closed.then(() => {
    primaryClosed = true
  })
  void f.channels.at(-1)!.closed.then(() => {
    peerClosed = true
  })
  const beforePeer = f.provider.requests.length
  f.provider.enqueue({ text: 'The peer continues independently', hold: true })
  const peerRun = f.runners.startRun({
    sessionId: peerPhi.sessionId,
    runId: createRunId(),
    execute: () => peer.prompt('Independent held peer')
  })
  await until(() => f.provider.requests.length === beforePeer + 1)
  const onEvent = RpcConnection.prototype.onEvent
  const dropped =
    options.mode === 'lost-outcome'
      ? mock.method(
          RpcConnection.prototype,
          'onEvent',
          function (this: RpcConnection, listener: (frame: RpcFrame) => void) {
            return onEvent.call(this, (frame) => {
              if (
                frame.type === 'extension_ui_request' &&
                frame.method === 'notify' &&
                typeof frame.message === 'string'
              ) {
                try {
                  const raw = JSON.parse(frame.message)
                  if (raw.type === 'phi_rpc_compaction_control' && raw.operation === 'compact')
                    return
                } catch {
                  /* Other non-JSON SDK notifications remain unchanged. */
                }
              }
              listener(frame)
            })
          }
        )
      : undefined
  const pending = proxy.compact()
  const rejected = assert.rejects(pending, /cancel|stopped|closing|Owned compaction/)
  try {
    await until(() => options.summaryRequests() > 0)
    console.log('phase summary-held', options.mode)
    assert.equal(primaryClosed, false)
    await assert.rejects(proxy.abort(), /cancel|stopped|closing|Owned compaction/)
    await rejected
    console.log('phase abort-physically-settled')
    assert.equal(primaryClosed, true, 'stop must retire the owned CLI before its wait resolves')
    assert.equal(peerClosed, false)
    assert.equal(peerRun.signal.aborted, false)
    assert.equal(f.engine.sessions.has(peer.runtimeSessionId), true)
    const entries = (value: string): Array<Record<string, unknown>> =>
      value
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    const oldEntries = entries(oldJournal),
      newEntries = entries(await readFile(journal, 'utf8'))
    console.log(
      'phase cancellation journal types',
      JSON.stringify({
        before: oldEntries.map((entry) => entry.type),
        after: newEntries.map((entry) => entry.type)
      })
    )
    assert.equal(
      newEntries.filter((entry) => entry.type === 'compaction').length,
      oldEntries.filter((entry) => entry.type === 'compaction').length,
      'cancelled summary cannot append a compaction entry'
    )
    const ordered = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(ordered)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => [key, ordered(item)])
            )
          : value
    const digest = (entry: Record<string, unknown>): string =>
      createHash('sha256')
        .update(JSON.stringify(ordered(entry)))
        .digest('hex')
    const key = (entry: Record<string, unknown>, index: number): string =>
      typeof entry.id === 'string' ? entry.id : `${entry.type}:${index}`
    const originalKeys = new Set(oldEntries.map(key))
    assert.deepEqual(
      newEntries.filter((entry, index) => originalKeys.has(key(entry, index))).map(digest),
      oldEntries.map(digest),
      'every original journal entry must remain semantically identical'
    )
    const appended = newEntries.filter((entry, index) => !originalKeys.has(key(entry, index)))
    assert.ok(
      appended.every((entry) => entry.type === 'custom' && entry.customType === 'session_exit'),
      'only SDK retirement bookkeeping may follow cancellation; no new message/tool/summary'
    )

    assert.equal((await stat(options.marker)).mtimeMs, oldMarker.mtimeMs)
    assert.deepEqual(findPhiSessionById(f.phi.sessionId)!.model, original.model)
    assert.deepEqual(findPhiSessionById(f.phi.sessionId)!.runtimeRef, original.runtimeRef)
    dropped?.mock.restore()
    const requests = f.provider.requests.length
    await proxy.dispose().catch(() => undefined)
    f.resume()
    const fresh = (await f.createApplicationSession()).session
    try {
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
        original.runtimeRef!.journalBasename
      )
      assert.equal(
        f.provider.requests.length,
        requests,
        'explicit recovery cannot replay the interrupted compaction or main turn'
      )
      await proxy.abort().catch(() => undefined)
      assert.equal(
        f.engine.sessions.has(fresh.runtimeSessionId),
        true,
        'old stop cannot affect the new generation'
      )
    } finally {
      await fresh.dispose()
    }
  } finally {
    dropped?.mock.restore()
    f.runners.stopRun(peerPhi.sessionId)
    await peer.abort()
    await peerRun.done
    await peer.dispose()
  }
}
