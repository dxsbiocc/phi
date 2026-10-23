import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createWorkModeControl,
  validateSessionMode,
  validateSessionModeUpdate
} from '../src/main/agent/plan/work-mode-control'
import type { PermissionMode } from '../src/main/agent/projects'
import type { WorkMode } from '../src/shared/sessionMode'

const current = {
  path: '/phi/session-1',
  phiSessionId: 'session-1',
  sessionGeneration: 4
}
const target = {
  sessionPath: current.path,
  phiSessionId: current.phiSessionId,
  sessionGeneration: current.sessionGeneration
}

test('work mode validation maps all session modes to an atomic field update', () => {
  assert.deepEqual(validateSessionModeUpdate('auto', target, current), {
    workMode: 'auto',
    permissionMode: 'auto'
  })
  assert.deepEqual(validateSessionModeUpdate('ask', target, current), {
    workMode: 'direct',
    permissionMode: 'ask'
  })
  assert.deepEqual(validateSessionModeUpdate('plan', target, current), {
    workMode: 'plan',
    permissionMode: 'auto'
  })
  assert.deepEqual(validateSessionModeUpdate('plan_execute', target, current), {
    workMode: 'plan_execute',
    permissionMode: 'auto'
  })
  assert.deepEqual(validateSessionModeUpdate('full', target, current), {
    workMode: 'direct',
    permissionMode: 'full'
  })
})

test('work mode update reuses the session target guard', () => {
  assert.throws(
    () => validateSessionModeUpdate('full', { ...target, sessionGeneration: 3 }, current),
    /会话已切换/
  )
  assert.throws(() => validateSessionModeUpdate('full', undefined, current), /缺少会话目标/)
})

test('remote sessions reject plan modes while allowing direct and automatic modes', () => {
  const remote = {
    ...current,
    projectLocation: {
      kind: 'ssh' as const,
      hostProfileId: 'host-1',
      remoteRoot: '/remote',
      canonicalRoot: '/remote'
    }
  }
  assert.throws(() => validateSessionModeUpdate('plan', target, remote), /暂不支持计划评审/)
  assert.throws(() => validateSessionModeUpdate('plan_execute', target, remote), /暂不支持计划评审/)
  assert.doesNotThrow(() => validateSessionModeUpdate('auto', target, remote))
  assert.doesNotThrow(() => validateSessionModeUpdate('ask', target, remote))
  assert.doesNotThrow(() => validateSessionModeUpdate('full', target, remote))
})

test('invalid session modes fail before persistence fields are produced', () => {
  for (const value of ['review', '', null, undefined, 1]) {
    assert.throws(() => validateSessionMode(value), /会话模式无效/)
  }
})

interface ControlPayload {
  path: string
  phiSessionId: string
  sessionGeneration: number
  workMode: WorkMode
  permissionMode: PermissionMode
}

interface ControlHarness {
  control: { update(mode: unknown, target: unknown): Promise<ControlPayload> }
  cleaned: string[]
  checks(): { plan: number; agent: number }
  payload(): ControlPayload
}

interface ControlHarnessOptions {
  workMode?: WorkMode
  permissionMode?: PermissionMode
  activePlan?: boolean
  activeAgent?: boolean
  activePrompt?: boolean
  agentCheck?: () => Promise<boolean>
}

function createControlHarness(options: ControlHarnessOptions = {}): ControlHarness {
  let payload = {
    ...current,
    workMode: options.workMode ?? ('direct' as const),
    permissionMode: options.permissionMode ?? ('ask' as const)
  }
  const cleaned: string[] = []
  let planChecks = 0
  let agentChecks = 0
  const control = createWorkModeControl({
    state: {
      getCurrentSessionKey: () => 'key-1',
      getCurrentSessionPath: () => current.path,
      getCurrentCwd: () => '/workspace',
      setCurrentPermissionMode: (permissionMode) => {
        payload = { ...payload, permissionMode }
      },
      sessionPermissionModes: { set: () => undefined }
    },
    reads: { getCurrentSessionPayload: () => payload },
    identity: {
      resolveSessionKeyAlias: (key) => key,
      getPhiSessionIdForKey: () => current.phiSessionId,
      findPhiManifestForSession: () => null
    },
    lifecycle: {
      getLifecycleForKey: () => ({ advance: () => 'record-1' }),
      cleanupSessionRecord: async (record) => {
        cleaned.push(record)
      }
    },
    status: {
      runnerGetActiveRun: () => undefined,
      activePromptEntries: () =>
        options.activePrompt ? [['key-1', { phiSessionId: current.phiSessionId }]] : [],
      notifySessionChanged: () => undefined
    },
    activity: {
      hasActivePlanWork: () => {
        planChecks += 1
        return options.activePlan ?? false
      },
      hasActiveAgentRuns: async () => {
        agentChecks += 1
        return options.agentCheck?.() ?? options.activeAgent ?? false
      }
    },
    updateManifest: (_sessionId, fields) => {
      payload = { ...payload, ...fields }
    }
  })
  return {
    control,
    cleaned,
    checks: () => ({ plan: planChecks, agent: agentChecks }),
    payload: () => payload
  }
}

test('permission-only updates persist without disposing or checking background work', async () => {
  const harness = createControlHarness({ activePlan: true, activeAgent: true })

  await harness.control.update('full', target)

  assert.deepEqual(harness.cleaned, [])
  assert.deepEqual(harness.checks(), { plan: 0, agent: 0 })
  assert.equal(harness.payload().workMode, 'direct')
  assert.equal(harness.payload().permissionMode, 'full')
})

test('idle work-mode changes dispose the previous runtime', async () => {
  const harness = createControlHarness()

  await harness.control.update('plan', target)

  assert.deepEqual(harness.cleaned, ['record-1'])
  assert.deepEqual(harness.checks(), { plan: 2, agent: 1 })
  assert.equal(harness.payload().workMode, 'plan')
})

test('work-mode changes reject an active plan without mutating the session', async () => {
  const harness = createControlHarness({ activePlan: true })

  await assert.rejects(
    harness.control.update('plan', target),
    new Error('计划或后台智能体仍在运行，请先暂停或等待结束后再切换模式')
  )

  assert.deepEqual(harness.cleaned, [])
  assert.equal(harness.payload().workMode, 'direct')
})

test('work-mode changes reject an unfinished background agent run', async () => {
  const harness = createControlHarness({ activeAgent: true })

  await assert.rejects(
    harness.control.update('plan_execute', target),
    new Error('计划或后台智能体仍在运行，请先暂停或等待结束后再切换模式')
  )

  assert.deepEqual(harness.cleaned, [])
  assert.equal(harness.payload().workMode, 'direct')
})

test('work-mode changes recheck plans started during the asynchronous agent query', async () => {
  let finishAgentCheck!: (active: boolean) => void
  const options: ControlHarnessOptions = {
    activePlan: false,
    agentCheck: () =>
      new Promise<boolean>((resolve) => {
        finishAgentCheck = resolve
      })
  }
  const harness = createControlHarness(options)
  const update = harness.control.update('plan', target)

  options.activePlan = true
  finishAgentCheck(false)

  await assert.rejects(
    update,
    new Error('计划或后台智能体仍在运行，请先暂停或等待结束后再切换模式')
  )
  assert.deepEqual(harness.cleaned, [])
  assert.equal(harness.payload().workMode, 'direct')
})
