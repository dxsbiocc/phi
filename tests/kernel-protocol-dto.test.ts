import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  approvalRespondParamsSchema,
  approvalRespondResultSchema,
  encodeFrame,
  eventsSubscribeParamsSchema,
  eventsSubscribeResultSchema,
  hostRequestFrameSchema,
  hostProgressFrameSchema,
  hostResponseFrameSchema,
  kernelEventFrameSchema,
  kernelHelloParamsSchema,
  kernelHelloResultSchema,
  kernelMethodParamsSchemas,
  kernelMethodResultSchemas,
  kernelRequestFrameSchema,
  kernelResponseFrameSchema,
  KERNEL_EVENT_APPROVAL_REQUESTED,
  KERNEL_EVENT_INTERACTION_CANCELLED,
  KERNEL_EVENT_MODELS_CHANGED,
  KERNEL_EVENT_RUN_COMPLETED,
  KERNEL_EVENT_SESSION_EVENT,
  KERNEL_EVENT_SESSION_STATE,
  KERNEL_V1_EVENT_TYPES,
  KERNEL_V1_METHODS,
  MAX_CLIENT_RUN_KEY_LENGTH,
  MAX_ERROR_DETAIL_BYTES,
  MAX_FRAME_BYTES,
  parseFrame,
  PHI_KERNEL_PROTOCOL_VERSION,
  protocolErrorCodes,
  protocolErrorSchema,
  ProtocolEncodeError,
  runCompletedPayloadSchema,
  resourcesReloadParamsSchema,
  resourcesReloadResultSchema,
  sessionAbortParamsSchema,
  sessionAbortResultSchema,
  sessionAdoptParamsSchema,
  sessionAdoptResultSchema,
  sessionCloseParamsSchema,
  sessionCloseResultSchema,
  sessionCreateParamsSchema,
  sessionCreateResultSchema,
  sessionLastRunSchema,
  sessionListEntrySchema,
  sessionOpenParamsSchema,
  sessionOpenResultSchema,
  sessionForkParamsSchema,
  sessionForkResultSchema,
  sessionPromptOptionsV1Schema,
  sessionPromptParamsSchema,
  sessionPromptResultSchema,
  sessionSummarySchema,
  shellJobsCancelParamsSchema,
  shellJobsCancelResultSchema,
  shellJobsListParamsSchema,
  shellJobsListResultSchema,
  sessionSnapshotParamsSchema,
  sessionSnapshotResultSchema,
  sessionsListParamsSchema,
  sessionsListResultSchema,
  type JsonValue,
  type ParsedFrame,
  type ProtocolErrorCode
} from '../src/shared/kernel-protocol'

const planState = {
  id: 'plan-1',
  sessionId: 'session-1',
  spec: {
    version: 1,
    goal: 'Inspect then write',
    steps: [
      {
        id: 'read',
        title: 'Read',
        instructions: 'Read the input.',
        acceptance: 'Input inspected.',
        dependsOn: [],
        access: 'read'
      }
    ]
  },
  status: 'paused',
  steps: { read: { status: 'failed', attempts: 1, error: 'injected failure' } },
  pause: { reason: 'step_failed', stepId: 'read' },
  replans: 0,
  createdAt: '2026-10-26T01:00:00.000Z',
  updatedAt: '2026-10-26T01:01:00.000Z'
} as const

const agentRun = {
  requestId: 'agent-request-1',
  runId: 'run_1',
  agent: 'PlanStep',
  task: 'Read the input.',
  state: 'running',
  origin: 'host',
  background: true,
  acceptedAt: '2026-10-26T01:00:00.000Z',
  startedAt: 1_798_000_000_000
} as const

