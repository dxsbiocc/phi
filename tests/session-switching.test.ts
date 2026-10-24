import assert from 'node:assert/strict'
import test from 'node:test'

import { StaleSessionError } from '../src/main/agent/session/session-lifecycle'
import {
  createSessionSwitching,
  type SessionSwitching
} from '../src/main/session-runtime/session-switching'

interface TestPromptRun {
  phiSessionId: string
  runId: string
  cancelled: boolean
}

type SelectedModel = { providerId: string; modelId: string } | null | undefined
type TestBrowserRegistry =
  { setActiveSession: (sessionId: string | null) => Promise<void> } | null | undefined

interface SwitchingHarness {
  switching: SessionSwitching<unknown>
  calls: string[]
  created: unknown[]
  linked: string[]
  permissionModes: Map<string, 'auto' | 'ask' | 'full'>
  loadedSkills: Map<string, string[]>
  setSelectedModel(value: SelectedModel): void
  setNoProjectTaskFolder(value: string): void
  setProjectByCwd(value: Record<string, unknown> | undefined): void
  setProjectById(value: Record<string, unknown> | undefined): void
  setActivePromptRun(value: TestPromptRun | undefined): void
  setCurrentRecord(value: Record<string, unknown> | null, isCurrent?: boolean): void
  setBrowserRegistry(value: TestBrowserRegistry): void
}

function createSwitchingHarness(): SwitchingHarness {
  const calls: string[] = []
  const created: unknown[] = []
  const linked: string[] = []
  const permissionModes = new Map<string, 'auto' | 'ask' | 'full'>()
  const loadedSkills = new Map<string, string[]>()
  let selectedModel: SelectedModel
  let currentSessionKey = 'current-key'
  let noProjectTaskFolder = '/ordinary/first'
  let projectByCwd: Record<string, unknown> | undefined
  let projectById: Record<string, unknown> | undefined
  let activePromptRun: TestPromptRun | undefined
  let currentRecord: Record<string, unknown> | null = null
  let recordIsCurrent = true
  let browserRegistry: TestBrowserRegistry = {
    setActiveSession: async (sessionId) => {
      calls.push(`browser:${String(sessionId)}`)
    }
  }
  let nextSessionId = 1
  const lifecycle = {
    get currentRecord() {
      return currentRecord
    },
    isCurrent: () => recordIsCurrent,
    advance: () => {
      calls.push('lifecycle:advance')
      const previous = currentRecord
      currentRecord = null
      return previous
    }
  }

  const switching = createSessionSwitching<unknown, TestPromptRun>({
    state: {
      sessionState: {
        get sessionKey() {
          return currentSessionKey
        },
        get selectedModel() {
          return selectedModel
        },
        switchTo: (path, cwd, permissionMode) => {
          calls.push(`state:${String(path)}:${cwd}:${permissionMode}`)
          currentSessionKey = `${String(path)}:${cwd}`
        }
      },
      sessionKeys: {
        createKey: (path, cwd) => `${String(path)}:${cwd}`,
        createPhiKey: (sessionId, cwd) => `${sessionId}:${cwd}`,
        canonicalize: (key) => `canonical:${key}`,
        phiSessionIdFor: () => 'phi-current'
      },
      lifecycles: {
        forKey: () => lifecycle as never
      },
      promptRuns: {
        activeRun: () => activePromptRun,
        advanceGeneration: () => {
          calls.push('prompt:generation')
          return 1
        }
      },
      permissionModes
    },
    sessions: {
      linkPhiManagedSessionKey: (key, cwd, sessionId) => {
        linked.push(`${key}:${cwd}:${sessionId}`)
        return `phi-session:${sessionId}`
      },
      resolveSessionPermissionMode: () => 'auto',
      getCurrentSessionPayload: () => {
        calls.push('payload')
        return {
          path: 'phi-session:target',
          phiSessionId: 'target',
          cwd: '/target',
          displayCwd: '/target',
          sessionGeneration: 2,
          permissionMode: 'ask',
          workMode: 'direct',
          status: 'idle',
          unreadKind: null
        }
      },
      getNoProjectTaskFolder: () => {
        calls.push(`default:${noProjectTaskFolder}`)
        return noProjectTaskFolder
      }
    },
    creation: {
      getSelectedThinkingLevel: () => 'high',
      ensureRemoteProjectAnchor: (projectId) => `/anchors/${projectId}`
    },
    invalidation: {
      loadedSkillNamesBySession: loadedSkills,
      cancelBrowserRun: () => calls.push('browser:cancel'),
      cleanupBrowserRunTabs: async () => {
        calls.push('browser:cleanup')
      },
      cancelPendingRunWaits: (scope) => calls.push(`waits:${JSON.stringify(scope)}`),
      cleanupSessionRecord: async (record) => {
        calls.push(`cleanup:${record ? 'record' : 'null'}`)
      }
    },
    browser: {
      getRegistry: () => browserRegistry
    },
    events: {
      notifySessionChanged: () => calls.push('notify'),
      writeAppLog: (entry) => calls.push(`log:${entry.event}`)
    },
    stores: {
      getProjectByCwd: () => projectByCwd as never,
      getProject: () => projectById as never,
      createPhiSession: (input) => {
        created.push(input)
        return { sessionId: `phi-${nextSessionId++}` } as never
      }
    }
  })

  return {
    switching,
    calls,
    created,
    linked,
    permissionModes,
    loadedSkills,
    setSelectedModel(value: typeof selectedModel) {
      selectedModel = value
    },
    setNoProjectTaskFolder(value: string) {
      noProjectTaskFolder = value
    },
    setProjectByCwd(value: Record<string, unknown> | undefined) {
      projectByCwd = value
    },
    setProjectById(value: Record<string, unknown> | undefined) {
      projectById = value
    },
    setActivePromptRun(value: TestPromptRun | undefined) {
      activePromptRun = value
    },
    setCurrentRecord(value: Record<string, unknown> | null, isCurrent = true) {
      currentRecord = value
      recordIsCurrent = isCurrent
    },
    setBrowserRegistry(value: typeof browserRegistry) {
      browserRegistry = value
    }
  }
}

