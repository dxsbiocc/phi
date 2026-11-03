import assert from 'node:assert/strict'
import test from 'node:test'

import { RemoteNotebookRuntimeController } from '../src/main/agent/notebook/remote-analysis-notebook-backend'
import type { JupyterRuntimeBackend } from '../src/main/agent/notebook/jupyter-runtime-backend'

function fakeRuntime(): {
  runtime: JupyterRuntimeBackend
  starts: number
  stops: number
  startRuntimeSessions: Array<string | undefined>
  finish: () => void
  fail: (error: Error) => void
} {
  let ready = false
  let pending: { resolve: () => void; reject: (error: Error) => void } | undefined
  const state = { starts: 0, stops: 0, startRuntimeSessions: [] as Array<string | undefined> }
  const runtime = {
    kind: 'ssh',
    status: (projectCwd: string) => ({
      kind: 'ssh',
      projectCwd,
      state: ready ? 'ready' : pending ? 'preparing_environment' : 'stopped',
      hasConnection: ready
    }),
    start: (_projectCwd: string, _signal?: AbortSignal, runtimeSessionId?: string) => {
      state.starts += 1
      state.startRuntimeSessions.push(runtimeSessionId)
      return new Promise<void>((resolve, reject) => {
        pending = {
          resolve: () => {
            ready = true
            pending = undefined
            resolve()
          },
          reject: (error) => {
            pending = undefined
            reject(error)
          }
        }
      })
    },
    stop: async () => {
      state.stops += 1
      pending?.reject(new Error('stopped'))
    }
  } as unknown as JupyterRuntimeBackend
  return {
    runtime,
    get starts() {
      return state.starts
    },
    get stops() {
      return state.stops
    },
    get startRuntimeSessions() {
      return state.startRuntimeSessions
    },
    finish: () => pending?.resolve(),
    fail: (error) => pending?.reject(error)
  }
}

function controllerFor(runtime: JupyterRuntimeBackend): RemoteNotebookRuntimeController {
  return new RemoteNotebookRuntimeController({
    projectCwd: '/proj',
    serverLabel: 'node3',
    runtime
  })
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

test('approved auto-start uses the controller start path once and resolves when ready', async () => {
  const fake = fakeRuntime()
  const controller = controllerFor(fake.runtime)
  const infos: unknown[] = []
  const ready = controller.ensureReady({
    approveRemoteJupyterStart: async (info) => {
      infos.push(info)
      return true
    }
  })
  await tick()
  assert.equal(fake.starts, 1)
  assert.equal(controller.status().messageCode, 'preparing_environment')
  fake.finish()
  await ready
  assert.deepEqual(infos, [{ serverLabel: 'node3', projectName: '/proj' }])
  assert.equal(controller.status().state, 'ready')
})

test('approved auto-start forwards the active chat runtime to missing-Jupyter recovery', async () => {
  const fake = fakeRuntime()
  const controller = controllerFor(fake.runtime)
  const ready = controller.ensureReady({
    runtimeSessionId: 'runtime-chat-1',
    approveRemoteJupyterStart: async () => true
  })
  await tick()
  assert.deepEqual(fake.startRuntimeSessions, ['runtime-chat-1'])
  fake.finish()
  await ready
})

test('denied approval fails clearly without starting', async () => {
  const fake = fakeRuntime()
  const controller = controllerFor(fake.runtime)
  await assert.rejects(
    controller.ensureReady({ approveRemoteJupyterStart: async () => false }),
    /user declined to start remote Jupyter.*did not fall back to local Jupyter/i
  )
  assert.equal(fake.starts, 0)
})

test('without an approval channel it never starts and never falls back locally', async () => {
  const fake = fakeRuntime()
  await assert.rejects(
    controllerFor(fake.runtime).ensureReady({}),
    /cannot ask for user approval.*did not fall back to local Jupyter/i
  )
  assert.equal(fake.starts, 0)
})

test('concurrent callers share one approval and one start', async () => {
  const fake = fakeRuntime()
  const controller = controllerFor(fake.runtime)
  let approvals = 0
  const control = {
    approveRemoteJupyterStart: async (): Promise<boolean> => {
      approvals += 1
      await tick()
      return true
    }
  }
  const all = Promise.all([
    controller.ensureReady(control),
    controller.ensureReady(control),
    controller.ensureReady(control)
  ])
  await tick()
  await tick()
  fake.finish()
  await all
  assert.equal(approvals, 1)
  assert.equal(fake.starts, 1)
})

test('cancel during start aborts the wait and stops the start', async () => {
  const fake = fakeRuntime()
  const controller = controllerFor(fake.runtime)
  const abort = new AbortController()
  const waiting = controller.ensureReady({
    signal: abort.signal,
    approveRemoteJupyterStart: async () => true
  })
  await tick()
  abort.abort(new Error('run cancelled'))
  await assert.rejects(waiting, /run cancelled/)
  assert.equal(fake.stops, 1)
})

test('start failure is returned to the caller', async () => {
  const fake = fakeRuntime()
  const controller = controllerFor(fake.runtime)
  const waiting = controller.ensureReady({ approveRemoteJupyterStart: async () => true })
  await tick()
  fake.fail(new Error('probe timeout'))
  await assert.rejects(waiting, /Remote Jupyter failed to start: probe timeout/)
})

test('timeout leaves the start running and says so', async () => {
  const fake = fakeRuntime()
  const controller = controllerFor(fake.runtime)
  await assert.rejects(
    controller.ensureReady({ approveRemoteJupyterStart: async () => true }, { timeoutMs: 30 }),
    /Timed out waiting.*still running in the background/
  )
  assert.equal(fake.stops, 0)
})

test('an already-ready server needs no approval', async () => {
  const fake = fakeRuntime()
  const controller = controllerFor(fake.runtime)
  const first = controller.ensureReady({ approveRemoteJupyterStart: async () => true })
  await tick()
  fake.finish()
  await first
  await controller.ensureReady({
    approveRemoteJupyterStart: async () => assert.fail('must not ask again')
  })
  assert.equal(fake.starts, 1)
})