const methodParams = {
  'kernel.hello': {
    protocol: PHI_KERNEL_PROTOCOL_VERSION,
    client: { name: 'phi-tests', version: '1.2.3' },
    hostCapabilities: ['settings.nextActionSuggestionsEnabled'],
    takeover: true
  },
  'session.create': {
    cwd: '/tmp/phi-project',
    model: { provider: 'phi-contract', id: 'contract-model' },
    thinkingLevel: 'high',
    sessionManager: { kind: 'memory' },
    enableToolApproval: true,
    autoCompaction: { enabled: false },
    resourceOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true
    },
    noTools: 'all'
  },
  'session.adopt': {
    source: {
      kind: 'omp-journal',
      path: '/tmp/phi-session.jsonl',
      cwd: '/tmp/phi-project',
      origin: 'desktop-local',
      phiSessionId: 'phi-session-1',
      expected: { sha256: 'a'.repeat(64), size: 1024 }
    },
    title: 'Adopted session',
    model: { provider: 'phi-contract', id: 'contract-model' },
    thinkingLevel: 'high'
  },
  'session.open': { sessionId: 'session-1' },
  'sessions.list': {},
  'session.prompt': {
    text: 'Hello',
    images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    clientRunKey: 'client-run-1',
    modelSelection: 'automatic',
    synthetic: false,
    userInitiated: true
  },
  'session.plan.enter': { execute: true },
  'session.plan.cancel': { replanRequestId: 'replan-1' },
  'planRuns.list': {},
  'planRuns.get': { runId: 'plan-1' },
  'planRuns.retryStep': { runId: 'plan-1', stepId: 'read' },
  'planRuns.skipStep': { runId: 'plan-1', stepId: 'read' },
  'planRuns.replan': { runId: 'plan-1' },
  'planRuns.stop': { runId: 'plan-1' },
  'agentRuns.start': {
    requestId: 'agent-request-1',
    agent: 'PlanStep',
    task: 'Read the input.'
  },
  'agentRuns.list': {},
  'agentRuns.wait': { runId: 'run_1', timeoutMs: 1_000 },
  'agentRuns.steer': { runId: 'run_1', message: 'Check the second file too.' },
  'agentRuns.stop': { runId: 'run_1' },
  'session.fork': {
    cut: { userMessages: ['first question', 'second question'], selectedIndex: 0 }
  },
  'resources.reload': {
    cwd: '/tmp/phi-project',
    additionalSkillPaths: ['/tmp/phi-skills'],
    noThemes: true
  },
  'shellJobs.list': {},
  'shellJobs.cancel': { jobId: 'job-1' },
  'session.abort': {},
  'session.snapshot': {},
  'session.setModel': { model: { provider: 'phi-contract', id: 'contract-model' } },
  'session.setThinkingLevel': { level: 'max' },
  'session.contextUsage': {},
  'session.compact': {},
  'session.getAutoCompaction': {},
  'session.setAutoCompaction': { enabled: true, thresholdPercent: 80 },
  'memory.read': {},
  'memory.deleteLesson': { index: 0, text: 'A durable lesson.' },
  'memory.clear': {},
  'session.close': {},
  'models.catalog': {},
  'modelAccess.configure': {
    endpoint: 'http://127.0.0.1:43123/v1/pi/stream',
    bearerToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH0123456789_-',
    models: [
      {
        provider: 'phi-contract',
        id: 'contract-model',
        name: 'Contract model',
        reasoning: true,
        input: ['text'],
        contextWindow: 32_000,
        maxTokens: 4_000
      }
    ]
  },
  'events.subscribe': { afterSeq: 4 },
  'approval.respond': {
    approvalId: 'approval-1',
    decision: 'denied',
    reason: 'Contract user denied'
  }
} as const

