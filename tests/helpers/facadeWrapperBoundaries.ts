import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import { readCompositionRemoteSnapshot } from '../../src/main/agent/wrappers/composition/run-record'
import { isAlive, WRAPPER_ID } from './wrapperSandbox'
import { listWrapperRuns, readWrapperRun } from '../../src/main/agent/wrappers/store'
import { createRemoteProject, type Project } from '../../src/main/agent/projects'
import { getRemoteHostProfile, saveRemoteHostProfile } from '../../src/main/agent/remote-hosts'
import {
  createPhiSession,
  createRunId,
  appendSessionEvent,
  findPhiSessionById,
  readSessionEvents
} from '../../src/main/agent/session/session-store'
import { ensureRemoteProjectAnchor } from '../../src/main/agent/remote-project-anchor'
import { createAppRemoteSessionManager } from '../../src/main/agent/remote-session-routing'
import {
  createRuntimeAgentSession,
  type RuntimeAgentSession
} from '../../src/main/agent/runtime/runtime-adapter'
import type { WrapperJobManager } from '../../src/main/agent/wrappers/composition/job-manager'
import { deliverWrapperRunFinished } from '../../src/main/agent/wrappers/composition/job-notify'
import {
  shouldContinueConversation,
  wrapperRunContinuationPrompt
} from '../../src/main/agent/wrappers/composition/job-continue'
import { createLocalShellSession } from './localShellSession'

export interface WrapperBoundaryContext {
  f: FacadeMetadataFixture
  jobs: WrapperJobManager
  proxy: RuntimeAgentSession
  project: Project
  origins: Map<string, { phiSessionId: string }>
  root: string
  agentDir: string
  controls: {
    doctorEntered: boolean
    startSettled: boolean
    waitEntered: boolean
    holdDoctor?: Promise<void>
    launchCommands: string[]
  }
  waitFor(check: () => boolean | Promise<boolean>): Promise<void>
}

