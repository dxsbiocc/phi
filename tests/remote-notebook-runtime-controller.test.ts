import assert from 'node:assert/strict'
import test from 'node:test'

import { RemoteNotebookRuntimeController } from '../src/main/agent/notebook/remote-analysis-notebook-backend'
import type {
  JupyterRuntimeBackend,
  JupyterRuntimeStatus
} from '../src/main/agent/notebook/jupyter-runtime-backend'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolve = (): void => undefined
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function fakeRuntime(
  start: Promise<void>
): JupyterRuntimeBackend & { state: JupyterRuntimeStatus } {
  const runtime = {
    kind: 'ssh' as const,
    state: {
      kind: 'ssh' as const,
      projectCwd: '/server/project',
      state: 'stopped' as const,
      hasConnection: false
    },
    status: () => runtime.state,
    start: async () => {
      runtime.state = {
        ...runtime.state,
        state: 'preparing_environment',
        hasConnection: false
      }
      await start
      runtime.state = { ...runtime.state, state: 'ready', hasConnection: true }
    },
    stop: async () => {
      runtime.state = { ...runtime.state, state: 'stopped', hasConnection: false }
    },
    connection: () => null
  }
  return runtime
}

test('remote runtime start returns progress immediately and later becomes ready', async () => {
  const gate = deferred()
  const controller = new RemoteNotebookRuntimeController({
    projectCwd: '/server/project',
    serverLabel: 'cluster-login',
    runtime: fakeRuntime(gate.promise)
  })

  const starting = controller.start()
  assert.equal(starting.state, 'preparing_environment')
  assert.equal(starting.runtimeKind, 'ssh')
  assert.equal(starting.serverLabel, 'cluster-login')
  gate.resolve()
  await controller.waitForStart()
  assert.equal(controller.status().state, 'ready')
})

test('remote runtime preserves actionable environment errors without local fallback', async () => {
  const gate = deferred()
  const controller = new RemoteNotebookRuntimeController({
    projectCwd: '/server/project',
    serverLabel: 'cluster-login',
    runtime: fakeRuntime(gate.promise)
  })

  controller.start()
  gate.reject(new Error('未检测到 micromamba；请在设置 → 远程主机点击“安装 micromamba”按钮。'))
  await controller.waitForStart()

  const status = controller.status()
  assert.equal(status.state, 'error')
  assert.match(status.message ?? '', /安装 micromamba/)
  assert.doesNotMatch(status.message ?? '', /本机创建/)
})

test('remote runtime stop cancels an in-flight explicit start', async () => {
  let cancelled = false
  const runtime = fakeRuntime(
    new Promise<void>((_resolve, reject) => {
      setTimeout(() => {
        if (cancelled) reject(new Error('远程 Notebook 环境准备已取消'))
      }, 0)
    })
  )
  runtime.stop = async () => {
    cancelled = true
    runtime.state = { ...runtime.state, state: 'stopped', hasConnection: false }
  }
  const controller = new RemoteNotebookRuntimeController({
    projectCwd: '/server/project',
    serverLabel: 'cluster-login',
    runtime
  })

  controller.start()
  const stopped = await controller.stop()
  assert.equal(stopped.state, 'stopped')
  assert.equal(cancelled, true)
})
