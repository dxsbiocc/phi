import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { facadeMetadataFixture } from './facadeMetadataFixture'
import { startHostResultModel, type ModelRequest, type ModelReply } from './rpcHostResultModel'
import type { PhiAgentDefinition } from '../../src/main/agent/agents/definition'
import { agentRunHostHandlers } from '../../src/main/agent/agents/run-host'
import { shouldContinueAfterAgentRun } from '../../src/main/agent/agents/run-continue'
import {
  appendSessionEvent,
  createPhiSession,
  createRunId,
  findPhiSessionById,
  readSessionEvents
} from '../../src/main/agent/session/session-store'
import type { RpcChildRunSnapshot } from '../../src/main/agent/engine/rpc/subagents/types'
import type { RpcChildRuntimeConfig } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'
import type { ToolApprovalRequest } from '../../src/main/agent/tool-approval'
import type { RpcApprovalEvent } from '../../src/main/agent/engine/rpc/approval-bridge'

const STEER = 'PRODUCTION_CHILD_A_STEER_ONLY'
const PEER = 'PRODUCTION_PEER_STREAM_ONLY'
const LATER_MAIN = 'PRODUCTION_LATER_MAIN_DENIED'
const mode = process.env.PHI_T14_CONTROL_MODE ?? 'default'
assert.ok(mode === 'default' || mode === 'later-main-denied')
const laterMainDenied = mode === 'later-main-denied'
const primary = 'production-control-parent'
const peerRuntime = 'production-control-peer'
const snapshots = new Map<string, Readonly<RpcChildRunSnapshot>>()
const wakeups: string[] = []
const mainApprovalEvents: RpcApprovalEvent[] = []
const decisions: Array<{
  request: Readonly<ToolApprovalRequest>
  signal: AbortSignal
  decide(value: 'approved' | 'denied'): void
}> = []
const definitions: PhiAgentDefinition[] = ['A', 'B'].map((suffix) => ({
  name: `Control${suffix}`,
  description: `Run independent production child ${suffix}`,
  tools: ['write'],
  skills: [],
  visibility: 'entry',
  warnings: [],
  source: 'phi',
  filePath: `/trusted-fixture/Control${suffix}.md`,
  systemPrompt: `PRIVATE_PRODUCTION_CONTROL_${suffix}_ROLE. Complete the requested bounded check.`
}))
let config: RpcChildRuntimeConfig | undefined
let projectRoot = ''
let bundleHash = ''
const hits = { root: 0, a: 0, b: 0, peer: 0 }
let phase = 'fixture'
const failureState = (error: unknown): string =>
  JSON.stringify({
    phase,
    bundleHash,
    error: error instanceof Error ? error.message : String(error),
    hits,
    snapshots: [...snapshots.values()].map(({ agent, status, verified }) => ({
      agent,
      status,
      verified
    })),
    providerRequests: phase === 'fixture' ? 0 : f.provider.requests.length
  })
