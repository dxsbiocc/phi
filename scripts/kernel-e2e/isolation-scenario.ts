import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { JsonValue } from '../../src/shared/kernel-protocol'
import { type ModelReply, type ModelRequest, type ScenarioClient } from './harness'

type Step = <T>(name: string, action: () => Promise<T>) => Promise<T>

interface IsolationProvider {
  readonly requests: ModelRequest[]
  enqueue(...replies: ModelReply[]): void
  waitForGate(name: string): Promise<void>
  releaseGate(name: string): void
}

interface CapturedTool {
  id: string
  name: string
  args?: unknown
  result?: string
  isError?: boolean
}

export interface IsolationScenarioEvidence {
  sessionIds: { a: string; b: string; c: string }
  agentIds: { aMain: string; aChild: string; bChild: string }
  markers: { a: string; b: string; c: string; aBroadcast: string }
  toolResultCount: number
  modelRequestCount: number
  assertions: {
    foreignReadsBlocked: true
    broadcastsContained: true
    childIdsDistinct: true
    resultsParentScoped: true
    scriptedStepsComplete: true
    positiveControl: true
  }
  evidenceFiles: { tools: string; modelRequests: string }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).join('')
  if (!value || typeof value !== 'object') return ''
  const item = value as Record<string, unknown>
  if (typeof item.text === 'string') return item.text
  return contentText(item.content)
}

function messagesOf(value: {
  messages?: Array<Record<string, unknown>>
  context?: { messages?: Array<Record<string, unknown>> }
}): Array<Record<string, unknown>> {
  return value.messages ?? value.context?.messages ?? []
}

function requestUserText(request: ModelRequest): string {
  return messagesOf(request)
    .filter((message) => message.role === 'user')
    .map((message) => contentText(message.content))
    .join('\n')
}

function toolCalls(snapshot: Record<string, unknown>): CapturedTool[] {
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : []
  const calls = new Map<string, CapturedTool>()
  for (const candidate of messages) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const message = candidate as Record<string, unknown>
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== 'object' || Array.isArray(part)) continue
        const call = part as Record<string, unknown>
        if (
          call.type !== 'toolCall' ||
          typeof call.id !== 'string' ||
          typeof call.name !== 'string'
        )
          continue
        calls.set(call.id, { id: call.id, name: call.name, args: call.arguments })
      }
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const candidateCall of message.tool_calls) {
        if (!candidateCall || typeof candidateCall !== 'object' || Array.isArray(candidateCall))
          continue
        const call = candidateCall as Record<string, unknown>
        const fn = call.function
        if (
          typeof call.id !== 'string' ||
          !fn ||
          typeof fn !== 'object' ||
          Array.isArray(fn) ||
          typeof (fn as Record<string, unknown>).name !== 'string'
        )
          continue
        const rawArgs = (fn as Record<string, unknown>).arguments
        let args: unknown = rawArgs
        if (typeof rawArgs === 'string') {
          try {
            args = JSON.parse(rawArgs)
          } catch {
            args = rawArgs
          }
        }
        calls.set(call.id, {
          id: call.id,
          name: (fn as Record<string, unknown>).name as string,
          args
        })
      }
    }
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      const existing = calls.get(message.tool_call_id) ?? {
        id: message.tool_call_id,
        name: 'unknown'
      }
      existing.result = contentText(message.content)
      existing.isError = false
      calls.set(existing.id, existing)
    }
    if (message.role !== 'toolResult' || typeof message.toolCallId !== 'string') continue
    const existing = calls.get(message.toolCallId) ?? {
      id: message.toolCallId,
      name: typeof message.toolName === 'string' ? message.toolName : 'unknown'
    }
    existing.result = contentText(message.content)
    existing.isError = message.isError === true
    calls.set(existing.id, existing)
  }
  return [...calls.values()]
}

