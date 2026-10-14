import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import { delayActualChildStarted } from './facadeChildStartedProbe'
import { createRunId } from '../../src/main/agent/session/session-store'
import type { RpcChildRuntimeConfig } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'

/** Native SDK creation precedes a delayed Node lifecycle delivery; cancellation cannot claim an empty set. */
export async function runDelayedChildStarted(f: FacadeMetadataFixture): Promise<void> {
  const id = 'late-started-parent'
  const probe = delayActualChildStarted()
  let stopped: Promise<unknown> | undefined
  try {
    await f.engine.sessions.create(f.params(id))
    const directory = (await f.privateDirectories())[0]
    const config: RpcChildRuntimeConfig = JSON.parse(
      await readFile(join(directory, 'child-runtime.json'), 'utf8')
    )
    f.provider.enqueue({
      tool: {
        name: 'task',
        id: 'late-started-task',
        args: {
          i: 'Run a controlled real foreground child',
          agent: config.profiles[0].definition.nativeName,
          name: 'delayed-started-child',
          task: 'Return a plain result after admission',
          solutionSpace: 'Private loopback'
        }
      }
    })
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: async () => {
        await f.engine.sessions.prompt({
          sessionId: id,
          text: 'Create one real child and stop while its started frame is in transit'
        })
      }
    })
    const actual = await probe.started
    const snapshot = await probe.nativeSnapshot()
    assert.ok(
      snapshot &&
        typeof snapshot === 'object' &&
        'subagents' in snapshot &&
        Array.isArray(snapshot.subagents)
    )
    assert.ok(
      snapshot.subagents.some(
        (child: unknown) =>
          !!child && typeof child === 'object' && 'id' in child && child.id === actual.nativeId
      )
    )
    assert.ok((await readFile(actual.sessionFile, 'utf8')).length > 0)
    f.runners.stopRun(f.phi.sessionId)
    stopped = f.engine.sessions.abort({ sessionId: id })
    let settled = false
    void stopped.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(
      settled,
      false,
      'an authenticated task with an in-transit native start must not be an empty confirmed cancellation'
    )
    assert.equal(probe.evidence.parentAbortCalls, 0)
    assert.equal(probe.evidence.cancels.length, 0)
    assert.equal(f.provider.requests.length, 1)
    probe.release()
    await stopped
    await run.done
    assert.equal(run.outcome, 'stopped')
    assert.ok(
      probe.evidence.cancels.some((item) => item.nativeId === actual.nativeId && item.cancelled)
    )
    assert.ok(probe.evidence.aborted.includes(actual.nativeId))
    assert.equal(f.provider.requests.length, 1)
    console.log(
      'actual late-started native child cancellation required real ACK and matching aborted lifecycle'
    )
  } finally {
    probe.restore()
    await stopped?.catch(() => undefined)
  }
}
