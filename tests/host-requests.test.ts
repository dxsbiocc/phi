import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAgentInteractionRequest,
  type AgentInteractionPromptRun,
  type AgentInteractionRequestDeps
} from '../src/main/agent/host-requests/agent-interaction-request'
import {
  createDeliverablesPresentation,
  type DeliverablesPresentationDeps,
  type DeliverablesPromptRun
} from '../src/main/agent/host-requests/deliverables-presentation'
import {
  createHostConfirmations,
  type HostConfirmationDeps,
  type HostConfirmationPromptRun
} from '../src/main/agent/host-requests/host-confirmations'
import {
  createPlanReviewRequest,
  type PlanReviewPromptRun,
  type PlanReviewRequestDeps
} from '../src/main/agent/host-requests/plan-review-request'

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function deliverablesFixture(): {
  deps: DeliverablesPresentationDeps<Record<string, unknown>>
  run: DeliverablesPromptRun
  events: Array<Record<string, unknown>>
  broadcasts: Array<Record<string, unknown>>
  setRun(value: DeliverablesPromptRun | null): void
  setRemoteAnchor(value: boolean): void
  setRemoteOwned(value: boolean): void
  setBinding(value: string): void
  setManifest(
    value: ReturnType<DeliverablesPresentationDeps<unknown>['sessions']['findById']>
  ): void
  setProject(value: ReturnType<DeliverablesPresentationDeps<unknown>['projects']['getById']>): void
  setRemoteValidation(
    value: DeliverablesPresentationDeps<Record<string, unknown>>['files']['validateRemote']
  ): void
} {
  const run: DeliverablesPromptRun = {
    phiSessionId: 'phi-1',
    runId: 'run-1',
    cwd: '/workspace',
    projectId: 'project-1',
    cancelled: false
  }
  let activeRun: DeliverablesPromptRun | null = run
  let remoteAnchor = false
  let remoteOwned = false
  let binding = 'binding-1'
  let manifest: ReturnType<DeliverablesPresentationDeps<unknown>['sessions']['findById']> = {
    projectId: 'project-1',
    projectLocation: {
      kind: 'local'
    }
  }
  let project: ReturnType<DeliverablesPresentationDeps<unknown>['projects']['getById']> = {
    location: { kind: 'local' }
  }
  let validateRemote: DeliverablesPresentationDeps<
    Record<string, unknown>
  >['files']['validateRemote'] = async (_identity, value) => value as never
  const events: Array<Record<string, unknown>> = []
  const broadcasts: Array<Record<string, unknown>> = []
  const deps: DeliverablesPresentationDeps<Record<string, unknown>> = {
    agentDir: '/agent',
    fields: { optionalStringField },
    runs: { findByRuntimeSessionId: () => activeRun },
    sessions: { findById: () => manifest },
    projects: { getById: () => project },
    remote: {
      isProjectAnchorPath: () => remoteAnchor,
      ownsRuntimeSession: () => remoteOwned,
      bindingKey: () => binding
    },
    files: {
      validateLocal: (_cwd, value) => value as never,
      validateRemote: (...args) => validateRemote(...args),
      statSize: () => 17
    },
    timeline: {
      append: (_sessionId, event) => {
        const stored = { ...event, sequence: events.length + 1 }
        events.push(stored)
        return stored
      },
      broadcast: (_sessionId, event) => broadcasts.push(event)
    }
  }
  return {
    deps,
    run,
    events,
    broadcasts,
    setRun: (value) => {
      activeRun = value
    },
    setRemoteAnchor: (value) => {
      remoteAnchor = value
    },
    setRemoteOwned: (value) => {
      remoteOwned = value
    },
    setBinding: (value) => {
      binding = value
    },
    setManifest: (value) => {
      manifest = value
    },
    setProject: (value) => {
      project = value
    },
    setRemoteValidation: (value) => {
      validateRemote = value
    }
  }
}

