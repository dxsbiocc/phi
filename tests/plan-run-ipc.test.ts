import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { registerPlanRunIpc, type KernelPlanRunIpcOperations } from '../src/main/ipc/plan-run-ipc'
import { createPlanRunApi } from '../src/preload/plan-run-api'
import { IPC } from '../src/shared/ipcChannels'
import type { PlanRunState } from '../src/shared/planRunTypes'

type RegisteredHandler = Parameters<IpcMain['handle']>[1]

const planRun: PlanRunState = {
  id: 'run-1',
  sessionId: 'session-1',
  spec: { version: 1, goal: 'Ship the plan', steps: [] },
  status: 'completed',
  steps: {},
  replans: 0,
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z'
}

function createHarness(): {
  kernelCalls: string[]
  handlers: Map<string, RegisteredHandler>
} {
  const kernelCalls: string[] = []
  const handlers = new Map<string, RegisteredHandler>()
  const ipcMain: Pick<IpcMain, 'handle'> = {
    handle: (channel, listener) => {
      handlers.set(channel, listener)
    }
  }
  const kernelPlanRuns: KernelPlanRunIpcOperations = {
    list: async () => {
      kernelCalls.push('list')
      return [{ ...planRun, sessionId: 'kernel-session' }]
    },
    get: async (runId) => {
      kernelCalls.push(`get:${runId}`)
      return runId === planRun.id ? { ...planRun, sessionId: 'kernel-session' } : null
    },
    stop: async (runId) => {
      kernelCalls.push(`stop:${runId}`)
      return { ...planRun, sessionId: 'kernel-session', status: 'stopped' as const }
    },
    retryStep: async (runId, stepId) => {
      kernelCalls.push(`retry:${runId}:${stepId}`)
      return { ...planRun, sessionId: 'kernel-session' }
    },
    skipStep: async (runId, stepId) => {
      kernelCalls.push(`skip:${runId}:${stepId}`)
      return { ...planRun, sessionId: 'kernel-session' }
    },
    requestReplan: async (runId) => {
      kernelCalls.push(`replan:${runId}`)
      return { requestId: 'kernel-request-1', runId, prompt: 'Replan in the kernel' }
    },
    cancelReplan: async (requestId) => {
      kernelCalls.push(`cancel-replan:${requestId}`)
      return requestId === 'kernel-request-1'
    }
  }
  registerPlanRunIpc({
    ipcMain,
    kernelPlanRuns: (sessionId) => (sessionId === 'kernel-session' ? kernelPlanRuns : undefined)
  })
  return { kernelCalls, handlers }
}

async function invoke(
  handlers: Map<string, RegisteredHandler>,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const handler = handlers.get(channel)
  assert.ok(handler, `${channel} was not registered`)
  return handler({} as IpcMainInvokeEvent, ...args)
}

test('plan run IPC rejects malformed, oversized, and extra arguments', async () => {
  const { kernelCalls, handlers } = createHarness()
  const invalidCalls: Array<[string, unknown[]]> = [
    [IPC.planRuns.list, []],
    [IPC.planRuns.list, [{ phiSessionId: '' }]],
    [IPC.planRuns.list, [{ phiSessionId: ' session-1' }]],
    [IPC.planRuns.list, [{ phiSessionId: `session-${'x'.repeat(512)}` }]],
    [IPC.planRuns.get, [{ phiSessionId: 'session-1' }]],
    [IPC.planRuns.getPendingReplan, [{ phiSessionId: 'session-1' }]],
    [IPC.planRuns.getPendingReplan, [{ phiSessionId: 'session-1', runId: 'run-1', extra: true }]],
    [IPC.planRuns.getPendingReplan, [{ phiSessionId: 'session-1', runId: 'run-1' }, 'extra']],
    [IPC.planRuns.pause, [{ phiSessionId: 'session-1', runId: 'run\0-1' }]],
    [IPC.planRuns.requestReplan, [{ phiSessionId: 'session-1', runId: 'run-1', spec: {} }]],
    [IPC.planRuns.cancelReplan, [{ phiSessionId: 'session-1', runId: 'run-1' }]],
    [IPC.planRuns.cancelReplan, [{ phiSessionId: 'session-1', runId: 'run-1', requestId: '' }]],
    [
      IPC.planRuns.retryStep,
      [{ phiSessionId: 'session-1', runId: 'run-1', stepId: 'step-a', extra: true }]
    ],
    [
      IPC.planRuns.skipStep,
      [{ phiSessionId: 'session-1', runId: 'run-1', stepId: 'step-a' }, 'extra']
    ]
  ]

  for (const [channel, args] of invalidCalls) {
    await assert.rejects(invoke(handlers, channel, ...args), /计划运行请求无效/u, channel)
  }
  assert.deepEqual(kernelCalls, [])
})

