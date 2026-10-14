import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import {
  RemoteSessionRuntime,
  type RemoteSessionRuntimeOptions
} from '../../src/main/agent/engine/rpc/remote-session-runtime'
import { createRunId } from '../../src/main/agent/session/session-store'
import type { RpcChildRuntimeConfig } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'

/** Observes the real controller; every SDK process, model task, authority and result remains real. */
export async function runReentrantChildClose(f: FacadeMetadataFixture): Promise<void> {
  const create = RemoteSessionRuntime.create
  let runtime: RemoteSessionRuntime | undefined, reentered: Promise<void> | undefined
  let uiReady = false
  const spy = mock.method(
    RemoteSessionRuntime,
    'create',
    async (options: RemoteSessionRuntimeOptions) => {
      runtime = await create(options)
      return runtime
    }
  )
  f.configureApproval({
    shouldGate: () => true,
    requestToolApproval: (_request, signal) =>
      new Promise((resolve) => {
        uiReady = true
        signal.addEventListener(
          'abort',
          () => {
            reentered = runtime!.close(new Error('UI abort synchronously reentered close'))
            void reentered.catch(() => undefined)
            resolve('cancelled')
          },
          { once: true }
        )
      })
  })
  let first: Promise<void> | undefined, done: Promise<void> | undefined
  try {
    const id = 'reentrant-child-close'
    await f.engine.sessions.create(f.params(id))
    assert.ok(runtime)
    const directory = (await f.privateDirectories())[0]
    const config: RpcChildRuntimeConfig = JSON.parse(
      await readFile(join(directory, 'child-runtime.json'), 'utf8')
    )
    f.provider.enqueue(
      {
        tool: {
          name: 'task',
          id: 'reentrant-task',
          args: {
            i: 'Create one real native child',
            agent: config.profiles[0].definition.nativeName,
            name: 'reentrant-child',
            task: 'Write a file after approval',
            solutionSpace: 'Private loopback'
          }
        }
      },
      {
        tool: {
          name: 'write',
          id: 'reentrant-write',
          args: {
            path: join(f.f.scope.projectRoot, 'reentrant-must-not-write.txt'),
            content: 'must stay denied'
          }
        }
      }
    )
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: async () => {
        await f.engine.sessions.prompt({ sessionId: id, text: 'Wait for native child approval' })
      }
    })
    done = run.done
    void done.catch(() => undefined)
    const began = Date.now()
    while (!uiReady) {
      assert.equal(run.outcome, undefined)
      assert.ok(Date.now() - began < 15000)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    first = runtime.close(new Error('Explicit generation close'))
    void first.catch(() => undefined)
    assert.ok(reentered, 'real pending approval abort observer must synchronously reenter')
    assert.equal(first, reentered, 'close must publish one cleanup promise before revoking permits')
    await first
    await done
    assert.equal(f.engine.sessions.has(id), false)
    assert.equal(await f.exists(join(f.f.scope.projectRoot, 'reentrant-must-not-write.txt')), false)
    assert.equal((await f.privateDirectories()).length, 0)
    console.log('real UI abort observer reentered one generation cleanup promise without effects')
  } finally {
    spy.mock.restore()
    await Promise.allSettled([first, reentered, done])
  }
}