test('deliverables reject malformed requests and unavailable runs before inspecting files', async () => {
  const fixture = deliverablesFixture()
  const handlers = createDeliverablesPresentation(fixture.deps)
  await assert.rejects(handlers.handlePresentFilesRequest({}), /Invalid file delivery request/)
  await assert.rejects(
    handlers.handlePresentFilesRequest({
      runtimeSessionId: 'runtime-1',
      toolCallId: 'x'.repeat(201)
    }),
    /Invalid file delivery request/
  )
  fixture.setRun(null)
  await assert.rejects(
    handlers.handlePresentFilesRequest({ runtimeSessionId: 'runtime-1', toolCallId: 'call-1' }),
    /No active conversation/
  )
  fixture.setRun({ ...fixture.run, cancelled: true })
  await assert.rejects(
    handlers.handlePresentFilesRequest({ runtimeSessionId: 'runtime-1', toolCallId: 'call-1' }),
    /No active conversation/
  )
})

test('deliverables reject every incomplete remote project identity', async () => {
  for (const field of [
    'projectId',
    'manifestProject',
    'manifestLocation',
    'projectLocation',
    'hostProfile',
    'remoteRoot',
    'canonicalRoot'
  ] as const) {
    const fixture = deliverablesFixture()
    fixture.setRemoteAnchor(true)
    const manifest = {
      projectId: 'project-1',
      projectLocation: {
        kind: 'ssh',
        hostProfileId: 'host-1',
        remoteRoot: '/remote',
        canonicalRoot: '/canonical'
      }
    }
    const project = {
      location: {
        kind: 'ssh',
        hostProfileId: 'host-1',
        remoteRoot: '/remote',
        canonicalRoot: '/canonical'
      }
    }
    fixture.setManifest(manifest)
    fixture.setProject(project)
    if (field === 'projectId') delete fixture.run.projectId
    if (field === 'manifestProject') manifest.projectId = 'different'
    if (field === 'manifestLocation') manifest.projectLocation.kind = 'local'
    if (field === 'projectLocation') project.location.kind = 'local'
    if (field === 'hostProfile') manifest.projectLocation.hostProfileId = 'host-2'
    if (field === 'remoteRoot') manifest.projectLocation.remoteRoot = '/other'
    if (field === 'canonicalRoot') manifest.projectLocation.canonicalRoot = '/other'
    const handlers = createDeliverablesPresentation(fixture.deps)
    assert.throws(
      () =>
        handlers.presentScriptArtifacts({
          runtimeSessionId: 'runtime-1',
          toolCallId: 'call-1',
          artifacts: [],
          envId: 'env-1'
        }),
      /Remote project identity is unavailable/
    )
  }
})

test('deliverables preserve remote inspection and commit ordering', async () => {
  const fixture = deliverablesFixture()
  fixture.setRemoteAnchor(true)
  fixture.setManifest({
    projectId: 'project-1',
    projectLocation: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: '/remote',
      canonicalRoot: '/canonical'
    }
  })
  fixture.setProject({
    location: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: '/remote',
      canonicalRoot: '/canonical'
    }
  })
  const calls: string[] = []
  fixture.deps.remote.bindingKey = () => {
    calls.push('binding')
    return 'binding-1'
  }
  fixture.setRemoteValidation(async () => {
    calls.push('inspect')
    return [{ path: 'ssh://host/report.txt', displayPath: 'report.txt', bytes: 7 }]
  })
  const append = fixture.deps.timeline.append
  fixture.deps.timeline.append = (sessionId, event) => {
    calls.push('append')
    return append(sessionId, event)
  }
  const broadcast = fixture.deps.timeline.broadcast
  fixture.deps.timeline.broadcast = (sessionId, event) => {
    calls.push('broadcast')
    broadcast(sessionId, event)
  }
  await createDeliverablesPresentation(fixture.deps).handlePresentFilesRequest({
    runtimeSessionId: 'runtime-1',
    toolCallId: 'call-1',
    files: [{ path: 'report.txt' }]
  })
  assert.deepEqual(calls, ['binding', 'inspect', 'binding', 'append', 'broadcast'])
})

