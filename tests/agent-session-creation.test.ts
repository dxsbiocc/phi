import assert from 'node:assert/strict'
import test from 'node:test'

import { SessionLifecycle } from '../src/main/agent/session/session-lifecycle'
import {
  createAgentSessionCreation,
  type AgentSessionCreationDeps
} from '../src/main/session-runtime/agent-session-creation'

interface TestPromptRun {
  phiSessionId: string
  runId: string
  cancelled: boolean
}

interface TestSession {
  sessionFile?: string
  runtimeSessionId: string
  abort(): Promise<void>
  dispose(): Promise<void>
  subscribe(listener: (event: { type: string }) => void): () => void
}

interface TestResult {
  session: TestSession
}

function creationHarness(options: { staleAfterCreate?: boolean; abortFailure?: boolean } = {}): {
  creation: ReturnType<typeof createAgentSessionCreation<TestPromptRun, TestResult>>
  lifecycle: SessionLifecycle<TestResult>
  log: string[]
  control: { assertCurrent(): void }
} {
  const log: string[] = []
  let stale = false
  const lifecycle = new SessionLifecycle<TestResult>()
  const session: TestSession = {
    sessionFile: '/runtime.jsonl',
    runtimeSessionId: 'runtime-1',
    abort: async () => {
      log.push('abort')
    },
    dispose: async () => {
      log.push('dispose')
    },
    subscribe: () => () => undefined
  }
  const deps = {
    workspace: {
      agentDir: '/agent',
      isRemoteOmpRpcEnabled: () => false,
      getPersonaMarkdown: () => '',
      getBundledAgentsDir: () => '/bundled'
    },
    state: {
      sessionState: {
        sessionKey: 'session-key',
        sessionPath: undefined,
        cwd: '/work',
        permissionMode: 'auto',
        updateCreatedSessionPath: () => log.push('state.write')
      },
      sessionKeys: {
        canonicalize: (key: string) => key,
        phiSessionIdFor: () => undefined,
        recordOrigin: () => log.push('origin.write'),
        sameCanonical: (left: string, right: string) => left === right
      },
      lifecycles: {
        forKey: () => lifecycle,
        waitForCleanup: async () => {
          log.push('await.cleanup')
        },
        installAbortController: () => log.push('controller.write')
      },
      promptRuns: {
        generationFor: () => 0,
        activeRun: () => undefined
      },
      modelSelections: { set: () => log.push('model.write') }
    },
    context: {
      getPromptGeneration: () => 0,
      getActiveRun: () => undefined,
      findManifest: () => null,
      getProject: () => undefined,
      getProjectByCwd: () => undefined,
      normalizeMemory: () => ({ enabled: false, learn: false }),
      remoteBinding: () => 'binding'
    },
    sessions: {
      resolution: {
        resolveSessionModelSelection: () => null,
        resolveSessionThinkingLevel: () => 'high'
      },
      origins: { currentRuntimeOriginScope: () => undefined },
      findById: () => null,
      updateManifest: () => log.push('manifest.write'),
      appendEvent: () => ({ type: 'stored' }),
      runtimeSessionPathForSnapshot: () => undefined,
      uiSessionPathForKey: () => null,
      linkPromptRunRuntimeSessionPath: () => log.push('link.run'),
      linkMaterializedRuntimeSessionPath: () => log.push('link.materialized'),
      notifySessionChanged: () => log.push('notify')
    },
    runtime: {
      getModelRuntime: async () => {
        log.push('await.model-runtime')
        return { providers: [] }
      },
      resolveRuntimeModelSelection: () => null,
      selectionThinking: (_model: unknown, desired: string) => ({ phi: desired }),
      createSessionManager: () => ({ kind: 'memory' }),
      createRemoteSessionManager: () => ({ kind: 'memory' }),
      createAgentSession: async () => {
        log.push('await.sdk-create')
        if (options.staleAfterCreate) stale = true
        return { session }
      },
      ownsRemoteRuntimeSession: () => false,
      projectRemoteRuntimeRoot: () => ({ configured: '/runtime' }),
      requireProject: () => {
        throw new Error('unused')
      },
      loadRemoteProjectInstructions: async () => null
    },
    resources: {
      notebook: {
        getProjectByCwd: () => undefined,
        status: () => ({ state: 'idle', hasEndpoint: false }),
        activePath: () => undefined,
        list: () => ({ notebooks: [], truncated: false })
      },
      createApprovalExtensions: () => [],
      approvalDependencies: undefined,
      writeAppLog: () => undefined
    },
    linking: {
      recordRuntimeOrigin: () => log.push('runtime-origin.write')
    },
    events: {
      publish: () => log.push('publish'),
      subscribeToCreatedSession: () => log.push('subscribe')
    },
    cleanup: {
      getSessionControllerKey: (snapshot: { path?: string; cwd: string }, generation: number) =>
        `${snapshot.path ?? `fresh:${snapshot.cwd}`}:${generation}`,
      abortAndDisposeSession: async (value: TestSession) => {
        await value.abort()
        await value.dispose()
      },
      abortSessionWithoutCancellingApprovals: async (value: TestSession) => {
        await value.abort()
        if (options.abortFailure) throw new Error('abort cleanup failed')
      },
      logUnexpectedError: () => log.push('unexpected')
    },
    services: {
      emptyAgentScan: () => ({ agents: [], diagnostics: [] }),
      discoverLocalAgents: () => {
        log.push('discover.agents')
        return { agents: [], diagnostics: [] }
      },
      loadRemoteAgents: async () => ({ agents: [], diagnostics: [] }),
      loadRemoteSkills: async () => undefined,
      loadRemoteMcp: async () => undefined,
      createResourceLookup: () => ({
        sessionId: '',
        projectId: '',
        cwd: '/work',
        agentDir: '/agent'
      }),
      assembleResources: () => {
        log.push('assemble.resources')
        return {
          remoteContextFiles: null,
          agentScan: { agents: [], diagnostics: [] },
          remoteMcpCatalog: undefined,
          resourceLoader: {
            reload: async () => {
              log.push('await.resource-reload')
            }
          },
          personaMarkdown: ''
        }
      },
      diagnosticLog: () => ({ event: 'agent_definition_warning', metadata: {} }),
      buildOptions: (input: unknown) => input
    }
  } as unknown as AgentSessionCreationDeps<TestPromptRun, TestResult>
  const creation = createAgentSessionCreation(deps)
  const control = {
    assertCurrent: () => {
      log.push('check')
      if (stale) throw new Error('stale-owner')
    }
  }
  return { creation, lifecycle, log, control }
}

test('agent session creation keeps phase awaits, currency checks, writes, and links in order', async () => {
  const { creation, log, control } = creationHarness()

  await creation.getAgentSession(
    'session-key',
    { path: undefined, cwd: '/work', permissionMode: 'auto' },
    control
  )

  assert.deepEqual(log, [
    'check',
    'check',
    'await.cleanup',
    'check',
    'check',
    'await.model-runtime',
    'check',
    'controller.write',
    'discover.agents',
    'check',
    'check',
    'check',
    'assemble.resources',
    'await.resource-reload',
    'check',
    'await.sdk-create',
    'check',
    'origin.write',
    'link.materialized',
    'state.write',
    'subscribe'
  ])
})

test('agent session creation aborts, disposes, then rethrows when ownership becomes stale', async () => {
  const { creation, log, control } = creationHarness({
    staleAfterCreate: true,
    abortFailure: true
  })

  await assert.rejects(
    creation.getAgentSession(
      'session-key',
      { path: undefined, cwd: '/work', permissionMode: 'auto' },
      control
    ),
    /stale-owner/
  )

  assert.deepEqual(log.slice(-5), ['await.sdk-create', 'check', 'abort', 'unexpected', 'dispose'])
})
