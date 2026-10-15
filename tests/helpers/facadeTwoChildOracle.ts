import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import {
  createPhiSession,
  createRunId,
  findPhiSessionById,
  readSessionEvents
} from '../../src/main/agent/session/session-store'
import type { SessionRun } from '../../src/main/agent/session/session-runner-registry'
import type { ToolApprovalRequest } from '../../src/main/agent/tool-approval'
import type { RpcApprovalEvent } from '../../src/main/agent/engine/rpc/approval-bridge'
import type { RpcChildRuntimeConfig } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'
import type { RpcChildRunSnapshot } from '../../src/main/agent/engine/rpc/subagents/types'

async function waitFor(check: () => boolean): Promise<void> {
  const began = Date.now()
  while (!check()) {
    assert.ok(Date.now() - began < 15000)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
/** Two actual model-issued native children, each owned by a different registered Phi submission. */
export async function runTwoPendingChildren(
  f: FacadeMetadataFixture,
  events: RpcApprovalEvent[],
  parents: SessionRun[]
): Promise<void> {
  const dialogs: Array<{
    request: Readonly<ToolApprovalRequest>
    signal: AbortSignal
    decide(value: 'approved'): void
  }> = []
  f.configureApproval({
    shouldGate: () => true,
    requestToolApproval: (request, signal) =>
      new Promise((resolve) => {
        dialogs.push({ request, signal, decide: resolve })
      })
  })
  const a = 'two-child-a',
    b = 'two-child-b'
  await f.engine.sessions.create(f.params(a))
  const firstDirectory = (await f.privateDirectories())[0]
  const configA: RpcChildRuntimeConfig = JSON.parse(
    await readFile(join(firstDirectory, 'child-runtime.json'), 'utf8')
  )
  const pathA = join(f.f.scope.projectRoot, 'child-a-must-not-write.txt'),
    pathB = join(f.f.scope.projectRoot, 'child-b-approved.txt')
  const task = (name: string, id: string): void =>
    f.provider.enqueue({
      tool: {
        name: 'task',
        id,
        args: {
          i: 'Run one foreground child',
          agent: name,
          name: id + '-child',
          task: 'Write the specifically requested file',
          solutionSpace: 'Independent private Phi run'
        }
      }
    })
  task(configA.profiles[0].definition.nativeName, 'task-a')
  f.provider.enqueue({
    tool: { name: 'write', id: 'write-a', args: { path: pathA, content: 'never authorized' } }
  })
  const runA = f.runners.startRun({
    sessionId: f.phi.sessionId,
    runId: createRunId(),
    execute: async () => {
      await f.engine.sessions.prompt({ sessionId: a, text: 'Create child A and await approval' })
    }
  })
  await waitFor(() => dialogs.length === 1 || !!runA.outcome)
  assert.equal(runA.outcome, undefined)
  assert.equal(typeof dialogs[0].request.agentRunId, 'string')
  assert.notEqual(dialogs[0].request.runId, runA.runId)
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
  const paramsB = f.params(b)
  paramsB.remoteProject = { ...paramsB.remoteProject!, phiSessionId: peer.sessionId }
  await f.engine.sessions.create(paramsB)
  let configB: RpcChildRuntimeConfig | undefined, directoryB: string | undefined
  for (const directory of await f.privateDirectories()) {
    const candidate: RpcChildRuntimeConfig = JSON.parse(
      await readFile(join(directory, 'child-runtime.json'), 'utf8')
    )
    if (candidate.phiSessionId === peer.sessionId) {
      configB = candidate
      directoryB = directory
    }
  }
  assert.ok(configB && directoryB)
  assert.notEqual(configA.capability, configB.capability)
  task(configB.profiles[0].definition.nativeName, 'task-b')
  f.provider.enqueue({
    tool: { name: 'write', id: 'write-b', args: { path: pathB, content: 'actual child B only' } }
  })
  const runB = f.runners.startRun({
    sessionId: peer.sessionId,
    runId: createRunId(),
    execute: async () => {
      await f.engine.sessions.prompt({
        sessionId: b,
        text: 'Create child B independently and await approval'
      })
    }
  })
  await waitFor(() => dialogs.length === 2 || !!runB.outcome)
  assert.equal(runB.outcome, undefined)
  assert.equal(typeof dialogs[1].request.agentRunId, 'string')
  assert.notEqual(dialogs[1].request.runId, runB.runId)
  assert.notEqual(dialogs[0].request.agentRunId, dialogs[1].request.agentRunId)
  assert.deepEqual(parents, [runA, runB])
  assert.equal(findPhiSessionById(runA.sessionId)!.status, 'needs_approval')
  assert.equal(findPhiSessionById(runB.sessionId)!.status, 'needs_approval')
  assert.equal(await f.exists(pathA), false)
  assert.equal(await f.exists(pathB), false)
  f.runners.stopRun(runA.sessionId)
  await f.engine.sessions.abort({ sessionId: a })
  await runA.done
  assert.equal(runA.outcome, 'stopped')
  dialogs[0].decide('approved')
  assert.equal(await f.exists(pathA), false)
  assert.equal(runB.signal.aborted, false)
  assert.equal(dialogs[1].signal.aborted, false)
  assert.equal(findPhiSessionById(runB.sessionId)!.status, 'needs_approval')
  assert.equal(f.engine.sessions.has(b), true)
  assert.equal(await f.exists(join(directoryB, 'child-runtime.json')), true)
  assert.equal(f.provider.requests.length, 4)
  f.provider.enqueue({ text: 'child B finished' }, { text: 'parent B finished' })
  dialogs[1].decide('approved')
  await runB.done
  assert.equal(runB.outcome, 'completed')
  assert.equal(await readFile(pathB, 'utf8'), 'actual child B only')
  assert.equal(await f.exists(pathA), false)
  for (const [run, dialog, terminal] of [
    [runA, dialogs[0], 'approval_cancelled'],
    [runB, dialogs[1], 'approval_approved']
  ] as const) {
    const durable = readSessionEvents(run.sessionId).filter((event) =>
      event.type.startsWith('approval_')
    )
    assert.deepEqual(
      durable.map((event) => event.type),
      ['approval_requested', terminal]
    )
    assert.ok(
      durable.every(
        (event) => event.runId === dialog.request.agentRunId && event.parentRunId === run.runId
      )
    )
  }
  assert.equal(events.length, 4)
  f.provider.enqueue({ text: 'next A parent turn after its scoped stop' })
  const nextA = f.runners.startRun({
    sessionId: runA.sessionId,
    runId: createRunId(),
    execute: async () => {
      await f.engine.sessions.prompt({
        sessionId: a,
        text: 'Continue A without disturbing B history'
      })
    }
  })
  await nextA.done
  assert.equal(nextA.outcome, 'completed')
  assert.equal(f.provider.requests.length, 7)
  console.log(
    'two real pending native children: A stop/late UI isolated, B approved, A next turn reusable'
  )
}

/** One pure foreground batch reserves native IDs only after its public spawn hooks. */
export async function runUnnamedForegroundBatch(
  f: FacadeMetadataFixture,
  events: RpcApprovalEvent[],
  parents: SessionRun[],
  children: ReadonlyMap<string, Readonly<RpcChildRunSnapshot>>
): Promise<void> {
  const dialogs: Array<{
    request: Readonly<ToolApprovalRequest>
    decide(value: 'approved'): void
  }> = []
  f.configureApproval({
    shouldGate: () => true,
    requestToolApproval: (request) =>
      new Promise((resolve) => dialogs.push({ request, decide: resolve }))
  })
  const id = 'unnamed-foreground-parent'
  await f.engine.sessions.create(f.params(id))
  const config: RpcChildRuntimeConfig = JSON.parse(
    await readFile(join((await f.privateDirectories())[0], 'child-runtime.json'), 'utf8')
  )
  assert.equal(config.policy.allowParallel, true)
  assert.equal(config.policy.allowBackground, undefined)
  const nativeName = config.profiles[0].definition.nativeName
  const paths = ['a', 'b'].map((suffix) =>
    join(f.f.scope.projectRoot, `unnamed-foreground-${suffix}.txt`)
  )
  f.provider.enqueue(
    {
      tool: {
        name: 'task',
        id: 'unnamed-foreground-task',
        args: {
          i: 'Delegate two real foreground tasks without labels',
          context: 'One bounded pure foreground batch',
          tasks: paths.map((path) => ({
            agent: nativeName,
            task: 'Write only the requested fixture file: ' + path,
            solutionSpace: 'The current private project'
          }))
        }
      }
    },
    ...paths.map((path, index) => ({
      tool: {
        name: 'write',
        id: 'unnamed-child-write-' + index,
        args: { path, content: 'Actual unnamed foreground child ' + index }
      }
    }))
  )
  const run = f.runners.startRun({
    sessionId: f.phi.sessionId,
    runId: createRunId(),
    execute: async () => {
      await f.engine.sessions.prompt({ sessionId: id, text: 'Run both unnamed foreground tasks' })
    }
  })
  await waitFor(() => dialogs.length === 2 || !!run.outcome)
  assert.equal(run.outcome, undefined)
  assert.equal(f.provider.requests.length, 3)
  assert.equal(children.size, 2)
  const records = [...children.values()]
  assert.equal(new Set(records.map((child) => child.nativeId)).size, 2)
  assert.ok(records.every((child) => child.verified && !child.background))
  assert.ok(records.every((child) => child.parentRunId === run.runId))
  assert.ok(records.every((child) => child.parentToolCallId === 'unnamed-foreground-task'))
  const childRunIds = new Set(records.map((child) => child.id))
  assert.equal(new Set(dialogs.map((dialog) => dialog.request.agentRunId)).size, 2)
  assert.ok(dialogs.every((dialog) => childRunIds.has(dialog.request.agentRunId!)))
  assert.ok(dialogs.every((dialog) => dialog.request.runId !== run.runId))
  assert.ok(parents.every((parent) => parent === run))
  for (const path of paths) assert.equal(await f.exists(path), false)
  f.provider.enqueue(
    { text: 'Actual foreground child finished' },
    { text: 'Actual foreground child finished' },
    { text: 'Parent reports both real foreground children completed' }
  )
  for (const dialog of dialogs) dialog.decide('approved')
  await run.done
  assert.equal(run.outcome, 'completed')
  for (const [index, path] of paths.entries())
    assert.equal(await readFile(path, 'utf8'), 'Actual unnamed foreground child ' + index)
  assert.equal(f.provider.requests.length, 6)
  const durable = readSessionEvents(run.sessionId).filter((event) =>
    event.type.startsWith('approval_')
  )
  assert.equal(durable.filter((event) => event.type === 'approval_requested').length, 2)
  assert.equal(durable.filter((event) => event.type === 'approval_approved').length, 2)
  assert.equal(durable.length, 4)
  assert.ok(
    durable.every((event) => childRunIds.has(event.runId!) && event.parentRunId === run.runId)
  )
  assert.equal(events.length, 4)
  console.log(
    'Two unnamed foreground native IDs, two exact child approvals, two real writes, no Main fallback'
  )
}