test('deliverables do not inspect or commit after abort or run replacement', async () => {
  const aborted = deliverablesFixture()
  let inspected = false
  aborted.deps.files.validateLocal = () => {
    inspected = true
    return []
  }
  const controller = new AbortController()
  controller.abort(new Error('stopped'))
  await assert.rejects(
    createDeliverablesPresentation(aborted.deps).handlePresentFilesRequest(
      { runtimeSessionId: 'runtime-1', toolCallId: 'call-1', files: [] },
      { signal: controller.signal }
    ),
    /stopped/
  )
  assert.equal(inspected, false)

  const replaced = deliverablesFixture()
  replaced.deps.files.validateLocal = () => {
    replaced.setRun({ ...replaced.run })
    return [{ path: '/workspace/report.txt', displayPath: 'report.txt', bytes: 7 }]
  }
  await assert.rejects(
    createDeliverablesPresentation(replaced.deps).handlePresentFilesRequest({
      runtimeSessionId: 'runtime-1',
      toolCallId: 'call-1',
      files: []
    }),
    /binding changed during inspection/
  )
  assert.deepEqual(replaced.events, [])
})

test('deliverables enforce routed origin, call, and signal bindings', async () => {
  const fixture = deliverablesFixture()
  fixture.setRemoteOwned(true)
  const present = createDeliverablesPresentation(fixture.deps).handlePresentFilesRequest
  const request = { runtimeSessionId: 'runtime-1', toolCallId: 'call-1', files: [] }
  await assert.rejects(
    present(request, { originSessionId: 'other', toolCallId: 'call-1' }),
    /origin\/call binding differs/
  )
  await assert.rejects(
    present(request, { originSessionId: 'runtime-1', toolCallId: 'other' }),
    /origin\/call binding differs/
  )
  await assert.rejects(
    present(request, { originSessionId: 'runtime-1', toolCallId: 'call-1' }),
    /origin\/call binding differs/
  )
})

test('deliverables recheck the remote binding after the awaited inspection', async () => {
  const fixture = deliverablesFixture()
  fixture.setRemoteAnchor(true)
  fixture.setManifest({
    projectId: 'project-1',
    projectLocation: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: '/remote',
      canonicalRoot: '/canonical'
    }
  })
  fixture.setProject({
    location: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: '/remote',
      canonicalRoot: '/canonical'
    }
  })
  fixture.setRemoteValidation(async () => {
    fixture.setBinding('binding-2')
    return [{ path: 'ssh://host/report.txt', displayPath: 'report.txt', bytes: 7 }]
  })
  const present = createDeliverablesPresentation(fixture.deps).handlePresentFilesRequest
  await assert.rejects(
    present({ runtimeSessionId: 'runtime-1', toolCallId: 'call-1', files: [] }),
    /binding changed during inspection/
  )
  assert.deepEqual(fixture.events, [])
})

test('deliverables record validated files in bounded batches and project script artifacts', async () => {
  const fixture = deliverablesFixture()
  const handlers = createDeliverablesPresentation(fixture.deps)
  const files = Array.from({ length: 5 }, (_, index) => ({
    path: `/workspace/${index}.txt`,
    displayPath: `${index}.txt`,
    bytes: index
  }))
  assert.deepEqual(
    await handlers.handlePresentFilesRequest({
      runtimeSessionId: 'runtime-1',
      toolCallId: 'call-1',
      files
    }),
    { files }
  )
  handlers.presentScriptArtifacts({
    runtimeSessionId: 'runtime-1',
    toolCallId: 'call-2',
    envId: 'env-1',
    artifacts: [
      {
        path: '/workspace/chart.svg',
        relativePath: 'chart.svg',
        descriptor: { kind: 'figure', title: 'Chart' }
      }
    ]
  })
  assert.deepEqual(
    fixture.events.map((event) => (event.files as unknown[]).length),
    [4, 1, 1]
  )
  assert.deepEqual(fixture.broadcasts, fixture.events)
  assert.deepEqual((fixture.events[2].files as unknown[])[0], {
    path: '/workspace/chart.svg',
    displayPath: 'chart.svg',
    bytes: 17,
    description: 'Chart',
    artifact: { kind: 'figure', title: 'Chart', envId: 'env-1' }
  })
})