const actor = (request: ModelRequest): keyof typeof hits => {
  const tools = request.tools as Array<{ function?: { name?: string } }> | undefined
  const text = JSON.stringify(request.messages)
  if (tools?.some((tool) => tool.function?.name === 'task'))
    return text.includes(PEER) ? 'peer' : 'root'
  if (text.includes('PRIVATE_PRODUCTION_CONTROL_A_ROLE')) return 'a'
  if (text.includes('PRIVATE_PRODUCTION_CONTROL_B_ROLE')) return 'b'
  throw new Error('Production child fixture encountered an unexpected model actor')
}
const replyFor = (request: ModelRequest): ModelReply => {
  const who = actor(request)
  hits[who]++
  assert.ok(
    Object.values(hits).reduce((sum, count) => sum + count, 0) <= 10,
    'Unexpected production continuation'
  )
  if (who === 'peer') return { text: 'Independent peer remains active', hold: true }
  if (who === 'root') {
    if (laterMainDenied && JSON.stringify(request.messages).includes(LATER_MAIN)) {
      assert.equal(hits.root, 3, 'The denied Main turn must not make a later provider request')
      return {
        tool: {
          name: 'write',
          id: 'later-main-write',
          args: {
            path: join(projectRoot, 'later-main-must-not-write.txt'),
            content: 'The denied later Main turn must never execute'
          }
        }
      }
    }
    if (hits.root > 1) return { text: 'Parent finished while owned background children continue' }
    assert.ok(config)
    const tasks = ['A', 'B'].map((suffix) => {
      const profile = config!.profiles.find(
        (item) => item.definition.phiName === `Control${suffix}` && !item.definition.blocking
      )
      assert.ok(profile)
      return {
        agent: profile.definition.nativeName,
        name: `production-control-${suffix.toLowerCase()}`,
        task: `INITIAL_PRODUCTION_CHILD_${suffix}`,
        solutionSpace: 'Use only the specifically requested private file.'
      }
    })
    return {
      tool: {
        name: 'task',
        id: 'production-parallel-task',
        args: {
          i: 'Run two owned background children',
          context: 'Private production control acceptance.',
          tasks
        }
      }
    }
  }
  if (hits[who] === 1)
    return {
      tool: {
        name: 'write',
        id: `production-${who}-write`,
        args: {
          path: join(projectRoot, `${who}-effect.txt`),
          content: `${who} executed only after its own approval`
        }
      }
    }
  return { text: `${who.toUpperCase()}_PRODUCTION_CHILD_FINISHED` }
}

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15000
  while (!(await check())) {
    assert.ok(
      Date.now() < deadline,
      `${label}: ${JSON.stringify({ hits, snapshots: [...snapshots.values()].map(({ agent, status, verified }) => ({ agent, status, verified })) })}`
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const f = await facadeMetadataFixture({
  isolatedProject: true,
  providerFactory: () => startHostResultModel({ replyFor }),
  select: (selected) => {
    bundleHash = selected.bundle.contentHash
    return {
      ...selected,
      foregroundChildren: {
        definitions,
        allowParallel: true,
        allowBackground: true,
        onChildChange: (snapshot) => {
          snapshots.set(snapshot.id, snapshot)
        }
      }
    }
  }
})
const cleanup: Array<() => void> = []
let peerRun: ReturnType<typeof f.runners.startRun> | undefined
try {
  projectRoot = f.f.scope.projectRoot
  f.configureApproval({
    shouldGate: () => true,
    requestToolApproval: (request, signal) =>
      new Promise((resolve) => {
        decisions.push({ request, signal, decide: resolve })
      }),
    onEvent: (event) => {
      mainApprovalEvents.push(event)
    }
  })
  const handlers = agentRunHostHandlers({
    resolveSession: (id) =>
      id === primary ? { phiSessionId: f.phi.sessionId, cwd: f.phi.manifest.cwd } : undefined,
    appendToSession: (id, event) => appendSessionEvent(id, event),
    sendToWindow: () => {},
    isAppFocused: () => true,
    showOsNotification: () => assert.fail('This focused private fixture must not notify the OS'),
    continueConversation: (id, event) => {
      if (
        shouldContinueAfterAgentRun({ state: event.state, automaticCount: wakeups.length }).continue
      )
        wakeups.push(id)
    },
    redact: (value) => value,
    redactValue: (value) => value,
    persistStepOutput: () => null,
    markReported: () => {},
    clearReported: () => {},
    deliverHostRun: () => false
  })
  for (const [method, handler] of Object.entries(handlers))
    cleanup.push(f.bridge.hostServices.register(method, handler))
  phase = 'create-parent'
  await f.engine.sessions.create(f.params(primary))
  const directory = (await f.privateDirectories())[0]
  config = JSON.parse(await readFile(join(directory, 'child-runtime.json'), 'utf8'))
  assert.equal(config!.policy.allowParallel, true)
  assert.equal(config!.policy.allowBackground, true)
  phase = 'run-parent'
  const run = f.runners.startRun({
    sessionId: f.phi.sessionId,
    runId: createRunId(),
    execute: async () => {
      await f.engine.sessions.prompt({
        sessionId: primary,
        text: 'Run the two approved background controls'
      })
    }
  })
  await run.done
  assert.equal(
    run.outcome,
    'completed',
    JSON.stringify({
      hits,
      events: readSessionEvents(f.phi.sessionId),
      snapshots: [...snapshots.values()],
      tail: f.provider.requests.map((request) => request.messages.slice(-2))
    })
  )
  await until(
    () => decisions.length === 2,
    'Both production children hold their own native write approval'
  )
  const live = [...snapshots.values()]
  assert.equal(live.length, 2)
  assert.ok(live.every((child) => child.background && child.status === 'running' && child.verified))
  assert.equal(hits.root, 2)
  const a = live.find((child) => child.agent === 'ControlA')!
  const b = live.find((child) => child.agent === 'ControlB')!
  assert.ok(a && b && a.id !== b.id && a.parentRunId === run.runId && b.parentRunId === run.runId)
  await assert.rejects(
    f.engine.sessions.setModel({
      sessionId: primary,
      agentDir: process.env.PI_CODING_AGENT_DIR!,
      model: f.model('model-b')
    })
  )
  assert.equal(hits.root, 2)

  phase = 'create-peer'
  const peer = createPhiSession({
    kind: 'project',
    projectId: f.phi.manifest.projectId,
    projectLocation: f.phi.manifest.projectLocation,
    cwd: f.phi.manifest.cwd,
    cwdRealPath: f.phi.manifest.cwdRealPath,
    permissionMode: 'ask',
    model: f.phi.manifest.model,
    thinkingLevel: 'high'
  })
  const peerParams = f.params(peerRuntime)
  peerParams.remoteProject = { ...peerParams.remoteProject!, phiSessionId: peer.sessionId }
  await f.engine.sessions.create(peerParams)
  phase = 'run-peer'
  peerRun = f.runners.startRun({
    sessionId: peer.sessionId,
    runId: createRunId(),
    execute: async () => {
      await f.engine.sessions.prompt({ sessionId: peerRuntime, text: PEER })
    }
  })
  await until(() => hits.peer === 1, 'Independent peer is really streaming')
  if (laterMainDenied) {
    phase = 'later-main-approval'
    const laterRun = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: async () => {
        await f.engine.sessions.prompt({ sessionId: primary, text: LATER_MAIN })
      }
    })
    await until(
      () => decisions.some((item) => item.request.toolCallId === 'later-main-write'),
      'The later Main turn reaches its own native write approval'
    )
    const laterDialog = decisions.find((item) => item.request.toolCallId === 'later-main-write')!
    assert.equal(laterDialog.request.agentRunId, undefined)
    assert.equal(laterDialog.request.runId, laterRun.runId)
    assert.equal(laterDialog.request.sessionId, f.phi.sessionId)
    assert.notEqual(laterRun.runId, a.parentRunId)
    laterDialog.decide('denied')
    await laterRun.done
    assert.equal(laterRun.outcome, 'failed')
    assert.deepEqual(
      mainApprovalEvents
        .filter((event) => event.runId === laterRun.runId)
        .map((event) => event.type),
      ['approval_requested', 'approval_denied']
    )
    assert.equal(await f.exists(join(projectRoot, 'later-main-must-not-write.txt')), false)
    assert.equal(hits.root, 3)
    for (const child of [a, b]) {
      assert.equal(snapshots.get(child.id)?.status, 'running')
      assert.equal(snapshots.get(child.id)?.parentRunId, run.runId)
      assert.equal(
        decisions.find((item) => item.request.agentRunId === child.id)?.signal.aborted,
        false
      )
    }
    assert.equal(peerRun.signal.aborted, false)
  }
  await assert.rejects(
    f.engine.agentRuns.steer({
      sessionId: peerRuntime,
      runId: a.id,
      message: 'Cross-peer request must fail'
    })
  )
  phase = 'steer-a'
  await f.engine.agentRuns.steer({ sessionId: primary, runId: a.id, message: STEER })
  phase = 'stop-b'
  await f.engine.agentRuns.stop({ sessionId: primary, runId: b.id })
  assert.equal(snapshots.get(b.id)?.status, 'aborted')
  assert.equal(peerRun.signal.aborted, false)
  assert.equal(hits.peer, 1)
  const bDialog = decisions.find((item) => item.request.agentRunId === b.id)!
  assert.equal(bDialog.signal.aborted, true)
  bDialog.decide('approved')
  assert.equal(await f.exists(join(projectRoot, 'b-effect.txt')), false)
  const aDialog = decisions.find((item) => item.request.agentRunId === a.id)!
  assert.equal(aDialog.signal.aborted, false)
  phase = 'approve-a'
  aDialog.decide('approved')
  assert.ok(f.engine.agentRuns.wait)
  phase = 'wait-a'
  await f.engine.agentRuns.wait({ sessionId: primary, ids: [a.id], timeoutMs: 15000 })
  phase = 'completion-delivery'
  await until(
    () =>
      readSessionEvents(f.phi.sessionId).filter((event) => event.type === 'agent_run_finished')
        .length === 2,
    'One durable completion per production child'
  )
  phase = 'result-proof'
  assert.equal(snapshots.get(a.id)?.status, 'completed')
  assert.equal(snapshots.get(b.id)?.status, 'aborted')
  assert.ok(
    readSessionEvents(f.phi.sessionId).some(
      (event) =>
        event.type === 'agent_run_finished' &&
        event.agentRunId === a.id &&
        typeof event.report === 'string' &&
        event.report.includes('A_PRODUCTION_CHILD_FINISHED')
    ),
    'The originating Phi receives the completed child report, not an earlier tool-call tail'
  )
  assert.equal(
    await readFile(join(projectRoot, 'a-effect.txt'), 'utf8'),
    'a executed only after its own approval'
  )
  assert.equal(await f.exists(join(projectRoot, 'b-effect.txt')), false)
  assert.ok(
    f.provider.requests.some(
      (request) => actor(request) === 'a' && JSON.stringify(request.messages).includes(STEER)
    ),
    JSON.stringify({
      reason: 'Only child A receives the actual steering message',
      hits,
      snapshots: [...snapshots.values()],
      childRequests: f.provider.requests
        .filter((request) => actor(request) === 'a')
        .map((request) => request.messages.slice(-3))
    })
  )
  await until(
    async () => (await readFile(a.childSessionFile, 'utf8')).includes(STEER),
    'The SDK child journal durably contains its steering message'
  )
  const childJournal = await readFile(a.childSessionFile, 'utf8')
  assert.ok(
    childJournal.includes(STEER),
    JSON.stringify({
      reason: 'The ordinary steering instruction belongs to the real child journal',
      journal: childJournal,
      childRequests: f.provider.requests
        .filter((request) => actor(request) === 'a')
        .map((request) => request.messages.slice(-3))
    })
  )
  const runtimeConfig = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')) as {
    journals: string
  }
  const reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
  const rootJournal = await readFile(
    join(runtimeConfig.journals, reference.journalBasename),
    'utf8'
  )
  assert.equal(rootJournal.includes(STEER), false)
  assert.equal(
    f.provider.requests
      .filter((request) => actor(request) === 'root')
      .some((request) => JSON.stringify(request).includes(STEER)),
    false
  )
  assert.deepEqual(
    wakeups,
    [f.phi.sessionId],
    'The real continuation policy selects only the successful originating Phi session once'
  )
  assert.equal(
    readSessionEvents(peer.sessionId).some((event) => event.type === 'agent_run_finished'),
    false
  )
  assert.equal(
    hits.root,
    laterMainDenied ? 3 : 2,
    'Private steering/stop and SDK background delivery never replay the parent model'
  )
  assert.equal(hits.b, 1)
  assert.equal(hits.a, 2)
  assert.equal(hits.peer, 1)
  if (laterMainDenied)
    assert.equal(await f.exists(join(projectRoot, 'later-main-must-not-write.txt')), false)
  console.log(
    `PRODUCTION_CHILD_CONTROL_OK mode=${mode} bundle=${bundleHash} parent returned while two verified background children remained; exact child steer/native stop/wait and peer isolation; one original-Phi continuation decision, no parent replay`
  )
} catch (error) {
  console.error(failureState(error))
  throw error
} finally {
  phase = `cleanup-after-${phase}`
  if (peerRun && !peerRun.outcome) {
    f.runners.stopRun(peerRun.sessionId)
    await f.engine.sessions.abort({ sessionId: peerRuntime }).catch(() => undefined)
    await peerRun.done
  }
  for (const unregister of cleanup.reverse()) unregister()
  await f.close()
}
