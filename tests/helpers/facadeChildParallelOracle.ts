import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import type { ParallelChildProvider } from './facadeChildParallelProvider'
import { shellQuote as q } from '../../src/main/agent/wrappers/remote-ssh-session'
import { holdChildCancellationAck, holdMainApprovalCommit } from './facadeChildControlProbe'
import {
  createPhiSession,
  createRunId,
  findPhiSessionById
} from '../../src/main/agent/session/session-store'
import type { ToolApprovalRequest } from '../../src/main/agent/tool-approval'
import type { RpcChildRuntimeConfig } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'

async function waitFor(check: () => boolean, evidence?: () => string): Promise<void> {
  const began = Date.now()
  while (!check()) {
    assert.ok(
      Date.now() - began < 15000,
      'actual scheduler/approval evidence did not arrive: ' + (evidence?.() ?? '')
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
/** Real shared TaskTool + non-pty BashTool dispatch; neither native concurrency nor SDK code is changed. */
export async function runParallelChildStop(
  f: FacadeMetadataFixture,
  provider: ParallelChildProvider,
  mode: string
): Promise<void> {
  const pending: Array<{
    request: Readonly<ToolApprovalRequest>
    signal: AbortSignal
    decide(value: 'approved'): void
  }> = []
  let mainApprovedNotices = 0
  const mainCommit = holdMainApprovalCommit()
  try {
    f.configureApproval({
      shouldGate: () => true,
      requestToolApproval: (request, signal) =>
        new Promise((resolve) => {
          pending.push({ request, signal, decide: resolve })
        }),
      onEvent(event) {
        const active = f.runners.getActiveRun(event.sessionId)
        if (!active || active.runId !== event.runId) return
        if (event.type === 'approval_requested')
          f.runners.markNeedsApproval(event.sessionId, event.approvalId)
        else if (event.type === 'approval_approved') {
          mainApprovedNotices++
          f.runners.markApprovalApproved(event.sessionId, event.approvalId)
        } else if (event.type === 'approval_denied')
          f.runners.markApprovalDenied(event.sessionId, event.approvalId)
        else f.runners.markApprovalCancelled(event.sessionId, event.approvalId)
      }
    })
    const id = 'batch-parent'
    const activity: Array<{ type: string; name: string; isError?: boolean }> = []
    f.engine.events.onSessionEvent(id, (event) => {
      if (
        (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') &&
        typeof event.toolName === 'string'
      )
        activity.push({
          type: event.type,
          name: event.toolName,
          ...('isError' in event && typeof event.isError === 'boolean'
            ? { isError: event.isError }
            : {})
        })
    })
    const evidence = (): string =>
      JSON.stringify({
        pending: pending.map((item) => ({
          tool: item.request.toolName,
          child: !!item.request.agentRunId
        })),
        providerCount: provider.requests.length,
        activity
      })
    await f.engine.sessions.create(f.params(id))
    const directory = (await f.privateDirectories())[0]
    const config: RpcChildRuntimeConfig = JSON.parse(
      await readFile(join(directory, 'child-runtime.json'), 'utf8')
    )
    const originalReference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
    const runtimeConfig: { journals: string } = JSON.parse(
      await readFile(join(directory, 'runtime.json'), 'utf8')
    )
    const childPath = join(f.f.scope.projectRoot, 'late-batch-child.txt'),
      mainPath = join(f.f.scope.projectRoot, 'late-batch-main.txt')
    const startedPath = mainPath + '.started',
      pidPath = mainPath + '.pid'
    const command =
      mode === 'parallel-stop'
        ? 'sh -c ' +
          q(
            `printf '%s' "$$" > ${q(pidPath)}; printf STARTED > ${q(startedPath)}; sleep 30; printf AFTER > ${q(mainPath)}`
          )
        : `printf APPROVED_MAIN > ${q(mainPath)}`
    provider.enqueue(
      {
        tools: [
          {
            name: 'task',
            id: 'batch-task',
            args: {
              i: 'Delegate actual foreground task',
              agent: config.profiles[0].definition.nativeName,
              name: 'batch-child',
              task: 'Write the requested child file',
              solutionSpace: 'Private loopback'
            }
          },
          {
            name: 'bash',
            id: 'batch-main-bash',
            args: { command }
          }
        ]
      },
      ...(mode === 'parallel-main-stop'
        ? []
        : [
            {
              tool: {
                name: 'write',
                id: 'batch-child-write',
                args: { path: childPath, content: 'must never execute' }
              }
            }
          ])
    )
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: async () => {
        await f.engine.sessions.prompt({
          sessionId: id,
          text: 'Run the native task and root write batch'
        })
      }
    })
    await waitFor(() => pending.some((item) => !item.request.agentRunId) || !!run.outcome, evidence)
    assert.equal(run.outcome, undefined)
    const main = pending.find((item) => !item.request.agentRunId)!
    assert.equal(pending.length, 1)
    assert.equal(provider.requests.length, 1)
    assert.equal(activity.length, 0, 'the real SDK prepares every tool before native execution')
    if (mode === 'parallel-main-stop') {
      f.runners.stopRun(run.sessionId)
      const stopped = f.engine.sessions.abort({ sessionId: id })
      void stopped.catch(() => undefined)
      assert.equal(main.signal.aborted, true)
      main.decide('approved')
      await stopped
      await run.done
      assert.equal(run.outcome, 'stopped')
      assert.equal(await f.exists(mainPath), false)
      assert.equal(await f.exists(childPath), false)
      assert.equal(provider.requests.length, 1)
      assert.equal(f.engine.sessions.has(id), false, 'no-spawn stop must retire the old channel')
      const stoppedReference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
      assert.ok(stoppedReference.checkpoint, 'the final stopped checkpoint must be adopted')
      assert.equal(stoppedReference.ompSessionId, originalReference.ompSessionId)
      assert.equal(stoppedReference.journalBasename, originalReference.journalBasename)
      assert.ok(
        (
          await readFile(join(runtimeConfig.journals, stoppedReference.journalBasename), 'utf8')
        ).includes('batch-task'),
        'the preserved journal must contain the actual stopped turn'
      )
      const oldChannel = f.channels[0]
      await oldChannel.closed
      assert.equal(await f.exists(directory), false, 'only the old private generation is removed')
      await assert.rejects(
        f.engine.sessions.prompt({ sessionId: id, text: 'An old runtime must remain a tombstone' })
      )
      assert.equal(provider.requests.length, 1)

      const peer = createPhiSession({
        kind: 'project',
        projectId: f.phi.manifest.projectId,
        projectLocation: f.phi.manifest.projectLocation,
        cwd: f.phi.manifest.cwd,
        cwdRealPath: f.phi.manifest.cwdRealPath,
        permissionMode: 'ask',
        model: f.phi.manifest.model,
        thinkingLevel: f.phi.manifest.thinkingLevel
      })
      const peerParams = f.params('unspawned-peer')
      peerParams.remoteProject = { ...peerParams.remoteProject!, phiSessionId: peer.sessionId }
      await f.engine.sessions.create(peerParams)
      provider.enqueue({ text: 'independent peer keeps streaming', hold: true })
      const peerRun = f.runners.startRun({
        sessionId: peer.sessionId,
        runId: createRunId(),
        execute: async () => {
          await f.engine.sessions.prompt({ sessionId: peerParams.sessionId, text: 'Stay active' })
        }
      })
      await waitFor(() => provider.requests.length === 2)
      await f.engine.sessions.dispose({ sessionId: id })
      assert.equal(peerRun.signal.aborted, false)
      const beforeResume = provider.requests.length
      f.resume()
      const freshId = 'unspawned-parent-resumed'
      await f.engine.sessions.create(f.params(freshId))
      const restored = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
      assert.equal(restored.ompSessionId, stoppedReference.ompSessionId)
      assert.equal(restored.journalBasename, stoppedReference.journalBasename)
      assert.equal(provider.requests.length, beforeResume, 'resume must never replay a prompt')
      assert.notEqual(f.channels.at(-1), oldChannel, 'resume launches an actual fresh CLI channel')
      const configs = await Promise.all(
        (await f.privateDirectories()).map(async (path) => ({
          path,
          config: JSON.parse(
            await readFile(join(path, 'child-runtime.json'), 'utf8')
          ) as RpcChildRuntimeConfig
        }))
      )
      const fresh = configs.find((item) => item.config.phiSessionId === f.phi.sessionId)!
      assert.ok(fresh)
      assert.notEqual(fresh.path, directory)
      assert.notEqual(
        fresh.config.nonce,
        config.nonce,
        'new channel has a distinct capability domain'
      )
      assert.notEqual(fresh.config.capability, config.capability)
      assert.equal(peerRun.signal.aborted, false)
      const nextPath = childPath + '.fresh'
      provider.enqueue(
        {
          tool: {
            name: 'task',
            id: 'batch-task',
            args: {
              i: 'Reuse the real outer ID only in the new generation',
              agent: fresh.config.profiles[0].definition.nativeName,
              name: 'batch-child',
              task: 'Write the fresh-generation child file',
              solutionSpace: 'Private loopback'
            }
          }
        },
        {
          tool: {
            name: 'write',
            id: 'batch-child-write',
            args: { path: nextPath, content: 'fresh actual child' }
          }
        },
        { text: 'fresh child finished' },
        { text: 'fresh parent finished' }
      )
      const beforePending = pending.length
      const next = f.runners.startRun({
        sessionId: f.phi.sessionId,
        runId: createRunId(),
        execute: async () => {
          await assert.rejects(
            f.engine.sessions.prompt({ sessionId: id, text: 'The old opaque owner stays retired' })
          )
          assert.equal(provider.requests.length, beforeResume)
          await f.engine.sessions.prompt({
            sessionId: freshId,
            text: 'Explicitly delegate the next child'
          })
        }
      })
      await waitFor(() => pending.length > beforePending || !!next.outcome)
      assert.equal(next.outcome, undefined)
      const nextChild = pending.at(-1)!
      assert.equal(typeof nextChild.request.agentRunId, 'string')
      assert.notEqual(
        nextChild.request.runId,
        next.runId,
        'a root fallback writer is never a child'
      )
      assert.equal(await f.exists(nextPath), false)
      nextChild.decide('approved')
      await next.done
      assert.equal(next.outcome, 'completed')
      assert.equal(await readFile(nextPath, 'utf8'), 'fresh actual child')
      assert.equal(provider.requests.length, beforeResume + 4)
      assert.equal(peerRun.signal.aborted, false)
      assert.equal(f.engine.sessions.has(id), false)
      await f.engine.sessions.abort({ sessionId: peerParams.sessionId })
      await peerRun.done
      assert.equal(peerRun.outcome, 'stopped')
      console.log(
        'real predispatch MAIN stop preserves no effects, retires its generation and explicitly resumes the same journal with a real same-ID child'
      )
      return
    }
    main.decide('approved')
    await mainCommit.submitted
    await waitFor(
      () => pending.some((item) => !!item.request.agentRunId) || !!run.outcome,
      evidence
    )
    assert.equal(
      run.outcome,
      undefined,
      'an approved MAIN decision must allow the real TaskTool to start'
    )
    const child = pending.find((item) => item.request.agentRunId)!
    assert.equal(typeof child.request.agentRunId, 'string')
    assert.notEqual(child.request.runId, run.runId)
    assert.equal(pending.length, 2)
    assert.equal(
      mainApprovedNotices,
      0,
      'only the real main allow write completion notification is held'
    )
    assert.equal(main.request.runId, run.runId)
    assert.equal(main.request.toolName, 'bash')
    assert.equal(run.status, 'needs_approval')
    assert.equal(findPhiSessionById(run.sessionId)!.status, 'needs_approval')
    if (mode === 'parallel-main-first' || mode === 'parallel-child-first') {
      if (mode === 'parallel-main-first') {
        mainCommit.release()
        await waitFor(() => mainApprovedNotices === 1)
        assert.equal(
          run.status,
          'needs_approval',
          'MAIN terminal must preserve a pending CHILD approval'
        )
        assert.equal(findPhiSessionById(run.sessionId)!.status, 'needs_approval')
      } else {
        provider.enqueue({ text: 'child remains streaming after its approved write', hold: true })
        child.decide('approved')
        const began = Date.now()
        while (!(await f.exists(childPath))) {
          assert.ok(Date.now() - began < 5000)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        await waitFor(() => provider.requests.length === 3)
        assert.equal(mainApprovedNotices, 0)
        assert.equal(
          run.status,
          'needs_approval',
          'CHILD terminal must preserve the in-transit MAIN approval terminal'
        )
        assert.equal(findPhiSessionById(run.sessionId)!.status, 'needs_approval')
        mainCommit.release()
        await waitFor(() => mainApprovedNotices === 1)
      }
      f.runners.stopRun(run.sessionId)
      await f.engine.sessions.abort({ sessionId: id })
      await run.done
      child.decide('approved')
      assert.equal(run.outcome, 'stopped')
      if (mode === 'parallel-main-first') assert.equal(await f.exists(childPath), false)
      console.log('actual main/child approval terminal accounting preserves the other pending ID')
      return
    }
    mainCommit.release()
    await waitFor(() => mainApprovedNotices === 1)
    assert.equal(await f.exists(childPath), false)
    const bashBegan = Date.now()
    while (!(await f.exists(startedPath))) {
      assert.ok(Date.now() - bashBegan < 5000)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const mainPid = Number(await readFile(pidPath, 'utf8'))
    assert.ok(Number.isSafeInteger(mainPid) && mainPid > 1)
    process.kill(mainPid, 0)
    assert.equal(await f.exists(mainPath), false)
    const peer = createPhiSession({
      kind: 'project',
      projectId: f.phi.manifest.projectId,
      projectLocation: f.phi.manifest.projectLocation,
      cwd: f.phi.manifest.cwd,
      cwdRealPath: f.phi.manifest.cwdRealPath,
      permissionMode: 'ask',
      model: f.phi.manifest.model,
      thinkingLevel: f.phi.manifest.thinkingLevel
    })
    const peerParams = f.params('batch-peer')
    peerParams.remoteProject = { ...peerParams.remoteProject!, phiSessionId: peer.sessionId }
    await f.engine.sessions.create(peerParams)
    provider.enqueue({ text: 'peer streaming independently', hold: true })
    const peerRun = f.runners.startRun({
      sessionId: peer.sessionId,
      runId: createRunId(),
      execute: async () => {
        await f.engine.sessions.prompt({
          sessionId: peerParams.sessionId,
          text: 'Keep independent peer active'
        })
      }
    })
    await waitFor(() => provider.requests.length === 3)
    const held = holdChildCancellationAck()
    let stopped: Promise<unknown> | undefined
    try {
      f.runners.stopRun(f.phi.sessionId)
      stopped = f.engine.sessions.abort({ sessionId: id })
      void stopped.catch(() => undefined)
      await Promise.race([
        held.acknowledged,
        stopped.then(() => {
          throw new Error('parent ended before child cancel ACK')
        })
      ])
      assert.equal(held.evidence.cancelled, true)
      assert.equal(held.evidence.parentAbortCalls, 0)
      for (const item of pending) {
        assert.equal(item.signal.aborted, true)
        item.decide('approved')
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(provider.requests.length, 3)
      assert.equal(await f.exists(childPath), false)
      assert.equal(await f.exists(mainPath), false)
      assert.equal(peerRun.signal.aborted, false)
      held.release()
      await stopped
      await run.done
      assert.equal(run.outcome, 'stopped')
      assert.throws(() => process.kill(mainPid, 0), { code: 'ESRCH' })
      assert.equal(await f.exists(mainPath), false)
      assert.equal(peerRun.signal.aborted, false)
    } finally {
      held.release()
      held.restore()
      await stopped?.catch(() => undefined)
    }
    // Even when the native batch is serial, use the children-enabled owned signal
    // path for a real pending MAIN writer, rather than reusing a disabled baseline.
    const before = pending.length
    const pendingMainPath = mainPath + '.unapproved'
    provider.enqueue({
      tool: {
        name: 'write',
        id: 'enabled-main-pending',
        args: { path: pendingMainPath, content: 'late approval must stay revoked' }
      }
    })
    const mainRun = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: async () => {
        await f.engine.sessions.prompt({
          sessionId: id,
          text: 'One root write under the enabled child generation'
        })
      }
    })
    await waitFor(() => pending.length > before || !!mainRun.outcome)
    assert.equal(mainRun.outcome, undefined)
    const mainPending = pending.at(-1)!
    assert.equal(mainPending.request.agentRunId, undefined)
    assert.equal(mainPending.request.runId, mainRun.runId)
    f.runners.stopRun(f.phi.sessionId)
    const mainStopped = f.engine.sessions.abort({ sessionId: id })
    void mainStopped.catch(() => undefined)
    assert.equal(mainPending.signal.aborted, true)
    mainPending.decide('approved')
    await mainStopped
    await mainRun.done
    assert.equal(mainRun.outcome, 'stopped')
    assert.equal(await f.exists(pendingMainPath), false)
    assert.equal(provider.requests.length, 4)
    assert.equal(peerRun.signal.aborted, false)
    await f.engine.sessions.abort({ sessionId: peerParams.sessionId })
    await peerRun.done
    assert.equal(peerRun.outcome, 'stopped')
    console.log(
      JSON.stringify({
        actualChildPending: true,
        actualMainConcurrent: true,
        childAckHeldNoProvider: true,
        childrenEnabledMainPendingRevoked: true,
        independentPeerUnaffected: true
      })
    )
  } finally {
    mainCommit.restore()
  }
}