function interactionRun(): AgentInteractionPromptRun {
  return {
    phiSessionId: 'phi-1',
    runId: 'run-1',
    cwd: '/workspace',
    projectId: 'project-1',
    sessionGeneration: 3,
    cancelled: false
  }
}

function interactionFixture(): {
  deps: AgentInteractionRequestDeps
  calls: string[]
  run: AgentInteractionPromptRun
  setRun(value: AgentInteractionPromptRun | null): void
  setResponse(value: Record<string, unknown>): void
  setWindowAvailable(value: boolean): void
} {
  const run = interactionRun()
  let activeRun: AgentInteractionPromptRun | null = run
  let response: Record<string, unknown> = { answers: [] }
  let windowAvailable = true
  const calls: string[] = []
  return {
    run,
    calls,
    deps: {
      fields: { optionalStringField },
      runs: { findByRuntimeSessionId: () => activeRun },
      projects: {
        getById: () => ({ name: 'Research', location: { kind: 'local' } }),
        getByCwd: () => undefined
      },
      renderer: {
        getActiveWindow: () => (windowAvailable ? ({} as never) : null),
        canRequest: () => windowAvailable,
        waitForResponse: async (request) => {
          calls.push(`wait:${request.cwd}`)
          return response as never
        }
      },
      state: {
        createId: () => 'interaction-1',
        sessionPath: (sessionId) => `phi-session:${sessionId}`,
        markNeedsInput: () => calls.push('requested'),
        markInputCancelled: () => calls.push('cancelled'),
        markInputAnswered: () => calls.push('answered'),
        notifySessionChanged: () => calls.push('notified')
      }
    },
    setRun: (value) => {
      activeRun = value
    },
    setResponse: (value) => {
      response = value
    },
    setWindowAvailable: (value) => {
      windowAvailable = value
    }
  }
}

const validInteractionRequest = {
  runtimeSessionId: 'runtime-1',
  questions: [
    {
      header: 'Scope',
      question: 'Which scope?',
      options: [{ label: 'Project', description: 'Use this project', preview: ' /workspace ' }],
      multiSelect: true
    }
  ]
}

test('agent interaction rejects malformed questions and unavailable run bindings', async () => {
  const fixture = interactionFixture()
  const request = createAgentInteractionRequest(fixture.deps)
  await assert.rejects(request({ runtimeSessionId: 'runtime-1', questions: [] }), /Invalid/)
  fixture.setRun(null)
  await assert.rejects(request(validInteractionRequest), /No active run/)
  fixture.setRun({ ...fixture.run, cancelled: true })
  await assert.rejects(request(validInteractionRequest), /No active run/)
  fixture.setRun(fixture.run)
  await assert.rejects(
    request(validInteractionRequest, { originSessionId: 'other' }),
    /No active run/
  )
})

test('agent interaction rejects a request when no renderer window is usable', async () => {
  const fixture = interactionFixture()
  fixture.setWindowAvailable(false)
  await assert.rejects(
    createAgentInteractionRequest(fixture.deps)(validInteractionRequest),
    /没有可用窗口/
  )
  assert.deepEqual(fixture.calls, [])
})

test('agent interaction records answered and renderer-cancelled outcomes in order', async () => {
  const answered = interactionFixture()
  answered.setResponse({ answers: [{ question: 'Which scope?', answer: 'Project' }] })
  const result = await createAgentInteractionRequest(answered.deps)(validInteractionRequest)
  assert.deepEqual(result, { answers: [{ question: 'Which scope?', answer: 'Project' }] })
  assert.deepEqual(answered.calls, ['requested', 'wait:/workspace', 'answered', 'notified'])

  const cancelled = interactionFixture()
  cancelled.setResponse({ answers: [], cancelled: true })
  await createAgentInteractionRequest(cancelled.deps)(validInteractionRequest)
  assert.deepEqual(cancelled.calls, ['requested', 'wait:/workspace', 'cancelled', 'notified'])
})