export async function runWrapperBoundaryScenario(
  c: WrapperBoundaryContext,
  mode: string
): Promise<void> {
  const { f, jobs, controls, agentDir, root } = c
  const begin = (
    text: string,
    proxy = c.proxy,
    phiId = f.phi.sessionId
  ): ReturnType<typeof f.runners.startRun> =>
    f.runners.startRun({
      sessionId: phiId,
      runId: createRunId(),
      execute: () => proxy.prompt(text)
    })
  const enqueueStart = (wake = false): void =>
    f.provider.enqueue({
      tool: {
        name: 'wrapper_run',
        args: {
          id: WRAPPER_ID,
          params: { gff: 'tests/data/genome.gff3' },
          ...(wake ? {} : { continue_when_done: false })
        }
      }
    })
  const awaitAccepted = async (): Promise<string> => {
    await c.waitFor(() => listWrapperRuns(agentDir).length > 0)
    const id = listWrapperRuns(agentDir)[0].runId
    await c.waitFor(() => !!readWrapperRun(id, agentDir)?.remote?.runDir)
    return id
  }
  const approvalEvent: NonNullable<Parameters<typeof f.configureApproval>[0]['onEvent']> = (
    event
  ) => {
    if (event.type === 'approval_requested')
      f.runners.markNeedsApproval(event.sessionId, event.approvalId, {
        toolName: event.request.toolName,
        summary: event.request.summary
      })
    else if (event.type === 'approval_approved')
      f.runners.markApprovalApproved(event.sessionId, event.approvalId)
    else if (event.type === 'approval_denied')
      f.runners.markApprovalDenied(event.sessionId, event.approvalId)
    else f.runners.markApprovalCancelled(event.sessionId, event.approvalId)
  }
  if (mode === 'wrapper-denied' || mode === 'wrapper-pending-stop') {
    let decide: ((value: 'approved') => void) | undefined
    f.configureApproval({
      shouldGate: () => true,
      onEvent: approvalEvent,
      requestToolApproval: () => {
        if (mode === 'wrapper-denied') return 'denied'
        return new Promise((resolve) => {
          decide = resolve
        })
      }
    })
    enqueueStart()
    if (mode === 'wrapper-denied') f.provider.enqueue({ text: 'Wrapper permission denied' })
    const run = begin('Start only if this exact Wrapper request is approved')
    if (mode === 'wrapper-pending-stop') {
      await c.waitFor(() => !!decide || !!run.outcome)
      assert.ok(decide)
      f.runners.stopRun(f.phi.sessionId)
      await c.proxy.abort()
      await run.done
      decide('approved')
      assert.equal(run.outcome, 'stopped')
    } else {
      await run.done
      assert.equal(run.outcome, 'failed')
    }
    assert.deepEqual(listWrapperRuns(agentDir), [])
    const approvals = readSessionEvents(f.phi.sessionId).filter((event) =>
      event.type.startsWith('approval_')
    )
    assert.deepEqual(
      approvals.map((event) => event.type),
      ['approval_requested', mode === 'wrapper-denied' ? 'approval_denied' : 'approval_cancelled']
    )
    assert.equal(new Set(approvals.map((event) => event.approvalId)).size, 1)
    return
  }
  if (mode === 'wrapper-precommit-stop' || mode === 'wrapper-precommit-rebind') {
    let release!: () => void
    controls.holdDoctor = new Promise((resolve) => {
      release = resolve
    })
    const location = c.project.location
    if (location.kind !== 'ssh') throw new Error('Expected SSH project')
    const original = getRemoteHostProfile(location.hostProfileId)!
    try {
      enqueueStart()
      if (mode.endsWith('rebind')) f.provider.enqueue({ text: 'Stale target was refused' })
      const run = begin('Wait for the selected server preparation before accepting a job')
      await c.waitFor(() => controls.doctorEntered || !!run.outcome)
      assert.equal(controls.doctorEntered, true)
      if (mode.endsWith('stop')) {
        f.runners.stopRun(f.phi.sessionId)
        await c.proxy.abort()
      } else saveRemoteHostProfile({ ...original, hostAlias: 'replacement-no-ssh-host' })
      release()
      await c.waitFor(() => controls.startSettled)
      await run.done.catch(() => undefined)
      assert.deepEqual(
        listWrapperRuns(agentDir),
        [],
        'revoked precommit request must never accept a job'
      )
      if (mode.endsWith('stop')) assert.equal(run.outcome, 'stopped')
      else
        assert.match(
          JSON.stringify(f.provider.requests.at(-1)?.messages),
          /Wrapper host binding changed/
        )
    } finally {
      release()
      saveRemoteHostProfile(original)
      controls.holdDoctor = undefined
    }
    return
  }
  if (mode === 'wrapper-accepted-peer-stop') {
    enqueueStart()
    f.provider.enqueue({ text: 'Primary job independently accepted' })
    await begin('Start primary background job').done
    const ownId = await awaitAccepted()
    const location = c.project.location
    if (location.kind !== 'ssh') throw new Error('Expected SSH project')
    const peerRoot = join(dirname(root), 'independent-wrapper-peer')
    await mkdir(join(peerRoot, 'tests/data'), { recursive: true })
    await writeFile(join(peerRoot, 'tests/data/genome.gff3'), '##gff-version 3\n')
    const project = await createRemoteProject(
      {
        name: 'Independent Wrapper peer',
        hostProfileId: location.hostProfileId,
        remoteRoot: peerRoot,
        permissionMode: 'ask'
      },
      { connectImpl: async () => createLocalShellSession() }
    )
    if (project.location.kind !== 'ssh') throw new Error('Expected SSH peer')
    const anchor = ensureRemoteProjectAnchor(project.id)
    const phi = createPhiSession({
      kind: 'project',
      projectId: project.id,
      projectLocation: project.location,
      cwd: anchor,
      cwdRealPath: anchor,
      permissionMode: 'ask',
      model: f.phi.manifest.model,
      thinkingLevel: 'high'
    })
    const peer = (
      await createRuntimeAgentSession({
        cwd: anchor,
        model: f.model('model-a'),
        thinkingLevel: 'high',
        projectBound: true,
        sessionManager: createAppRemoteSessionManager(anchor, phi.sessionId, false),
        remoteProject: {
          phiSessionId: phi.sessionId,
          projectId: project.id,
          location: project.location,
          contextFiles: []
        }
      })
    ).session
    c.origins.set(peer.runtimeSessionId, { phiSessionId: phi.sessionId })
    try {
      enqueueStart()
      f.provider.enqueue({ text: 'Independent peer job accepted' })
      await begin('Start independent peer job', peer, phi.sessionId).done
      const peerId = listWrapperRuns(agentDir).find(
        (run) => run.originSessionId === peer.runtimeSessionId
      )!.runId
      assert.equal((await jobs.status(ownId))?.state, 'running')
      assert.equal((await jobs.status(peerId))?.state, 'running')
      await c.waitFor(() =>
        Boolean(
          readCompositionRemoteSnapshot(ownId, agentDir)?.pid &&
          readCompositionRemoteSnapshot(peerId, agentDir)?.pid
        )
      )
      const ownPid = readCompositionRemoteSnapshot(ownId, agentDir)!.pid!,
        peerPid = readCompositionRemoteSnapshot(peerId, agentDir)!.pid!
      assert.equal(isAlive(ownPid), true)
      assert.equal(isAlive(peerPid), true)
      assert.equal(controls.launchCommands.length, 2)
      f.provider.enqueue({
        tool: { name: 'wrapper_wait', args: { run_id: ownId, timeout_seconds: 60 } }
      })
      const waiting = begin('Wait for the already accepted primary job')
      await c.waitFor(() => controls.waitEntered || !!waiting.outcome)
      assert.equal(controls.waitEntered, true)
      const requests = f.provider.requests.length
      f.runners.stopRun(f.phi.sessionId)
      await c.proxy.abort()
      await waiting.done
      assert.equal(waiting.outcome, 'stopped')
      // Native model transport may already be in flight before the abort acknowledgement.
      // The background-job contract is no duplicate acceptance/launch, not rollback of HTTP.
      if (f.provider.requests.length !== requests)
        console.log(
          'native pre-abort in-flight model boundary',
          JSON.stringify(
            f.provider.requests.slice(requests).map((request) => request.messages.at(-1))
          )
        )
      assert.equal(listWrapperRuns(agentDir).length, 2)
      assert.equal(controls.launchCommands.length, 2)
      assert.equal(isAlive(ownPid), true)
      assert.equal(isAlive(peerPid), true)
      assert.equal(
        (await jobs.status(ownId))?.state,
        'running',
        'chat stop only stops waiting, not an accepted job'
      )
      assert.equal(
        (await jobs.status(peerId))?.state,
        'running',
        'peer background work must remain independent'
      )
      f.provider.enqueue(
        { tool: { name: 'wrapper_run', args: { id: WRAPPER_ID, target: 'local' } } },
        { tool: { name: 'wrapper_status', args: { run_id: peerId } } },
        { tool: { name: 'wrapper_cancel', args: { run_id: peerId } } },
        { tool: { name: 'wrapper_cancel', args: { run_id: ownId } } },
        { text: 'Only the owned remote job may be cancelled' }
      )
      await begin('Refuse local execution and peer controls; explicitly cancel only my job').done
      await jobs.wait(ownId, 10000)
      assert.equal((await jobs.status(ownId))?.state, 'cancelled')
      assert.equal((await jobs.status(peerId))?.state, 'running')
      assert.equal(isAlive(peerPid), true)
      assert.equal(controls.launchCommands.length, 2)
      assert.equal(jobs.hasBeenReported(peerId), false)
      assert.equal(
        listWrapperRuns(agentDir).length,
        2,
        'explicit local request must not create a desktop job'
      )
      assert.match(JSON.stringify(f.provider.requests.at(-1)?.messages), /not owned/)
      assert.match(
        JSON.stringify(f.provider.requests.at(-1)?.messages),
        /cannot run a wrapper on the desktop/
      )
    } finally {
      await peer.dispose()
    }
    return
  }
  if (mode === 'wrapper-wake') {
    let wakes = 0
    let wakeDone: Promise<void> | undefined
    const unsubscribe = jobs.onFinish((run, status) =>
      deliverWrapperRunFinished(run, status, {
        resolveSession: (id) => {
          const origin = c.origins.get(id ?? '')
          return origin ? { ...origin, cwd: f.phi.manifest.cwd } : undefined
        },
        appendToSession: (phiId, event) => appendSessionEvent(phiId, { ...event }),
        sendToWindow: () => undefined,
        isAppFocused: () => true,
        showOsNotification: () => undefined,
        continueConversation: (phiId, event, record) => {
          if (
            !shouldContinueConversation({ run: record, state: event.state, automaticCount: wakes })
              .continue
          )
            return
          assert.equal(phiId, f.phi.sessionId)
          wakes++
          wakeDone = begin(wrapperRunContinuationPrompt([event])).done
        }
      })
    )
    try {
      enqueueStart(true)
      f.provider.enqueue({
        text: 'Background job accepted; completion may wake the owning Phi conversation'
      })
      await begin('Start a background job with normal completion wake enabled').done
      const jobId = await awaitAccepted()
      const reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
      const before = f.provider.requests.length
      await c.proxy.dispose()
      f.resume()
      c.proxy = (await f.createApplicationSession()).session
      c.origins.set(c.proxy.runtimeSessionId, { phiSessionId: f.phi.sessionId })
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.ompSessionId,
        reference.ompSessionId
      )
      assert.equal(
        f.provider.requests.length,
        before,
        'restoring must not replay the background job'
      )
      f.provider.enqueue({
        text: 'One actual RPC continuation consumed the existing background result'
      })
      const runDir = readWrapperRun(jobId, agentDir)!.remote!.runDir
      await c.waitFor(async () => (await jobs.status(jobId))?.state === 'running')
      await mkdir(runDir, { recursive: true })
      await writeFile(join(runDir, 'allow-finish'), '')
      await c.waitFor(() => !!wakeDone)
      await wakeDone
      assert.equal(wakes, 1)
      assert.equal(f.provider.requests.length, before + 1)
      assert.equal(
        readSessionEvents(f.phi.sessionId).filter((event) => event.type === 'wrapper_run_finished')
          .length,
        1
      )
      assert.equal(listWrapperRuns(agentDir).length, 1)
    } finally {
      unsubscribe()
    }
    return
  }
  throw new Error(`Unknown Wrapper scenario: ${mode}`)
}