test('plan run IPC registers its full surface and routes only to the kernel coordinator', async () => {
  const { kernelCalls, handlers } = createHarness()
  assert.deepEqual([...handlers.keys()].sort(), Object.values(IPC.planRuns).sort())

  assert.deepEqual(await invoke(handlers, IPC.planRuns.list, { phiSessionId: 'kernel-session' }), [
    { ...planRun, sessionId: 'kernel-session' }
  ])
  assert.deepEqual(
    await invoke(handlers, IPC.planRuns.get, {
      phiSessionId: 'kernel-session',
      runId: 'run-1'
    }),
    { ...planRun, sessionId: 'kernel-session' }
  )
  assert.equal(
    await invoke(handlers, IPC.planRuns.getPendingReplan, {
      phiSessionId: 'kernel-session',
      runId: 'run-1'
    }),
    null
  )
  await assert.rejects(
    invoke(handlers, IPC.planRuns.pause, {
      phiSessionId: 'kernel-session',
      runId: 'run-1'
    }),
    /内核计划运行暂不支持暂停/u
  )
  await assert.rejects(
    invoke(handlers, IPC.planRuns.resume, {
      phiSessionId: 'kernel-session',
      runId: 'run-1'
    }),
    /内核计划运行暂不支持恢复/u
  )
  await invoke(handlers, IPC.planRuns.stop, {
    phiSessionId: 'kernel-session',
    runId: 'run-1'
  })
  await invoke(handlers, IPC.planRuns.retryStep, {
    phiSessionId: 'kernel-session',
    runId: 'run-1',
    stepId: 'step-a'
  })
  await invoke(handlers, IPC.planRuns.skipStep, {
    phiSessionId: 'kernel-session',
    runId: 'run-1',
    stepId: 'step-a'
  })
  assert.deepEqual(
    await invoke(handlers, IPC.planRuns.requestReplan, {
      phiSessionId: 'kernel-session',
      runId: 'run-1'
    }),
    { requestId: 'kernel-request-1', runId: 'run-1', prompt: 'Replan in the kernel' }
  )
  // A cancelled replan review must be clearable, or the paused run can never replan again.
  await invoke(handlers, IPC.planRuns.cancelReplan, {
    phiSessionId: 'kernel-session',
    runId: 'run-1',
    requestId: 'kernel-request-1'
  })
  assert.ok(kernelCalls.includes('cancel-replan:kernel-request-1'))
  await assert.rejects(
    invoke(handlers, IPC.planRuns.cancelReplan, {
      phiSessionId: 'kernel-session',
      runId: 'run-1',
      requestId: 'busy-request'
    }),
    /仍在处理/u
  )

  assert.deepEqual(
    await invoke(handlers, IPC.planRuns.list, { phiSessionId: 'unloaded-kernel' }),
    []
  )
  assert.equal(
    await invoke(handlers, IPC.planRuns.get, {
      phiSessionId: 'unloaded-kernel',
      runId: 'run-1'
    }),
    null
  )
  await assert.rejects(
    invoke(handlers, IPC.planRuns.stop, {
      phiSessionId: 'unloaded-kernel',
      runId: 'run-1'
    }),
    /内核计划会话当前未加载/u
  )

  assert.deepEqual(kernelCalls, [
    'list',
    'get:run-1',
    'stop:run-1',
    'retry:run-1:step-a',
    'skip:run-1:step-a',
    'replan:run-1',
    'cancel-replan:kernel-request-1',
    'cancel-replan:busy-request'
  ])
})

test('plan run preload API uses structured payloads and is spread into the global API', async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const api = createPlanRunApi({
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args })
      return planRun
    }
  })

  await api.listPlanRuns('session-1')
  await api.getPlanRun('session-1', 'run-1')
  await api.getPendingPlanRunReplan('session-1', 'run-1')
  await api.pausePlanRun('session-1', 'run-1')
  await api.resumePlanRun('session-1', 'run-1')
  await api.stopPlanRun('session-1', 'run-1')
  await api.retryPlanRunStep('session-1', 'run-1', 'step-a')
  await api.skipPlanRunStep('session-1', 'run-1', 'step-a')
  await api.requestPlanRunReplan('session-1', 'run-1')
  await api.cancelPlanRunReplan('session-1', 'run-1', 'request-1')

  assert.deepEqual(calls, [
    { channel: IPC.planRuns.list, args: [{ phiSessionId: 'session-1' }] },
    { channel: IPC.planRuns.get, args: [{ phiSessionId: 'session-1', runId: 'run-1' }] },
    {
      channel: IPC.planRuns.getPendingReplan,
      args: [{ phiSessionId: 'session-1', runId: 'run-1' }]
    },
    { channel: IPC.planRuns.pause, args: [{ phiSessionId: 'session-1', runId: 'run-1' }] },
    { channel: IPC.planRuns.resume, args: [{ phiSessionId: 'session-1', runId: 'run-1' }] },
    { channel: IPC.planRuns.stop, args: [{ phiSessionId: 'session-1', runId: 'run-1' }] },
    {
      channel: IPC.planRuns.retryStep,
      args: [{ phiSessionId: 'session-1', runId: 'run-1', stepId: 'step-a' }]
    },
    {
      channel: IPC.planRuns.skipStep,
      args: [{ phiSessionId: 'session-1', runId: 'run-1', stepId: 'step-a' }]
    },
    { channel: IPC.planRuns.requestReplan, args: [{ phiSessionId: 'session-1', runId: 'run-1' }] },
    {
      channel: IPC.planRuns.cancelReplan,
      args: [{ phiSessionId: 'session-1', runId: 'run-1', requestId: 'request-1' }]
    }
  ])

  const preloadSource = readFileSync(resolve('src/preload/index.ts'), 'utf8')
  const preloadTypes = readFileSync(resolve('src/preload/index.d.ts'), 'utf8')
  assert.match(preloadSource, /const planRunApi = createPlanRunApi\(ipcRenderer\)/u)
  assert.match(preloadSource, /\.\.\.planRunApi/u)
  assert.match(preloadTypes, /PlanRunRendererApi/u)
})