test('agent interaction preserves parsed options before opening the renderer', async () => {
  const fixture = interactionFixture()
  fixture.deps.renderer.waitForResponse = async (request) => {
    assert.deepEqual(request.questions, [
      {
        header: 'Scope',
        question: 'Which scope?',
        options: [{ label: 'Project', description: 'Use this project', preview: '/workspace' }],
        multiSelect: true
      }
    ])
    return { answers: [] }
  }
  await createAgentInteractionRequest(fixture.deps)(validInteractionRequest)
})

test('agent interaction cancels every stale run condition after the renderer round-trip', async () => {
  for (const stale of ['signal', 'cancelled', 'replaced'] as const) {
    const fixture = interactionFixture()
    const controller = new AbortController()
    fixture.deps.renderer.waitForResponse = async () => {
      if (stale === 'signal') controller.abort()
      if (stale === 'cancelled') fixture.run.cancelled = true
      if (stale === 'replaced') fixture.setRun({ ...fixture.run })
      return { answers: [] }
    }
    assert.deepEqual(
      await createAgentInteractionRequest(fixture.deps)(validInteractionRequest, {
        signal: controller.signal
      }),
      { requestId: 'interaction-1', answers: [], cancelled: true }
    )
    assert.deepEqual(fixture.calls, ['requested', 'cancelled', 'notified'])
  }
})

test('agent interaction uses the remote project root in the renderer request', async () => {
  const fixture = interactionFixture()
  fixture.deps.projects.getById = () => ({
    name: 'Cluster',
    location: { kind: 'ssh', remoteRoot: '/remote/project' }
  })
  await createAgentInteractionRequest(fixture.deps)(validInteractionRequest)
  assert.deepEqual(fixture.calls, ['requested', 'wait:/remote/project', 'answered', 'notified'])
})

function planFixture(): {
  deps: PlanReviewRequestDeps<Record<string, unknown>>
  run: PlanReviewPromptRun
  calls: string[]
  events: Array<Record<string, unknown>>
  setRun(value: PlanReviewPromptRun | null): void
  setResponse(value: Record<string, unknown>): void
  setProjectLocation(kind: 'local' | 'ssh'): void
  setManifestLocation(kind: 'local' | 'ssh'): void
  setWindowAvailable(value: boolean): void
} {
  const run: PlanReviewPromptRun = {
    phiSessionId: 'phi-1',
    runId: 'run-1',
    cwd: '/workspace',
    projectId: 'project-1',
    sessionGeneration: 2,
    cancelled: false
  }
  let activeRun: PlanReviewPromptRun | null = run
  let response: Record<string, unknown> = { answers: [] }
  let projectLocation: 'local' | 'ssh' = 'local'
  let manifestLocation: 'local' | 'ssh' = 'local'
  let windowAvailable = true
  const calls: string[] = []
  const events: Array<Record<string, unknown>> = []
  return {
    run,
    calls,
    events,
    deps: {
      fields: { optionalStringField },
      runs: { findByRuntimeSessionId: () => activeRun },
      projects: { getById: () => ({ name: 'Research', location: { kind: projectLocation } }) },
      sessions: {
        findById: () => ({ projectLocation: { kind: manifestLocation } }),
        sessionPath: (sessionId) => `phi-session:${sessionId}`
      },
      renderer: {
        getActiveWindow: () => (windowAvailable ? ({} as never) : null),
        canRequest: () => windowAvailable,
        waitForResponse: async () => {
          calls.push('wait')
          return response as never
        }
      },
      timeline: {
        append: (_sessionId, event) => {
          const stored = { ...event, sequence: events.length + 1 }
          calls.push(`append:${event.type}`)
          events.push(stored)
          return stored
        },
        broadcast: (_sessionId, event) => calls.push(`broadcast:${event.type}`)
      },
      state: {
        createId: () => 'review-1',
        markNeedsInput: () => calls.push('requested'),
        markInputCancelled: () => calls.push('cancelled'),
        markInputAnswered: () => calls.push('answered'),
        notifySessionChanged: () => calls.push('notified')
      }
    },
    setRun: (value) => {
      activeRun = value
    },
    setResponse: (value) => {
      response = value
    },
    setProjectLocation: (value) => {
      projectLocation = value
    },
    setManifestLocation: (value) => {
      manifestLocation = value
    },
    setWindowAvailable: (value) => {
      windowAvailable = value
    }
  }
}