test('disposeAndSwitchSession preserves state, payload, browser, notify, and return order', async () => {
  const harness = createSwitchingHarness()

  const result = await harness.switching.disposeAndSwitchSession(
    '/runtime.jsonl',
    '/workspace',
    'ask'
  )

  assert.equal(result.phiSessionId, 'target')
  assert.deepEqual(harness.calls, [
    'state:/runtime.jsonl:/workspace:ask',
    'payload',
    'browser:target',
    'notify'
  ])
})

test('disposeAndSwitchSession logs browser failures, does not throw, and honors notify false', async () => {
  const harness = createSwitchingHarness()
  harness.setBrowserRegistry({
    setActiveSession: async () => {
      harness.calls.push('browser:failed')
      throw new Error('presentation failed')
    }
  })

  const result = await harness.switching.disposeAndSwitchSession(
    '/runtime.jsonl',
    '/workspace',
    'ask',
    { notify: false }
  )

  assert.equal(result.path, 'phi-session:target')
  assert.deepEqual(harness.calls, [
    'state:/runtime.jsonl:/workspace:ask',
    'payload',
    'browser:failed',
    'log:browser_presentation_transition_failed'
  ])
})

test('disposeAndSwitchSession evaluates defaults and browser registry at each call', async () => {
  const harness = createSwitchingHarness()
  await harness.switching.disposeAndSwitchSession(undefined)
  harness.setNoProjectTaskFolder('/ordinary/second')
  harness.setBrowserRegistry(null)
  await harness.switching.disposeAndSwitchSession(undefined)

  assert.deepEqual(harness.calls, [
    'default:/ordinary/first',
    'state:undefined:/ordinary/first:auto',
    'payload',
    'browser:target',
    'notify',
    'default:/ordinary/second',
    'state:undefined:/ordinary/second:auto',
    'payload',
    'notify'
  ])
})