const methodResults = {
  'kernel.hello': {
    protocol: PHI_KERNEL_PROTOCOL_VERSION,
    kernel: { version: '0.1.0', ompVersion: '18.10.3' },
    kernelInstanceId: 'kernel-1',
    controllerGeneration: 2,
    capabilities: ['session.prompt'],
    lastSeq: 7,
    runtime: { home: '/tmp/home', agentDir: '/tmp/agent', pid: 4242 }
  },
  'session.create': {
    sessionId: 'session-1',
    sessionFile: '/tmp/agent/phi-kernel/sessions/session-1/journal.jsonl'
  },
  'session.adopt': {
    sessionId: 'session-adopted',
    migration: { state: 'complete', sourceSha256: 'a'.repeat(64) }
  },
  'session.open': { sessionId: 'session-1' },
  'sessions.list': {
    sessions: [
      {
        sessionId: 'session-1',
        cwd: '/tmp/phi-project',
        title: 'Durable session',
        createdAt: '2026-10-25T01:00:00.000Z',
        updatedAt: '2026-10-25T02:00:00.000Z',
        loaded: true,
        lastRun: { runId: 'run-1', status: 'completed' }
      },
      {
        sessionId: 'session-corrupt',
        error: { code: 'CORRUPT_SESSION', message: 'session.json is invalid' }
      }
    ]
  },
  'session.prompt': { accepted: true, runId: 'run-1' },
  'session.plan.enter': { enabled: true },
  'session.plan.cancel': { cancelled: true },
  'planRuns.list': [planState],
  'planRuns.get': planState,
  'planRuns.retryStep': planState,
  'planRuns.skipStep': planState,
  'planRuns.replan': { requestId: 'replan-1', runId: 'plan-1', prompt: 'Replan.' },
  'planRuns.stop': planState,
  'agentRuns.start': agentRun,
  'agentRuns.list': [agentRun],
  'agentRuns.wait': { run: agentRun, timedOut: false },
  'agentRuns.steer': { ok: true },
  'agentRuns.stop': { ok: true },
  'session.fork': { sessionId: 'session-fork-1' },
  'resources.reload': {
    extensions: [],
    skills: { skills: [], diagnostics: [] },
    prompts: [],
    themes: [],
    agentsFiles: [],
    systemPrompt: 'System prompt',
    appendSystemPrompt: ['Project context'],
    agents: { applied: true, added: ['Added'] }
  },
  'shellJobs.list': [
    {
      agentSessionId: 'session-1',
      jobId: 'job-1',
      state: 'running',
      command: 'sleep 30',
      startedAt: 1_798_000_000_000,
      output: 'started'
    }
  ],
  'shellJobs.cancel': { ok: true },
  'session.abort': { cancelled: true },
  'session.snapshot': {
    sessionId: 'session-1',
    messages: [{ role: 'assistant', content: 'Hello' }],
    model: { provider: 'phi-contract', id: 'contract-model' },
    thinkingLevel: 'high',
    cwd: '/tmp/phi-project',
    activeRunId: 'run-1',
    lastRun: { runId: 'run-0', status: 'unknown' }
  },
  'session.setModel': {
    sessionId: 'session-1',
    messages: [],
    model: { provider: 'phi-contract', id: 'contract-model' },
    thinkingLevel: 'high',
    cwd: '/tmp/phi-project'
  },
  'session.setThinkingLevel': {
    sessionId: 'session-1',
    messages: [],
    model: { provider: 'phi-contract', id: 'contract-model' },
    thinkingLevel: 'max',
    cwd: '/tmp/phi-project'
  },
  'session.contextUsage': {
    tokens: 128,
    contextWindow: 32_000,
    percent: 0.4,
    categories: [{ id: 'conversation', tokens: 128 }]
  },
  'session.compact': {
    summary: { summary: 'Earlier context', tokensBefore: 20_000, tokensAfter: 2_000 },
    state: {
      sessionId: 'session-1',
      messages: [],
      model: { provider: 'phi-contract', id: 'contract-model' },
      thinkingLevel: 'high',
      cwd: '/tmp/phi-project'
    }
  },
  'session.getAutoCompaction': {
    enabled: true,
    thresholdPercent: 80,
    thresholdTokens: 25_600
  },
  'session.setAutoCompaction': {
    enabled: true,
    thresholdPercent: 80,
    thresholdTokens: -1
  },
  'memory.read': {
    summary: 'Project summary',
    summaryUpdatedAt: null,
    lessons: [{ index: 0, text: 'A durable lesson.' }]
  },
  'memory.deleteLesson': {
    summary: 'Project summary',
    summaryUpdatedAt: null,
    lessons: []
  },
  'memory.clear': { cleared: true },
  'session.close': { closed: true },
  'models.catalog': {
    models: [
      {
        provider: 'phi-contract',
        id: 'contract-model',
        name: 'Contract model',
        reasoning: true,
        input: ['text'],
        contextWindow: 32_000,
        maxTokens: 4_000
      }
    ],
    providers: [{ provider: 'phi-contract', status: 'available' }]
  },
  'modelAccess.configure': { configured: true },
  'events.subscribe': { subscribed: true, lastSeq: 7 },
  'approval.respond': { accepted: true }
} as const

function roundTrip(frame: ParsedFrame): void {
  assert.deepEqual(parseFrame(encodeFrame(frame)), frame)
}