const validPlanRequest = {
  runtimeSessionId: 'runtime-1',
  title: 'Analysis plan',
  planContent: '# Plan',
  planFilePath: 'local://analysis-plan.md'
}

test('plan review rejects every malformed request before resolving a run', async () => {
  const fixture = planFixture()
  const review = createPlanReviewRequest(fixture.deps)
  const invalid = [
    {},
    { ...validPlanRequest, title: '' },
    { ...validPlanRequest, title: 'x'.repeat(121) },
    { ...validPlanRequest, planContent: ' ' },
    { ...validPlanRequest, planContent: 'x'.repeat(64 * 1024 + 1) },
    { ...validPlanRequest, planFilePath: '/tmp/plan.md' }
  ]
  for (const request of invalid)
    await assert.rejects(review(request), /Invalid plan review request/)
  assert.deepEqual(fixture.calls, [])
})

test('plan review rejects missing, cancelled, remote, and windowless conversations', async () => {
  const missing = planFixture()
  missing.setRun(null)
  await assert.rejects(createPlanReviewRequest(missing.deps)(validPlanRequest), /No active/)

  const cancelled = planFixture()
  cancelled.setRun({ ...cancelled.run, cancelled: true })
  await assert.rejects(createPlanReviewRequest(cancelled.deps)(validPlanRequest), /No active/)

  const remoteProject = planFixture()
  remoteProject.setProjectLocation('ssh')
  await assert.rejects(
    createPlanReviewRequest(remoteProject.deps)(validPlanRequest),
    /远程项目暂不支持/
  )

  const remoteManifest = planFixture()
  remoteManifest.setManifestLocation('ssh')
  await assert.rejects(
    createPlanReviewRequest(remoteManifest.deps)(validPlanRequest),
    /远程项目暂不支持/
  )

  const windowless = planFixture()
  windowless.setWindowAvailable(false)
  await assert.rejects(createPlanReviewRequest(windowless.deps)(validPlanRequest), /没有可用窗口/)
})

test('plan review records approval after the submitted event and renderer round-trip', async () => {
  const fixture = planFixture()
  fixture.setResponse({
    answers: [{ question: 'plan_review', answer: 'approve' }]
  })
  assert.deepEqual(await createPlanReviewRequest(fixture.deps)(validPlanRequest), {
    decision: 'approve'
  })
  assert.deepEqual(fixture.calls, [
    'append:plan_review_submitted',
    'broadcast:plan_review_submitted',
    'requested',
    'notified',
    'wait',
    'answered',
    'append:plan_review_decided',
    'broadcast:plan_review_decided',
    'notified'
  ])
})

test('plan review turns renderer rejection into cancellation and keeps notes only for revision', async () => {
  const cancelled = planFixture()
  cancelled.setResponse({
    answers: [{ question: 'plan_review', answer: 'approve' }],
    cancelled: true
  })
  assert.deepEqual(await createPlanReviewRequest(cancelled.deps)(validPlanRequest), {
    decision: 'cancel'
  })
  assert.equal(cancelled.events[1].note, undefined)
  assert.equal(cancelled.calls.includes('cancelled'), true)

  const unknown = planFixture()
  unknown.setResponse({ answers: [{ question: 'plan_review', answer: 'other' }] })
  assert.deepEqual(await createPlanReviewRequest(unknown.deps)(validPlanRequest), {
    decision: 'cancel'
  })

  const revised = planFixture()
  revised.setResponse({
    answers: [{ question: 'plan_review', answer: 'revise' }],
    globalNote: `  ${'n'.repeat(2100)}  `
  })
  const result = await createPlanReviewRequest(revised.deps)(validPlanRequest)
  assert.equal(result.decision, 'revise')
  assert.equal(result.note?.length, 2000)
  assert.equal(revised.events[1].note, result.note)
})

