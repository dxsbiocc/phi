import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { registerPlanRunIpc, type PlanRunIpcOperations } from '../src/main/ipc/plan-run-ipc'
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
  calls: string[]
  handlers: Map<string, RegisteredHandler>
} {
  const calls: string[] = []
  const operations: PlanRunIpcOperations = {
    list: (sessionId) => {
      calls.push(`list:${sessionId}`)
      return [planRun]
    },
    get: (sessionId, runId) => {
      calls.push(`get:${sessionId}:${runId}`)
      return runId === planRun.id ? planRun : undefined
    },
    pause: recordRunCall(calls, 'pause'),
    resume: recordRunCall(calls, 'resume'),
    stop: recordRunCall(calls, 'stop'),
    retryStep: recordStepCall(calls, 'retry'),
    skipStep: recordStepCall(calls, 'skip')
  }
  const handlers = new Map<string, RegisteredHandler>()
  const ipcMain: Pick<IpcMain, 'handle'> = {
    handle: (channel, listener) => {
      handlers.set(channel, listener)
    }
  }
  registerPlanRunIpc({ ipcMain, planRuns: operations })
  return { calls, handlers }
}

function recordRunCall(calls: string[], operation: string): PlanRunIpcOperations['pause'] {
  return (sessionId, runId) => {
    calls.push(`${operation}:${sessionId}:${runId}`)
    return planRun
  }
}

function recordStepCall(calls: string[], operation: string): PlanRunIpcOperations['retryStep'] {
  return (sessionId, runId, stepId) => {
    calls.push(`${operation}:${sessionId}:${runId}:${stepId}`)
    return planRun
  }
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

test('plan run IPC registers and routes the complete control surface', async () => {
  const { calls, handlers } = createHarness()
  assert.deepEqual([...handlers.keys()].sort(), Object.values(IPC.planRuns).sort())

  assert.deepEqual(await invoke(handlers, IPC.planRuns.list, { phiSessionId: 'session-1' }), [
    planRun
  ])
  assert.equal(
    await invoke(handlers, IPC.planRuns.get, { phiSessionId: 'session-1', runId: 'missing' }),
    null
  )
  await invoke(handlers, IPC.planRuns.pause, { phiSessionId: 'session-1', runId: 'run-1' })
  await invoke(handlers, IPC.planRuns.resume, { phiSessionId: 'session-1', runId: 'run-1' })
  await invoke(handlers, IPC.planRuns.stop, { phiSessionId: 'session-1', runId: 'run-1' })
  await invoke(handlers, IPC.planRuns.retryStep, {
    phiSessionId: 'session-1',
    runId: 'run-1',
    stepId: 'step-a'
  })
  await invoke(handlers, IPC.planRuns.skipStep, {
    phiSessionId: 'session-1',
    runId: 'run-1',
    stepId: 'step-a'
  })

  assert.deepEqual(calls, [
    'list:session-1',
    'get:session-1:missing',
    'pause:session-1:run-1',
    'resume:session-1:run-1',
    'stop:session-1:run-1',
    'retry:session-1:run-1:step-a',
    'skip:session-1:run-1:step-a'
  ])
})

test('plan run IPC rejects malformed, oversized, and extra arguments', async () => {
  const { calls, handlers } = createHarness()
  const invalidCalls: Array<[string, unknown[]]> = [
    [IPC.planRuns.list, []],
    [IPC.planRuns.list, [{ phiSessionId: '' }]],
    [IPC.planRuns.list, [{ phiSessionId: ' session-1' }]],
    [IPC.planRuns.list, [{ phiSessionId: `session-${'x'.repeat(512)}` }]],
    [IPC.planRuns.get, [{ phiSessionId: 'session-1' }]],
    [IPC.planRuns.pause, [{ phiSessionId: 'session-1', runId: 'run\0-1' }]],
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
  assert.deepEqual(calls, [])
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
  await api.pausePlanRun('session-1', 'run-1')
  await api.resumePlanRun('session-1', 'run-1')
  await api.stopPlanRun('session-1', 'run-1')
  await api.retryPlanRunStep('session-1', 'run-1', 'step-a')
  await api.skipPlanRunStep('session-1', 'run-1', 'step-a')

  assert.deepEqual(calls, [
    { channel: IPC.planRuns.list, args: [{ phiSessionId: 'session-1' }] },
    { channel: IPC.planRuns.get, args: [{ phiSessionId: 'session-1', runId: 'run-1' }] },
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
    }
  ])

  const preloadSource = readFileSync(resolve('src/preload/index.ts'), 'utf8')
  const preloadTypes = readFileSync(resolve('src/preload/index.d.ts'), 'utf8')
  assert.match(preloadSource, /const planRunApi = createPlanRunApi\(ipcRenderer\)/u)
  assert.match(preloadSource, /\.\.\.planRunApi/u)
  assert.match(preloadTypes, /PlanRunRendererApi/u)
})