test('createPhiManagedSession preserves ordinary and local-project creation fields', () => {
  const harness = createSwitchingHarness()
  harness.setSelectedModel(undefined)
  assert.deepEqual(harness.switching.createPhiManagedSession('/ordinary', 'auto', '  New chat  '), {
    path: 'phi-session:phi-1',
    sessionId: 'phi-1',
    permissionMode: 'auto'
  })
  assert.deepEqual(harness.created[0], {
    kind: 'ordinary',
    projectId: null,
    cwd: '/ordinary',
    cwdRealPath: '/ordinary',
    title: 'New chat',
    permissionMode: 'auto',
    model: null,
    thinkingLevel: 'high'
  })

  harness.setProjectByCwd({
    id: 'project-1',
    workingDirectoryRealPath: '/real/project',
    defaultModel: { providerId: 'project-provider', modelId: 'project-model' },
    defaultThinkingLevel: 'medium'
  })
  harness.setSelectedModel({ providerId: 'global-provider', modelId: 'global-model' })
  assert.deepEqual(harness.switching.createPhiManagedSession('/project', 'ask'), {
    path: 'phi-session:phi-2',
    sessionId: 'phi-2',
    permissionMode: 'ask'
  })
  assert.deepEqual(harness.created[1], {
    kind: 'project',
    projectId: 'project-1',
    cwd: '/project',
    cwdRealPath: '/real/project',
    permissionMode: 'ask',
    model: { providerId: 'global-provider', modelId: 'global-model' },
    thinkingLevel: 'medium'
  })
  assert.deepEqual(harness.linked, [
    'phi-1:/ordinary:/ordinary:phi-1',
    'phi-2:/project:/project:phi-2'
  ])
  assert.equal(harness.permissionModes.get('canonical:phi-1:/ordinary'), 'auto')
  assert.equal(harness.permissionModes.get('canonical:phi-2:/project'), 'ask')
})

test('createRemoteManagedSession preserves project ownership and RPC automatic-model fallback', () => {
  const harness = createSwitchingHarness()
  harness.setProjectById({
    id: 'remote-1',
    location: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: '/cluster/project',
      canonicalRoot: '/cluster/project'
    },
    permissionMode: 'ask',
    defaultModel: { providerId: 'project-provider', modelId: 'project-model' },
    defaultThinkingLevel: 'xhigh'
  })
  harness.setSelectedModel(null)

  assert.deepEqual(harness.switching.createRemoteManagedSession('remote-1'), {
    path: 'phi-session:phi-1',
    sessionId: 'phi-1',
    cwd: '/anchors/remote-1',
    permissionMode: 'ask'
  })
  assert.deepEqual(harness.created[0], {
    kind: 'project',
    projectId: 'remote-1',
    projectLocation: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: '/cluster/project',
      canonicalRoot: '/cluster/project'
    },
    cwd: '/anchors/remote-1',
    cwdRealPath: '/anchors/remote-1',
    remoteRuntime: 'rpc',
    permissionMode: 'ask',
    model: { providerId: 'project-provider', modelId: 'project-model' },
    thinkingLevel: 'xhigh'
  })
})

test('invalidateAgentSession preserves generation, cancellation, notification, and cleanup order', async () => {
  const harness = createSwitchingHarness()
  const record = { promise: Promise.resolve({}) }
  const run = { phiSessionId: 'phi-current', runId: 'run-1', cancelled: false }
  harness.loadedSkills.set('phi-current', ['skill'])
  harness.setCurrentRecord(record)
  harness.setActivePromptRun(run)

  await harness.switching.invalidateAgentSession()

  assert.equal(run.cancelled, true)
  assert.equal(harness.loadedSkills.has('phi-current'), false)
  assert.deepEqual(harness.calls, [
    'lifecycle:advance',
    'prompt:generation',
    'browser:cancel',
    'browser:cleanup',
    'waits:{"sessionId":"phi-current","runId":"run-1"}',
    'notify',
    'cleanup:record'
  ])
})

test('getCurrentResolvedSession returns only the current record and suppresses stale errors', async () => {
  const harness = createSwitchingHarness()
  harness.setCurrentRecord({ promise: Promise.resolve({ session: 'current' }) }, true)
  assert.deepEqual(await harness.switching.getCurrentResolvedSession(), { session: 'current' })

  harness.setCurrentRecord({ promise: Promise.resolve({ session: 'old' }) }, false)
  assert.equal(await harness.switching.getCurrentResolvedSession(), null)

  harness.setCurrentRecord({ promise: Promise.reject(new StaleSessionError()) }, true)
  assert.equal(await harness.switching.getCurrentResolvedSession(), null)

  harness.setCurrentRecord({ promise: Promise.reject(new Error('failure')) }, true)
  await assert.rejects(harness.switching.getCurrentResolvedSession(), /failure/)
})