function confirmationFixture(): {
  deps: HostConfirmationDeps
  run: HostConfirmationPromptRun
  calls: string[]
  setRun(value: HostConfirmationPromptRun | null): void
  setInteractionResponse(value: unknown): void
  setApprovalDecision(value: 'approved' | 'denied' | 'cancelled'): void
  setSessionAvailable(value: boolean): void
} {
  const run: HostConfirmationPromptRun = {
    phiSessionId: 'phi-1',
    runId: 'run-1',
    cwd: '/workspace',
    projectId: 'project-1',
    sessionGeneration: 4
  }
  let activeRun: HostConfirmationPromptRun | null = run
  let interactionResponse: unknown = { answers: [{ answer: 'yes' }] }
  let approvalDecision: 'approved' | 'denied' | 'cancelled' = 'approved'
  let sessionAvailable = true
  const calls: string[] = []
  return {
    run,
    calls,
    deps: {
      interactions: {
        request: async (request) => {
          calls.push(`interaction:${request.questions[0]?.options[0]?.label}`)
          return interactionResponse
        },
        buildQuestion: () => 'Build this environment?',
        buildConfirmed: (response) => response === interactionResponse && response !== false,
        requestConfirmed: (response) => response === interactionResponse && response !== false
      },
      runs: {
        findByRuntimeSessionId: () => activeRun,
        sessionPath: (sessionId) => `phi-session:${sessionId}`
      },
      projects: {
        getById: () => ({ name: 'Research' }),
        getByCwd: () => undefined
      },
      sessions: { findById: () => (sessionAvailable ? {} : undefined) },
      approvals: {
        createId: () => 'approval-1',
        request: async () => {
          calls.push('await-approval')
          return approvalDecision
        },
        getActiveWindow: () => null,
        markNeedsApproval: () => calls.push('requested'),
        markApproved: () => calls.push('approved'),
        markDenied: () => calls.push('denied'),
        markCancelled: () => calls.push('cancelled'),
        sendCancelled: () => calls.push('cancel-event'),
        notifySessionChanged: () => calls.push('notified')
      },
      capability: { assertCurrent: () => calls.push('assert-current') }
    },
    setRun: (value) => {
      activeRun = value
    },
    setInteractionResponse: (value) => {
      interactionResponse = value
    },
    setApprovalDecision: (value) => {
      approvalDecision = value
    },
    setSessionAvailable: (value) => {
      sessionAvailable = value
    }
  }
}

test('environment build and request confirmations map answers and renderer failures to booleans', async () => {
  const fixture = confirmationFixture()
  const confirmations = createHostConfirmations(fixture.deps)
  assert.equal(
    await confirmations.confirmEnvironmentBuild({
      runtimeSessionId: 'runtime-1',
      ref: 'phi:python@1',
      skill: 'scanpy',
      estimate: { packages: 1, cachedPackages: 0 }
    }),
    true
  )
  assert.equal(
    await confirmations.confirmEnvironmentRequest({
      runtimeSessionId: 'runtime-1',
      packages: ['six'],
      reason: 'needed',
      environment: 'phi:python@1',
      question: 'Add six?'
    }),
    true
  )
  assert.deepEqual(fixture.calls, ['interaction:现在构建', 'interaction:添加'])

  fixture.setInteractionResponse(false)
  assert.equal(
    await confirmations.confirmEnvironmentBuild({
      runtimeSessionId: 'runtime-1',
      ref: 'phi:python@1',
      skill: 'scanpy',
      estimate: { packages: 1, cachedPackages: 0 }
    }),
    false
  )
  assert.equal(
    await confirmations.confirmEnvironmentRequest({
      runtimeSessionId: 'runtime-1',
      packages: ['six'],
      reason: 'needed',
      environment: 'phi:python@1',
      question: 'Add six?'
    }),
    false
  )

  fixture.deps.interactions.request = async () => {
    throw new Error('renderer unavailable')
  }
  assert.equal(
    await confirmations.confirmEnvironmentBuild({
      runtimeSessionId: 'runtime-1',
      ref: 'phi:python@1',
      skill: 'scanpy',
      estimate: { packages: 1, cachedPackages: 0 }
    }),
    false
  )
  assert.equal(
    await confirmations.confirmEnvironmentRequest({
      runtimeSessionId: 'runtime-1',
      packages: ['six'],
      reason: 'needed',
      environment: 'phi:python@1',
      question: 'Add six?'
    }),
    false
  )
})