function assertProtocolError(value: ReturnType<typeof parseFrame>, code: ProtocolErrorCode): void {
  assert.equal('kind' in value, false)
  if ('kind' in value) return
  assert.equal(value.code, code)
}

function assertEncodeError(value: unknown, code: ProtocolErrorCode = 'INVALID_FRAME'): boolean {
  return value instanceof ProtocolEncodeError && value.code === code
}

describe('kernel protocol DTOs', () => {
  it('round-trips every v1 method request and result', () => {
    assert.deepEqual(Object.keys(kernelMethodParamsSchemas), KERNEL_V1_METHODS)
    assert.deepEqual(Object.keys(kernelMethodResultSchemas), KERNEL_V1_METHODS)

    for (const method of KERNEL_V1_METHODS) {
      const params = kernelMethodParamsSchemas[method].parse(methodParams[method]) as JsonValue
      const result = kernelMethodResultSchemas[method].parse(methodResults[method]) as JsonValue

      roundTrip({
        kind: 'request',
        id: `request-${method}`,
        method,
        params,
        generation: method === 'kernel.hello' ? 0 : 2,
        sessionId: 'session-1',
        runId: 'run-1',
        conversationId: 'reserved-conversation-1',
        taskId: 'reserved-task-1'
      })
      roundTrip({ kind: 'response', id: `request-${method}`, ok: true, result })
    }
  })

  it('round-trips event and host frames, including a protocol error', () => {
    const completed = runCompletedPayloadSchema.parse({ runId: 'run-1', status: 'completed' })
    roundTrip({
      kind: 'event',
      seq: 8,
      type: 'run.completed',
      payload: completed,
      sessionId: 'session-1',
      runId: 'run-1'
    })
    roundTrip({
      kind: 'host.request',
      id: 'host-1',
      capability: 'desktop.example',
      params: { value: 1 },
      sessionId: 'session-1',
      agentRunId: 'run-1'
    })
    roundTrip({ kind: 'host.response', id: 'host-1', ok: true, result: { value: 2 } })
    roundTrip({ kind: 'host.progress', id: 'host-1', progress: { content: [] } })
    roundTrip({
      kind: 'host.response',
      id: 'host-2',
      ok: false,
      error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Capability is not registered.' }
    })
    roundTrip({
      kind: 'response',
      id: 'request-1',
      ok: false,
      error: {
        code: 'VERSION_UNSUPPORTED',
        message: 'Protocol major versions do not match.',
        detail: { local: { major: 1, minor: 0 }, peer: { major: 2, minor: 0 } }
      }
    })
  })

  it('exports the closed v1 event vocabulary', () => {
    assert.deepEqual(KERNEL_V1_EVENT_TYPES, [
      KERNEL_EVENT_SESSION_EVENT,
      KERNEL_EVENT_SESSION_STATE,
      KERNEL_EVENT_APPROVAL_REQUESTED,
      KERNEL_EVENT_INTERACTION_CANCELLED,
      KERNEL_EVENT_RUN_COMPLETED,
      KERNEL_EVENT_MODELS_CHANGED,
      'planRun.updated',
      'agentRun.started',
      'agentRun.step',
      'agentRun.finished',
      'agentRun.reported'
    ])
    assert.deepEqual(KERNEL_V1_EVENT_TYPES, [
      'session.event',
      'session.state',
      'approval.requested',
      'interaction.cancelled',
      'run.completed',
      'models.changed',
      'planRun.updated',
      'agentRun.started',
      'agentRun.step',
      'agentRun.finished',
      'agentRun.reported'
    ])
  })

  it('allows identity-shaped data in opaque output and host capability payloads', () => {
    roundTrip({
      kind: 'event',
      seq: 1,
      type: 'message.updated',
      payload: {
        message: { role: 'assistant', content: { permissions: ['read'] } },
        executor: 'reported-tool-metadata'
      }
    })
    roundTrip({
      kind: 'response',
      id: 'history',
      ok: true,
      result: {
        messages: [{ role: 'user', content: { permissions: ['workspace'] } }]
      }
    })
    roundTrip({
      kind: 'host.response',
      id: 'host-result',
      ok: true,
      result: { member: { role: 'owner' }, principal: 'desktop' }
    })
    roundTrip({
      kind: 'host.request',
      id: 'host-request',
      capability: 'desktop.stat',
      params: { role: 'directory', permissions: 0o755, nested: { executor: true } }
    })
  })

  it('exports strict schemas for all public DTO shapes', () => {
    const schemaCases = [
      [kernelHelloParamsSchema, methodParams['kernel.hello']],
      [kernelHelloResultSchema, methodResults['kernel.hello']],
      [sessionCreateParamsSchema, methodParams['session.create']],
      [sessionCreateResultSchema, methodResults['session.create']],
      [sessionAdoptParamsSchema, methodParams['session.adopt']],
      [sessionAdoptResultSchema, methodResults['session.adopt']],
      [sessionOpenParamsSchema, methodParams['session.open']],
      [sessionOpenResultSchema, methodResults['session.open']],
      [sessionsListParamsSchema, methodParams['sessions.list']],
      [sessionsListResultSchema, methodResults['sessions.list']],
      [sessionPromptParamsSchema, methodParams['session.prompt']],
      [sessionPromptResultSchema, methodResults['session.prompt']],
      [sessionForkParamsSchema, methodParams['session.fork']],
      [sessionForkResultSchema, methodResults['session.fork']],
      [resourcesReloadParamsSchema, methodParams['resources.reload']],
      [resourcesReloadResultSchema, methodResults['resources.reload']],
      [shellJobsListParamsSchema, methodParams['shellJobs.list']],
      [shellJobsListResultSchema, methodResults['shellJobs.list']],
      [shellJobsCancelParamsSchema, methodParams['shellJobs.cancel']],
      [shellJobsCancelResultSchema, methodResults['shellJobs.cancel']],
      [sessionAbortParamsSchema, methodParams['session.abort']],
      [sessionAbortResultSchema, methodResults['session.abort']],
      [sessionSnapshotParamsSchema, methodParams['session.snapshot']],
      [sessionSnapshotResultSchema, methodResults['session.snapshot']],
      [sessionCloseParamsSchema, methodParams['session.close']],
      [sessionCloseResultSchema, methodResults['session.close']],
      [eventsSubscribeParamsSchema, methodParams['events.subscribe']],
      [eventsSubscribeResultSchema, methodResults['events.subscribe']],
      [approvalRespondParamsSchema, methodParams['approval.respond']],
      [approvalRespondResultSchema, methodResults['approval.respond']],
      [
        kernelRequestFrameSchema,
        {
          kind: 'request',
          id: 'r',
          method: 'session.create',
          params: {},
          generation: 1
        }
      ],
      [kernelResponseFrameSchema, { kind: 'response', id: 'r', ok: true, result: null }],
      [kernelEventFrameSchema, { kind: 'event', seq: 1, type: 'ready', payload: null }],
      [
        hostRequestFrameSchema,
        {
          kind: 'host.request',
          id: 'h',
          capability: 'desktop.example',
          params: null
        }
      ],
      [hostResponseFrameSchema, { kind: 'host.response', id: 'h', ok: true, result: null }],
      [hostProgressFrameSchema, { kind: 'host.progress', id: 'h', progress: { content: [] } }]
    ] as const

    for (const [schema, valid] of schemaCases) {
      assert.equal(schema.safeParse({ ...valid, unexpected: true }).success, false)
    }
  })

  it('rejects malformed adoption integrity metadata', () => {
    assert.equal(
      sessionAdoptParamsSchema.safeParse({
        ...methodParams['session.adopt'],
        source: {
          ...methodParams['session.adopt'].source,
          expected: { sha256: 'not-a-sha256', size: 1024 }
        }
      }).success,
      false
    )
    assert.equal(
      sessionAdoptResultSchema.safeParse({
        ...methodResults['session.adopt'],
        migration: {
          ...methodResults['session.adopt'].migration,
          sourceSha256: 'not-a-sha256'
        }
      }).success,
      false
    )
  })

  it('supports persistent sessions and durable run identity with bounded keys', () => {
    assert.equal(
      sessionCreateParamsSchema.safeParse({
        ...methodParams['session.create'],
        sessionManager: { kind: 'persistent' }
      }).success,
      true
    )
    assert.equal(
      sessionPromptParamsSchema.safeParse({
        text: 'Hello',
        clientRunKey: 'x'.repeat(MAX_CLIENT_RUN_KEY_LENGTH)
      }).success,
      true
    )
    assert.equal(
      sessionPromptParamsSchema.safeParse({
        text: 'Hello',
        clientRunKey: 'x'.repeat(MAX_CLIENT_RUN_KEY_LENGTH + 1)
      }).success,
      false
    )
    assert.equal(
      sessionPromptParamsSchema.safeParse({ text: 'Hello', clientRunKey: '' }).success,
      false
    )
  })

  it('keeps public prompt options versioned and trusted fields top-level', () => {
    const options = {
      version: 1,
      images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      expandPromptTemplates: false,
      skipCompactionCheck: true
    } as const

    assert.deepEqual(sessionPromptOptionsV1Schema.parse(options), options)
    assert.equal(sessionPromptParamsSchema.safeParse({ text: 'Hello', options }).success, true)
    assert.equal(
      sessionPromptOptionsV1Schema.safeParse({ ...options, synthetic: true }).success,
      false
    )
    assert.equal(
      sessionPromptOptionsV1Schema.safeParse({ ...options, userInitiated: true }).success,
      false
    )
    assert.equal(
      sessionPromptParamsSchema.safeParse({ text: 'Hello', synthetic: true }).success,
      true
    )
    assert.equal(
      sessionPromptParamsSchema.safeParse({ text: 'Hello', userInitiated: true }).success,
      true
    )
    assert.equal(sessionPromptOptionsV1Schema.safeParse({ images: options.images }).success, false)
    assert.equal(
      sessionPromptParamsSchema.safeParse({
        text: 'Hello',
        trustedOptions: { version: 1, synthetic: true }
      }).success,
      false
    )
  })

  it('keys session forks from request context rather than client-supplied identity', () => {
    assert.deepEqual(sessionForkParamsSchema.parse({}), {})
    assert.deepEqual(
      sessionForkParamsSchema.parse({
        cut: { userMessages: ['first question', 'second question'], selectedIndex: 0 }
      }),
      { cut: { userMessages: ['first question', 'second question'], selectedIndex: 0 } }
    )
    assert.equal(
      sessionForkParamsSchema.safeParse({
        cut: { userMessages: ['first question'], selectedIndex: 1 }
      }).success,
      false
    )
    assert.equal(
      sessionForkParamsSchema.safeParse({ cut: { userMessages: [], selectedIndex: 0 } }).success,
      false
    )
    assert.equal(
      sessionForkParamsSchema.safeParse({ cut: { userMessages: ['first question'] } }).success,
      false
    )
    assertProtocolError(
      parseFrame(
        JSON.stringify({
          kind: 'request',
          id: 'invalid-fork-cut',
          method: 'session.fork',
          params: { cut: { userMessages: ['first question'], selectedIndex: 1 } },
          generation: 1
        })
      ),
      'INVALID_PARAMS'
    )
    assert.equal(sessionForkParamsSchema.safeParse({ sessionId: 'forged-source' }).success, false)
    assert.deepEqual(sessionForkResultSchema.parse({ sessionId: 'forked-session' }), {
      sessionId: 'forked-session'
    })
  })

  it('accepts trusted session resource snapshots and rejects credential-bearing MCP config', () => {
    const resources = {
      cwd: '/tmp/phi-project',
      model: { provider: 'provider', id: 'model' },
      sessionManager: { kind: 'memory' as const },
      phiAgents: [
        {
          name: 'Wrapper',
          description: 'Runs workflows.',
          tools: ['bash'],
          skills: ['nextflow'],
          visibility: 'entry' as const,
          warnings: [],
          systemPrompt: 'Run the workflow.',
          source: 'phi' as const,
          filePath: '/trusted/Wrapper.md'
        }
      ],
      personaMarkdown: '# Persona',
      projectBound: true,
      memory: { enabled: true, learn: false },
      contextFiles: [{ path: '/tmp/phi-project/AGENTS.md', content: 'Project rules' }],
      mcpServers: [
        {
          name: 'fixture',
          config: { type: 'stdio' as const, command: 'fixture-server', args: ['--stdio'] }
        }
      ],
      desktopMcp: { bindingId: 'desktop-binding-1' },
      environment: { ref: 'phi:python@1' }
    }

    assert.equal(sessionCreateParamsSchema.safeParse(resources).success, true)
    assert.equal(
      sessionOpenParamsSchema.safeParse({
        sessionId: 'persistent-session',
        resources: {
          projectBound: resources.projectBound,
          personaMarkdown: resources.personaMarkdown,
          contextFiles: resources.contextFiles,
          mcpServers: resources.mcpServers,
          desktopMcp: resources.desktopMcp,
          environment: resources.environment
        }
      }).success,
      true
    )
    assert.equal(
      sessionCreateParamsSchema.safeParse({
        ...resources,
        mcpServers: [
          {
            name: 'fixture',
            config: {
              type: 'http',
              url: 'https://example.test/mcp',
              auth: { token: 'must-stay-with-host-broker' }
            }
          }
        ]
      }).success,
      false
    )
    assert.equal(
      sessionCreateParamsSchema.safeParse({
        ...resources,
        desktopMcp: {
          bindingId: 'desktop-binding-1',
          credentials: { token: 'must-stay-on-desktop' }
        }
      }).success,
      false
    )
  })

  it('types resource reload and shell job methods without client-controlled host paths', () => {
    assert.equal(
      resourcesReloadParamsSchema.safeParse(methodParams['resources.reload']).success,
      true
    )
    assert.equal(
      resourcesReloadParamsSchema.safeParse({
        ...methodParams['resources.reload'],
        agentDir: '/untrusted/agent'
      }).success,
      false
    )
    assert.equal(
      resourcesReloadResultSchema.safeParse({
        ...methodResults['resources.reload'],
        agents: {
          applied: false,
          reason: 'requires_session_refresh',
          changed: ['Added']
        }
      }).success,
      true
    )
    assert.equal(shellJobsListResultSchema.safeParse(methodResults['shellJobs.list']).success, true)
    assert.equal(
      shellJobsListResultSchema.safeParse([
        { ...methodResults['shellJobs.list'][0], state: 'unknown' }
      ]).success,
      false
    )
  })

  it('represents durable session summaries, interrupted runs, and corrupt manifests', () => {
    assert.equal(
      sessionSummarySchema.safeParse({
        sessionId: 'session-1',
        cwd: '/tmp/phi-project',
        createdAt: '2026-10-25T01:00:00.000Z',
        updatedAt: '2026-10-25T02:00:00.000Z',
        loaded: false,
        lastRun: { runId: 'run-1', status: 'unknown' }
      }).success,
      true
    )
    assert.equal(
      sessionLastRunSchema.safeParse({ runId: 'run-1', status: 'running' }).success,
      false
    )
    assert.equal(
      sessionListEntrySchema.safeParse({
        sessionId: 'session-corrupt',
        error: { code: 'CORRUPT_SESSION', message: 'session.json is truncated' }
      }).success,
      true
    )
    assert.equal(
      sessionListEntrySchema.safeParse({
        sessionId: 'session-corrupt',
        error: { code: 'OTHER', message: 'session.json is truncated' }
      }).success,
      false
    )
  })

  it('rejects every non-serializable input without silently dropping values', () => {
    const frame = (result: unknown): ParsedFrame =>
      ({ kind: 'response', id: 'request-1', ok: true, result }) as ParsedFrame
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle

    class Instance {
      value = 1
    }

    for (const value of [
      () => undefined,
      Symbol('value'),
      1n,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      cycle,
      new Instance()
    ]) {
      assert.throws(
        () => encodeFrame(frame(value)),
        (error) => assertEncodeError(error)
      )
    }

    const symbolKey = { visible: true, [Symbol('hidden')]: true }
    const sparse = [1, 2, 3]
    delete sparse[1]
    assert.throws(
      () => encodeFrame(frame(symbolKey)),
      (error) => assertEncodeError(error)
    )
    assert.throws(
      () => encodeFrame(frame(sparse)),
      (error) => assertEncodeError(error)
    )
  })

  it('rejects malformed, unknown, and structurally invalid frames', () => {
    assertProtocolError(parseFrame('{'), 'INVALID_FRAME')
    assertProtocolError(parseFrame(JSON.stringify({ kind: 'mystery' })), 'INVALID_FRAME')
    assertProtocolError(
      parseFrame(
        JSON.stringify({
          kind: 'request',
          id: 'request-1',
          method: 'session.create',
          params: {},
          generation: 1,
          unexpected: true
        })
      ),
      'INVALID_FRAME'
    )
    assertProtocolError(
      parseFrame(
        JSON.stringify({
          kind: 'request',
          id: 'request-1',
          method: 'session.prompt',
          params: { text: 'hello', unexpected: true },
          generation: 1
        })
      ),
      'INVALID_PARAMS'
    )
  })

  it('rejects self-reported identity and permissions at known request control boundaries', () => {
    for (const field of ['role', 'member', 'identity', 'principal', 'executor', 'permissions']) {
      assertProtocolError(
        parseFrame(
          JSON.stringify({
            kind: 'request',
            id: `known-${field}`,
            method: 'session.prompt',
            params: { text: 'hello', [field]: 'self-reported' },
            generation: 1
          })
        ),
        'INVALID_PARAMS'
      )
      assertProtocolError(
        parseFrame(
          JSON.stringify({
            kind: 'request',
            id: `envelope-${field}`,
            method: 'session.prompt',
            params: { text: 'hello' },
            generation: 1,
            [field]: 'self-reported'
          })
        ),
        'INVALID_FRAME'
      )
    }

    assertProtocolError(
      parseFrame(
        JSON.stringify({
          kind: 'request',
          id: 'hello-client-role',
          method: 'kernel.hello',
          params: {
            protocol: PHI_KERNEL_PROTOCOL_VERSION,
            client: { name: 'phi-tests', version: '1.0.0', role: 'controller' }
          },
          generation: 0
        })
      ),
      'INVALID_PARAMS'
    )
  })

  it('enforces the independent frame and error-detail byte limits', () => {
    const prefix = '{"kind":"event","seq":1,"type":"large","payload":"'
    const suffix = '"}'
    const exactPayload = `${prefix}${'x'.repeat(MAX_FRAME_BYTES - 1 - prefix.length - suffix.length)}${suffix}`
    const oversized = `${prefix}${'x'.repeat(MAX_FRAME_BYTES - prefix.length - suffix.length)}${suffix}`

    assert.equal(new TextEncoder().encode(`${exactPayload}\n`).byteLength, MAX_FRAME_BYTES)
    assert.equal('kind' in parseFrame(exactPayload), true)
    assert.equal(
      new TextEncoder().encode(encodeFrame(JSON.parse(exactPayload) as ParsedFrame)).byteLength,
      MAX_FRAME_BYTES
    )
    assert.equal(new TextEncoder().encode(`${oversized}\n`).byteLength, MAX_FRAME_BYTES + 1)
    assertProtocolError(parseFrame(oversized), 'FRAME_TOO_LARGE')
    assert.throws(
      () => encodeFrame(JSON.parse(oversized) as ParsedFrame),
      (error) => assertEncodeError(error, 'FRAME_TOO_LARGE')
    )

    const largestDetail = 'x'.repeat(MAX_ERROR_DETAIL_BYTES - 2)
    assert.equal(
      protocolErrorSchema.safeParse({
        code: 'INTERNAL',
        message: 'Failure.',
        detail: largestDetail
      }).success,
      true
    )
    assert.equal(
      protocolErrorSchema.safeParse({
        code: 'INTERNAL',
        message: 'Failure.',
        detail: `${largestDetail}x`
      }).success,
      false
    )
  })

  it('keeps the error-code vocabulary closed', () => {
    assert.deepEqual(protocolErrorCodes, [
      'VERSION_UNSUPPORTED',
      'NOT_NEGOTIATED',
      'STALE_GENERATION',
      'NOT_CONTROLLER',
      'UNKNOWN_METHOD',
      'INVALID_FRAME',
      'INVALID_PARAMS',
      'FRAME_TOO_LARGE',
      'DUPLICATE_REQUEST',
      'SESSION_NOT_FOUND',
      'SESSION_BUSY',
      'MODEL_UNAVAILABLE',
      'MODEL_UNREACHABLE',
      'MODEL_UNAUTHENTICATED',
      'MODEL_CONNECTION_LOST',
      'CAPABILITY_UNAVAILABLE',
      'REPLAY_GAP',
      'CANCELLED',
      'INTERNAL'
    ])
    assert.equal(
      protocolErrorSchema.safeParse({
        code: 'MADE_UP',
        message: 'No.'
      }).success,
      false
    )
  })
})