function toolCallsFromRequests(requests: ModelRequest[]): CapturedTool[] {
  const merged = new Map<string, CapturedTool>()
  for (const request of requests) {
    for (const current of toolCalls({ messages: messagesOf(request) })) {
      const existing = merged.get(current.id)
      merged.set(current.id, { ...existing, ...current })
    }
  }
  return [...merged.values()]
}

function byId(tools: CapturedTool[], id: string): CapturedTool {
  const found = tools.find((tool) => tool.id === id)
  assert.ok(found, `Missing scripted tool result ${id}`)
  assert.equal(typeof found.result, 'string', `Scripted tool ${id} did not finish`)
  return found
}

function spawnedAgent(result: string | undefined): string {
  const id = /Spawned agent `([^`]+)`/.exec(result ?? '')?.[1]
  assert.ok(id, `Task result omitted spawned agent id: ${result ?? '<missing>'}`)
  return id
}

function mainAgent(historyIndex: string | undefined): string {
  const id = /^(?:\d+:)?\|\s*([^|]+?)\s*\|\s*[^|]+\|\s*main\s*\|/m.exec(historyIndex ?? '')?.[1]
  assert.ok(id, `history:// index omitted the caller main agent: ${historyIndex ?? '<missing>'}`)
  return id.trim()
}