test('host tool approval returns false without a run, signal, or tool call', async () => {
  const fixture = confirmationFixture()
  const confirm = createHostConfirmations(fixture.deps).confirmHostToolApproval
  fixture.setRun(null)
  assert.equal(await confirm('runtime-1', 'tool', 'summary', {}), false)
  fixture.setRun(fixture.run)
  assert.equal(await confirm('runtime-1', 'tool', 'summary', { toolCallId: 'call-1' }), false)
  assert.equal(
    await confirm('runtime-1', 'tool', 'summary', {
      signal: new AbortController().signal
    }),
    false
  )
  assert.deepEqual(fixture.calls, [])
})

test('host tool approval records approved, denied, and cancelled decisions in order', async () => {
  for (const decision of ['approved', 'denied', 'cancelled'] as const) {
    const fixture = confirmationFixture()
    fixture.setApprovalDecision(decision)
    const approved = await createHostConfirmations(fixture.deps).confirmHostToolApproval(
      'runtime-1',
      'tool',
      'summary',
      { toolCallId: 'call-1', signal: new AbortController().signal }
    )
    assert.equal(approved, decision === 'approved')
    assert.deepEqual(fixture.calls, [
      'requested',
      'await-approval',
      decision,
      ...(decision === 'cancelled' ? ['cancel-event'] : []),
      'notified'
    ])
  }
})

test('agent module installation asserts currency before and after its approval round-trip', async () => {
  const fixture = confirmationFixture()
  const approved = await createHostConfirmations(fixture.deps).confirmAgentModuleInstallation(
    'runtime-1',
    'Install analysis module',
    { toolCallId: 'call-1', signal: new AbortController().signal }
  )
  assert.equal(approved, true)
  assert.deepEqual(fixture.calls, [
    'assert-current',
    'requested',
    'await-approval',
    'approved',
    'notified',
    'assert-current'
  ])
})

test('remote Jupyter confirmation requires its session and rechecks cancellation after approval', async () => {
  const missing = confirmationFixture()
  missing.setSessionAvailable(false)
  await assert.rejects(
    createHostConfirmations(missing.deps).approveRemoteJupyterStart(
      { runtimeSessionId: 'runtime-1', sessionId: 'phi-1' },
      { serverLabel: 'cluster', projectName: 'Research' },
      { toolCallId: 'call-1', signal: new AbortController().signal }
    ),
    /所属会话不可用/
  )

  const cancelled = confirmationFixture()
  const controller = new AbortController()
  cancelled.deps.approvals.request = async () => {
    controller.abort(new Error('stopped'))
    return 'approved'
  }
  await assert.rejects(
    createHostConfirmations(cancelled.deps).approveRemoteJupyterStart(
      { runtimeSessionId: 'runtime-1', sessionId: 'phi-1' },
      { serverLabel: 'cluster', projectName: 'Research' },
      { toolCallId: 'call-1', signal: controller.signal }
    ),
    /stopped/
  )

  const denied = confirmationFixture()
  denied.deps.approvals.request = async (request) => {
    assert.equal(request.toolName, 'remote_jupyter_start')
    assert.equal(
      request.summary,
      '启动远程 Jupyter（会占用服务器资源）\n服务器：cluster\n项目：Research'
    )
    return 'denied'
  }
  assert.equal(
    await createHostConfirmations(denied.deps).approveRemoteJupyterStart(
      { runtimeSessionId: 'runtime-1', sessionId: 'phi-1' },
      { serverLabel: 'cluster', projectName: 'Research' },
      { toolCallId: 'call-1', signal: new AbortController().signal }
    ),
    false
  )
})