function mentionsAgentId(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_.-])`).test(text)
}

async function eventually(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function tool(name: string, id: string, args: Record<string, unknown>, match: string): ModelReply {
  return { match, tool: { name, id, args } }
}

async function runSequence(options: {
  provider: IsolationProvider
  client: ScenarioClient
  sessionId: string
  tag: string
  calls: Array<{ name: string; id: string; args: Record<string, unknown> }>
}): Promise<Record<string, unknown>> {
  options.provider.enqueue(
    ...options.calls.map((call) => tool(call.name, call.id, call.args, options.tag)),
    { match: options.tag, text: `${options.tag}-DONE` }
  )
  const deadline = Date.now() + 10_000
  for (;;) {
    const completion = await options.client.prompt(options.sessionId, options.tag)
    if (completion.status === 'completed') break
    if (
      completion.status !== 'failed' ||
      !completion.detail?.includes('Agent is already processing') ||
      Date.now() >= deadline
    ) {
      assert.equal(completion.status, 'completed', completion.detail)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return options.client.snapshot(options.sessionId)
}

function requestLane(request: ModelRequest, tags: Record<string, string>): string {
  const users = requestUserText(request)
  if (users.includes(tags.aChild)) return 'a-child'
  if (users.includes(tags.bChild)) return 'b-child'
  if (users.includes(tags.aRoot)) return 'a'
  if (users.includes(tags.bRoot)) return 'b'
  if (users.includes(tags.cRoot)) return 'c'
  return 'other'
}

function assistantModelErrors(snapshot: Record<string, unknown>): string[] {
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : []
  return messages
    .filter((message): message is Record<string, unknown> =>
      Boolean(message && typeof message === 'object' && !Array.isArray(message))
    )
    .filter((message) => message.role === 'assistant' && message.stopReason === 'error')
    .map((message) => String(message.errorMessage ?? 'model stopReason=error'))
}

export async function runIsolationScenario(options: {
  provider: IsolationProvider
  client: ScenarioClient
  projectA: string
  projectB: string
  evidenceDirectory: string
  step: Step
}): Promise<IsolationScenarioEvidence> {
  const markerA = `MA-${randomUUID()}`
  const markerB = `MB-${randomUUID()}`
  const markerC = `MC-${randomUUID()}`
  const markerABroadcast = `MA-BROADCAST-${randomUUID()}`
  const aChildGate = `isolation-a-child-${randomUUID()}`
  const tags = {
    aRoot: `ISO-A-ROOT-${randomUUID()}`,
    aChild: `ISO-A-CHILD-${randomUUID()}`,
    bRoot: `ISO-B-ROOT-${randomUUID()}`,
    bChild: `ISO-B-CHILD-${randomUUID()}`,
    cRoot: `ISO-C-ROOT-${randomUUID()}`
  }

  const createPersistent = (cwd: string): Promise<string> =>
    options.client.create(cwd, false, { sessionManager: { kind: 'persistent' } as JsonValue })
  const [sessionA, sessionB, sessionC] = await options.step(
    'isolation sessions A, B, and C created in one kernel',
    () =>
      Promise.all([
        createPersistent(options.projectA),
        createPersistent(options.projectB),
        createPersistent(options.projectA)
      ])
  )

  options.provider.enqueue(
    tool(
      'task',
      'iso-a-spawn',
      {
        i: 'Start the isolation probe',
        name: 'probe',
        task: `${tags.aChild} keep this child alive and finish with ${markerA}`,
        solutionSpace: 'Remain on the current model turn until the parent broadcast, then finish.'
      },
      tags.aRoot
    ),
    { match: tags.aRoot, text: `${tags.aRoot}-SPAWNED` },
    { match: tags.aChild, gate: aChildGate, text: `${tags.aChild}-GATE-RELEASED` }
  )
  await options.step('session A spawned a live task child', async () => {
    const completion = await options.client.prompt(sessionA, tags.aRoot)
    assert.equal(completion.status, 'completed', completion.detail)
    await options.provider.waitForGate(aChildGate)
  })
  let snapshotA = await options.client.snapshot(sessionA)
  let toolsA = toolCalls(snapshotA)
  const aChild = spawnedAgent(byId(toolsA, 'iso-a-spawn').result)

  snapshotA = await options.step(
    'session A positive reads succeeded while its child was live',
    () =>
      runSequence({
        provider: options.provider,
        client: options.client,
        sessionId: sessionA,
        tag: `${tags.aRoot}-SELF-LIVE`,
        calls: [
          { name: 'read', id: 'iso-a-history-list-live', args: { path: 'history://' } },
          { name: 'read', id: 'iso-a-agent-live', args: { path: `agent://${aChild}` } },
          { name: 'read', id: 'iso-a-history-live', args: { path: `history://${aChild}` } },
          { name: 'read', id: 'iso-a-proc-live', args: { path: 'proc://' } }
        ]
      })
  )
  toolsA = toolCalls(snapshotA)
  for (const id of [
    'iso-a-history-list-live',
    'iso-a-agent-live',
    'iso-a-history-live',
    'iso-a-proc-live'
  ])
    assert.equal(byId(toolsA, id).isError, false, `${id} must be a positive control`)
  const aMain = mainAgent(byId(toolsA, 'iso-a-history-list-live').result)
  assert.match(
    byId(toolsA, 'iso-a-proc-live').result ?? '',
    new RegExp(aChild.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  )

  options.provider.enqueue(
    tool(
      'task',
      'iso-b-spawn',
      {
        i: 'Start the second isolation probe',
        name: 'probe',
        task: `${tags.bChild} return only ${markerB}-CHILD-RESULT`,
        solutionSpace: 'Finish immediately with the requested marker.'
      },
      tags.bRoot
    ),
    tool('yield', 'iso-b-child-yield', { data: `${markerB}-CHILD-RESULT` }, tags.bChild),
    { match: tags.bRoot, text: `${tags.bRoot}-SPAWNED` },
    { match: `${markerB}-CHILD-RESULT`, text: `${tags.bRoot}-CHILD-RECEIVED` }
  )
  await options.step('session B spawned its own same-name child', async () => {
    const completion = await options.client.prompt(sessionB, tags.bRoot)
    assert.equal(completion.status, 'completed', completion.detail)
    await eventually(
      () => options.provider.requests.some((request) => requestLane(request, tags) === 'b-child'),
      'B child model turn'
    )
  })
  let snapshotB = await options.step('session B wait received only its own child result', () =>
    runSequence({
      provider: options.provider,
      client: options.client,
      sessionId: sessionB,
      tag: `${tags.bRoot}-COLLECT-CHILD`,
      calls: [{ name: 'wait', id: 'iso-b-own-result', args: {} }]
    })
  )
  const toolsB = toolCalls(snapshotB)
  const bChild = spawnedAgent(byId(toolsB, 'iso-b-spawn').result)
  assert.notEqual(bChild, aChild)
  const bOwnResult = byId(toolsB, 'iso-b-own-result').result ?? ''
  const bDeliveryRequests = options.provider.requests.filter(
    (request) =>
      requestLane(request, tags) === 'b' &&
      requestUserText(request).includes(`${markerB}-CHILD-RESULT`)
  )
  assert.ok(bOwnResult.includes(markerB) || bDeliveryRequests.length > 0)
  assert.doesNotMatch(bOwnResult, new RegExp(markerA))

  const probeCalls = (
    prefix: 'b' | 'c',
    phase: 'live' | 'finished',
    broadcast: string
  ): Array<{ name: string; id: string; args: Record<string, unknown> }> => [
    { name: 'read', id: `iso-${prefix}-agent-child-${phase}`, args: { path: `agent://${aChild}` } },
    { name: 'read', id: `iso-${prefix}-agent-main-${phase}`, args: { path: `agent://${aMain}` } },
    { name: 'read', id: `iso-${prefix}-history-list-${phase}`, args: { path: 'history://' } },
    {
      name: 'read',
      id: `iso-${prefix}-history-child-${phase}`,
      args: { path: `history://${aChild}` }
    },
    { name: 'read', id: `iso-${prefix}-proc-${phase}`, args: { path: 'proc://' } },
    { name: 'wait', id: `iso-${prefix}-wait-${phase}`, args: {} },
    {
      name: 'write',
      id: `iso-${prefix}-broadcast-${phase}`,
      args: { path: 'agent://all', content: broadcast }
    },
    {
      name: 'write',
      id: `iso-${prefix}-direct-${phase}`,
      args: { path: `agent://${aChild}`, content: `${broadcast}-DIRECT` }
    },
    { name: 'read', id: `iso-${prefix}-memory-${phase}`, args: { path: 'memory://root/' } },
    { name: 'read', id: `iso-${prefix}-local-${phase}`, args: { path: 'local://' } }
  ]

  options.provider.enqueue({ match: markerB, text: `${markerB}-OWN-BROADCAST-RECEIVED` })
  snapshotB = await options.step(
    'session B probed every reachable channel while A child was live',
    () =>
      runSequence({
        provider: options.provider,
        client: options.client,
        sessionId: sessionB,
        tag: `${tags.bRoot}-PROBE-LIVE`,
        calls: probeCalls('b', 'live', markerB)
      })
  )
  await options.step('same-project session C probed while A child was live', () =>
    runSequence({
      provider: options.provider,
      client: options.client,
      sessionId: sessionC,
      tag: `${tags.cRoot}-PROBE-LIVE`,
      calls: probeCalls('c', 'live', markerC)
    })
  )

  options.provider.enqueue(
    tool('yield', 'iso-a-child-yield', { data: `${markerA}-CHILD-RESULT` }, markerABroadcast),
    { match: `${markerA}-CHILD-RESULT`, text: `${tags.aRoot}-CHILD-RECEIVED` }
  )
  snapshotA = await options.step(
    'A broadcast reached its running child and released it',
    async () => {
      const tag = `${tags.aRoot}-BROADCAST`
      options.provider.enqueue(
        tool('write', 'iso-a-broadcast', { path: 'agent://all', content: markerABroadcast }, tag),
        { match: tag, text: `${tag}-DONE` }
      )
      const runId = await options.client.startPrompt(sessionA, tag)
      await eventually(
        async () =>
          toolCalls(await options.client.snapshot(sessionA)).some(
            (entry) => entry.id === 'iso-a-broadcast' && entry.result !== undefined
          ),
        'A broadcast tool result'
      )
      options.provider.releaseGate(aChildGate)
      const completion = await options.client.waitForRun(runId)
      assert.equal(completion.status, 'completed', completion.detail)
      await eventually(
        () =>
          options.provider.requests.some(
            (request) =>
              requestLane(request, tags) === 'a-child' &&
              requestUserText(request).includes(markerABroadcast)
          ),
        'A child broadcast model request'
      )
      return options.client.snapshot(sessionA)
    }
  )
  assert.ok(
    options.provider.requests.some(
      (request) =>
        requestUserText(request).includes(tags.aChild) &&
        JSON.stringify(request).includes(markerABroadcast)
    ),
    'A child model request did not receive A broadcast'
  )
  await eventually(
    () =>
      options.provider.requests.some(
        (request) =>
          requestLane(request, tags) === 'a' &&
          requestUserText(request).includes(`${markerA}-CHILD-RESULT`)
      ),
    'A parent child-result model request'
  )
  const aDeliveryRequests = options.provider.requests.filter(
    (request) =>
      requestLane(request, tags) === 'a' &&
      requestUserText(request).includes(`${markerA}-CHILD-RESULT`)
  )

  snapshotA = await options.step(
    'session A positive reads succeeded after its child finished',
    () =>
      runSequence({
        provider: options.provider,
        client: options.client,
        sessionId: sessionA,
        tag: `${tags.aRoot}-SELF-FINISHED`,
        calls: [
          { name: 'read', id: 'iso-a-agent-finished', args: { path: `agent://${aChild}` } },
          { name: 'read', id: 'iso-a-history-finished', args: { path: `history://${aChild}` } }
        ]
      })
  )
  snapshotB = await options.step('session B repeated foreign probes after A child finished', () => {
    options.provider.enqueue({
      match: `${markerB}-AFTER`,
      text: `${markerB}-OWN-AFTER-BROADCAST-RECEIVED`
    })
    return runSequence({
      provider: options.provider,
      client: options.client,
      sessionId: sessionB,
      tag: `${tags.bRoot}-PROBE-FINISHED`,
      calls: probeCalls('b', 'finished', `${markerB}-AFTER`)
    })
  })
  const snapshotCAfter = await options.step(
    'same-project session C repeated probes after A child finished',
    () =>
      runSequence({
        provider: options.provider,
        client: options.client,
        sessionId: sessionC,
        tag: `${tags.cRoot}-PROBE-FINISHED`,
        calls: probeCalls('c', 'finished', `${markerC}-AFTER`)
      })
  )

  const snapshots = { a: snapshotA, b: snapshotB, c: snapshotCAfter }
  const captured = {
    a: toolCalls(snapshotA),
    aChild: toolCallsFromRequests(
      options.provider.requests.filter((request) => requestLane(request, tags) === 'a-child')
    ),
    b: toolCalls(snapshotB),
    bChild: toolCallsFromRequests(
      options.provider.requests.filter((request) => requestLane(request, tags) === 'b-child')
    ),
    c: toolCalls(snapshotCAfter)
  }
  const foreign = [...captured.b, ...captured.c]
  assert.doesNotMatch(JSON.stringify(foreign), new RegExp(markerA))
  assert.doesNotMatch(JSON.stringify(foreign), /ISO-A-CHILD-/)
  for (const prefix of ['b', 'c'] as const) {
    for (const phase of ['live', 'finished'] as const) {
      const tools = captured[prefix]
      for (const kind of ['agent-child', 'agent-main', 'history-child', 'direct'] as const)
        assert.equal(byId(tools, `iso-${prefix}-${kind}-${phase}`).isError, true)
      for (const kind of [
        'history-list',
        'proc',
        'broadcast',
        'wait',
        'memory',
        'local'
      ] as const) {
        const result = byId(tools, `iso-${prefix}-${kind}-${phase}`).result ?? ''
        assert.equal(mentionsAgentId(result, aMain), false)
        assert.equal(mentionsAgentId(result, aChild), false)
      }
    }
  }

  const aRequests = options.provider.requests.filter((request) => {
    const lane = requestLane(request, tags)
    return lane === 'a' || lane === 'a-child'
  })
  for (const request of aRequests) {
    const raw = JSON.stringify(request)
    assert.doesNotMatch(raw, new RegExp(markerB))
    assert.doesNotMatch(raw, new RegExp(markerC))
  }
  const aParentResult = aDeliveryRequests.map(requestUserText).join('\n')
  const bWaitResult = byId(captured.b, 'iso-b-own-result').result ?? ''
  const bParentResult = bWaitResult.includes(markerB)
    ? bWaitResult
    : bDeliveryRequests.map(requestUserText).join('\n')
  assert.match(aParentResult, new RegExp(`${markerA}-CHILD-RESULT`))
  assert.doesNotMatch(aParentResult, new RegExp(`${markerB}-CHILD-RESULT`))
  assert.match(bParentResult, new RegExp(`${markerB}-CHILD-RESULT`))
  assert.doesNotMatch(bParentResult, new RegExp(`${markerA}-CHILD-RESULT`))
  assert.equal(byId(captured.a, 'iso-a-agent-finished').isError, false)
  assert.equal(byId(captured.a, 'iso-a-history-finished').isError, false)

  const allExpected = [
    'iso-a-spawn',
    'iso-b-spawn',
    'iso-b-child-yield',
    'iso-b-own-result',
    'iso-a-history-list-live',
    'iso-a-agent-live',
    'iso-a-history-live',
    'iso-a-proc-live',
    'iso-a-broadcast',
    'iso-a-agent-finished',
    'iso-a-history-finished',
    ...(['b', 'c'] as const).flatMap((prefix) =>
      (['live', 'finished'] as const).flatMap((phase) =>
        probeCalls(prefix, phase, 'unused').map((call) => call.id)
      )
    )
  ]
  const allTools = [
    ...captured.a,
    ...captured.aChild,
    ...captured.b,
    ...captured.bChild,
    ...captured.c
  ]
  for (const id of allExpected) byId(allTools, id)
  const modelErrors = [
    ...Object.values(snapshots).flatMap(assistantModelErrors),
    ...options.provider.requests.flatMap((request) =>
      assistantModelErrors({ messages: messagesOf(request) })
    )
  ]
  assert.deepEqual(modelErrors, [])

  await mkdir(options.evidenceDirectory, { recursive: true })
  const toolsPath = join(options.evidenceDirectory, 'tool-calls.json')
  const requestsPath = join(options.evidenceDirectory, 'model-requests.json')
  await writeFile(
    toolsPath,
    `${JSON.stringify(
      {
        sessions: { a: sessionA, b: sessionB, c: sessionC },
        agents: { aMain, aChild, bChild },
        markers: { a: markerA, b: markerB, c: markerC, aBroadcast: markerABroadcast },
        tools: captured
      },
      null,
      2
    )}\n`
  )
  await writeFile(
    requestsPath,
    `${JSON.stringify(
      options.provider.requests.map((request, index) => {
        const raw = JSON.stringify(request)
        return {
          index,
          lane: requestLane(request, tags),
          hasMarkerA: raw.includes(markerA),
          hasMarkerB: raw.includes(markerB),
          hasMarkerC: raw.includes(markerC),
          stopReasonErrors: messagesOf(request).filter(
            (message) => message.role === 'assistant' && message.stopReason === 'error'
          ).length
        }
      }),
      null,
      2
    )}\n`
  )

  return {
    sessionIds: { a: sessionA, b: sessionB, c: sessionC },
    agentIds: { aMain, aChild, bChild },
    markers: { a: markerA, b: markerB, c: markerC, aBroadcast: markerABroadcast },
    toolResultCount: allTools.filter((entry) => entry.result !== undefined).length,
    modelRequestCount: options.provider.requests.length,
    assertions: {
      foreignReadsBlocked: true,
      broadcastsContained: true,
      childIdsDistinct: true,
      resultsParentScoped: true,
      scriptedStepsComplete: true,
      positiveControl: true
    },
    evidenceFiles: { tools: toolsPath, modelRequests: requestsPath }
  }
}
