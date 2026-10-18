import { runApplicationWrapperScenario } from './facadeWrapperOracle'
import { runApplicationNotebookScenario } from './facadeNotebookOracle'
import assert from 'node:assert/strict'
import { readFile, readdir, rm, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { facadeMetadataFixture } from './facadeMetadataFixture'
import {
  startParallelChildProvider,
  type ParallelChildProvider
} from './facadeChildParallelProvider'
import { runParallelChildStop } from './facadeChildParallelOracle'
import { runDelayedChildStarted } from './facadeChildStartedOracle'
import { runTwoPendingChildren, runUnnamedForegroundBatch } from './facadeTwoChildOracle'
import { runReentrantChildClose } from './facadeChildReentrantOracle'
import { runForegroundHostStop } from './facadeChildHostOracle'
import type { PhiAgentDefinition } from '../../src/main/agent/agents/definition'
import {
  createRunId,
  createPhiSession,
  findPhiSessionById,
  readSessionEvents,
  updateSessionManifest
} from '../../src/main/agent/session/session-store'
import type { SessionRun } from '../../src/main/agent/session/session-runner-registry'
import type { ToolApprovalRequest } from '../../src/main/agent/tool-approval'
import type { RpcApprovalEvent } from '../../src/main/agent/engine/rpc/approval-bridge'
import { holdChildCancellationAck } from './facadeChildControlProbe'
import type { RpcChildRuntimeConfig } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'
import type { RpcChildRunSnapshot } from '../../src/main/agent/engine/rpc/subagents/types'

const applicationRouting = process.env.PHI_FACADE_CHILD_MODE?.startsWith('app-') === true
const mode = (process.env.PHI_FACADE_CHILD_MODE ?? 'approved').replace(/^app-/, '')
const definition: PhiAgentDefinition = {
  name: 'Checker',
  description: 'Check one bounded foreground task',
  tools: ['read', 'write', 'bash'],
  skills: [],
  visibility: 'entry',
  warnings: [],
  source: 'phi',
  filePath: '/trusted-fixture/Checker.md',
  systemPrompt: 'PRIVATE_FOREGROUND_CHECKER. Complete only the requested task.'
}
const childEvents: RpcApprovalEvent[] = [],
  childParents: SessionRun[] = [],
  mainEvents: RpcApprovalEvent[] = []
const batchChildren = new Map<string, Readonly<RpcChildRunSnapshot>>()
let releaseSelection: (() => void) | undefined
let selectionStarted: (() => void) | undefined
const selectionReached = new Promise<void>((resolve) => {
  selectionStarted = resolve
})
let parallelProvider: ParallelChildProvider | undefined
const f = await facadeMetadataFixture({
  isolatedProject: true,
  ...(applicationRouting
    ? {
        applicationRouting: {
          foregroundAgentNames: /^(notebook|wrapper)-/.test(mode) ? undefined : 'Checker',
          agents: /^(notebook|wrapper)-/.test(mode) ? [] : [definition],
          beforeConnect: async (phiSessionId) => {
            if (mode === 'selection-stale')
              updateSessionManifest(phiSessionId, { title: 'Changed during remote selection' })
            if (mode === 'selection-abort') {
              selectionStarted!()
              await new Promise<void>((resolve) => {
                releaseSelection = resolve
              })
            }
          },
          onChildApprovalEvent(event: RpcApprovalEvent, parent: SessionRun) {
            childEvents.push(event)
            childParents.push(parent)
          }
        }
      }
    : {}),
  providerFactory: mode.startsWith('parallel-')
    ? async () => {
        parallelProvider = await startParallelChildProvider()
        return parallelProvider
      }
    : undefined,
  select: (selected) => {
    if (mode === 'disabled') return selected
    const base = {
      ...selected,
      ...(mode === 'profile' ? { nativeTools: ['read', 'write', 'bash'] as const } : {}),
      ...(mode === 'host-stop' ? { desktopToolNames: ['notebook.save'] } : {}),
      foregroundChildren: {
        ...(mode === 'unnamed-fg-batch'
          ? {
              allowParallel: true,
              onChildChange(snapshot: Readonly<RpcChildRunSnapshot>) {
                batchChildren.set(snapshot.id, snapshot)
              }
            }
          : {}),
        onApprovalEvent(event: RpcApprovalEvent, parent: SessionRun) {
          childEvents.push(event)
          childParents.push(parent)
        },
        definitions: [{ ...definition, tools: mode === 'profile' ? ['edit'] : definition.tools }]
      }
    }
    if (mode !== 'missing-config' && mode !== 'wrong-config') return base
    const openStdio = selected.session.openStdio!
    return {
      ...base,
      session: {
        ...selected.session,
        async openStdio(command) {
          if (command.includes(' env -i PATH=') && command.includes("'--mode' 'rpc'"))
            for (const nonce of await readdir(join(selected.runtime.runtimeRoot, 'rpc-sessions'))) {
              const path = join(
                selected.runtime.runtimeRoot,
                'rpc-sessions',
                nonce,
                'child-runtime.json'
              )
              if (mode === 'missing-config') await rm(path)
              else {
                const value = JSON.parse(await readFile(path, 'utf8'))
                value.generation++
                await writeFile(path, JSON.stringify(value), { mode: 0o600 })
              }
            }
          return openStdio(command)
        }
      }
    }
  }
})
let primaryFailed = false
let cleanupFailure: unknown
let restoreJournal: (() => Promise<void>) | undefined
let held: ReturnType<typeof holdChildCancellationAck> | undefined
try {
  const events = childEvents,
    requests: Readonly<ToolApprovalRequest>[] = []
  let decide: ((decision: 'approved' | 'denied' | 'cancelled') => void) | undefined
  f.configureApproval({
    shouldGate: () => true,
    requestToolApproval: (request) => {
      requests.push(request)
      return new Promise((resolve) => {
        decide = resolve
      })
    },
    onEvent: (event) => {
      mainEvents.push(event)
    }
  })
  let id = 'actual-child-facade'
  if (mode.startsWith('wrapper-')) {
    await runApplicationWrapperScenario(f, mode)
  } else if (mode.startsWith('notebook-')) {
    await runApplicationNotebookScenario(f, mode)
  } else if (mode === 'selection-stale') {
    await assert.rejects(f.createApplicationSession(), /远程选择期间会话或项目策略已改变/)
    assert.equal(f.channels.length, 0)
    assert.equal(f.provider.requests.length, 0)
    assert.equal(findPhiSessionById(f.phi.sessionId)!.runtimeRef, undefined)
  } else if (mode === 'selection-abort') {
    const pending = f.engine.sessions.create(f.params(id))
    void pending.catch(() => undefined)
    await selectionReached
    const stopping = f.engine.sessions.dispose({ sessionId: id })
    releaseSelection!()
    await assert.rejects(pending)
    await stopping
    assert.equal(f.channels.length, 0)
    assert.equal(f.provider.requests.length, 0)
    assert.equal(findPhiSessionById(f.phi.sessionId)!.runtimeRef, undefined)
  } else if (mode === 'host-stop') {
    await runForegroundHostStop(f)
  } else if (mode === 'reentrant-close') {
    await runReentrantChildClose(f)
  } else if (mode === 'two-child') {
    await runTwoPendingChildren(f, childEvents, childParents)
  } else if (mode === 'unnamed-fg-batch') {
    await runUnnamedForegroundBatch(f, childEvents, childParents, batchChildren)
  } else if (mode === 'delayed-started') {
    await runDelayedChildStarted(f)
  } else if (mode.startsWith('parallel-')) {
    await runParallelChildStop(f, parallelProvider!, mode)
  } else if (['profile', 'missing-config', 'wrong-config'].includes(mode)) {
    await assert.rejects(f.engine.sessions.create(f.params(id)))
    assert.equal(f.engine.sessions.has(id), false)
    assert.equal(f.provider.requests.length, 0)
    assert.equal(requests.length, 0)
    console.log('enabled invalid child configuration failed startup before model/tool')
  } else if (mode === 'disabled') {
    await f.engine.sessions.create(f.params(id))
    f.provider.enqueue({ text: 'normal default path without child capability' })
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: async () => {
        await f.engine.sessions.prompt({ sessionId: id, text: 'One ordinary turn' })
      }
    })
    await run.done
    assert.equal(run.outcome, 'completed')
    const body = JSON.stringify(f.provider.requests[0].tools)
    assert.equal(body.includes('"name":"task"'), false)
    assert.equal(f.provider.requests.length, 1)
  } else {
    const publicEvents: unknown[] = [],
      publicStates: unknown[] = []

    if (applicationRouting) {
      await assert.rejects(
        f.engine.sessions.create({ ...f.params('renderer-spoof'), phiAgents: [definition] }),
        /child\/context configuration/
      )
      assert.equal(f.provider.requests.length, 0)
    }
    if (applicationRouting) {
      const created = await f.createApplicationSession()
      id = created.session.runtimeSessionId
    } else await f.engine.sessions.create(f.params(id))
    f.engine.events.onSessionEvent(id, (event) => publicEvents.push(event))
    f.engine.events.onSessionState(id, (state) => publicStates.push(state))
    assert.equal(f.provider.requests.length, 0)
    const directories = await f.privateDirectories()
    assert.equal(directories.length, 1)
    const config: RpcChildRuntimeConfig = JSON.parse(
      await readFile(join(directories[0], 'child-runtime.json'), 'utf8')
    )
    assert.equal(config.profiles.length, applicationRouting ? 2 : 1)
    assert.ok(config.profiles.every((profile) => profile.definition.phiName === 'Checker'))
    const foreground = config.profiles.filter((profile) => profile.definition.blocking)
    assert.equal(foreground.length, 1)
    assert.equal(
      config.profiles.filter((profile) => !profile.definition.blocking).length,
      applicationRouting ? 1 : 0
    )
    if (applicationRouting) {
      assert.equal(config.policy.allowBackground, true)
      assert.equal(config.policy.allowParallel, true)
    }
    const nativeName = foreground[0].definition.nativeName
    const path = join(f.f.scope.projectRoot, 'approved-child.txt')
    f.provider.enqueue(
      {
        tool: {
          name: 'task',
          id: 'actual-root-task',
          args: {
            i: 'Delegate the actual foreground check',
            agent: nativeName,
            name: 'bounded-child',
            task: 'Write approved-child.txt',
            solutionSpace: 'Private local fixture'
          }
        }
      },
      {
        tool:
          mode === 'bash-stop'
            ? {
                name: 'bash',
                id: 'actual-child-bash',
                args: {
                  command: `printf STARTED > '${path}'; sleep 30; printf UNEXPECTED > '${path}.after'`
                }
              }
            : {
                name: 'write',
                id: 'actual-child-write',
                args: { path, content: 'written by actual native child' }
              }
      },
      ...(mode === 'held-ack' ? [] : [{ text: 'child finished' }, { text: 'parent finished' }])
    )
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: async () => {
        await f.engine.sessions.prompt({
          sessionId: id,
          text: 'Run one explicitly authorized foreground task'
        })
      }
    })
    const started = Date.now()
    while (!decide) {
      if (run.outcome) throw new Error(`Actual task ended before child approval: ${run.outcome}`)
      assert.ok(Date.now() - started < 15000, 'actual child approval did not arrive')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(await f.exists(path), false)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].sessionId, f.phi.sessionId)
    assert.notEqual(requests[0].runId, run.runId)
    assert.equal(requests[0].agentRunId, requests[0].runId)
    assert.equal(run.status, 'needs_approval')
    assert.equal(findPhiSessionById(f.phi.sessionId)!.status, 'needs_approval')
    const requested = readSessionEvents(f.phi.sessionId).filter(
      (event) => event.type === 'approval_requested'
    )
    assert.equal(requested.length, 1)
    assert.equal(requested[0].runId, requests[0].agentRunId)
    assert.equal(requested[0].parentRunId, run.runId)
    assert.equal(childParents[0], run)
    assert.equal(mainEvents.length, 0)
    if (mode === 'storage-failure') {
      const journal = join(f.phi.dir, 'messages.jsonl'),
        backup = journal + '.before-failure'
      await rename(journal, backup)
      await mkdir(journal, { mode: 0o700 })
      restoreJournal = async () => {
        await rm(journal, { recursive: true, force: true })
        await rename(backup, journal)
      }
      decide('approved')
      await assert.rejects(run.done)
      assert.equal(run.outcome, 'failed')
      assert.equal(f.engine.sessions.has(id), false)
      await restoreJournal()
      restoreJournal = undefined
      const recorded = readSessionEvents(f.phi.sessionId).filter((event) =>
        event.type.startsWith('approval_')
      )
      assert.equal(recorded.length, 1)
      assert.equal(recorded[0].type, 'approval_requested')
      assert.equal(recorded[0].runId, requests[0].agentRunId)
      // The permission reply was physically committed before terminal persistence failed.
      // A native effect may already exist; interruption must not claim it never happened.
      assert.equal(await f.exists(join(directories[0], 'child-runtime.json')), false)
      console.log(
        'actual post-commit child approval storage failure surfaced and retired the generation'
      )
    } else if (mode === 'held-ack') {
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
      const peerParams = f.params('peer-child-facade')
      peerParams.remoteProject = { ...peerParams.remoteProject!, phiSessionId: peer.sessionId }
      await f.engine.sessions.create(peerParams)
      f.provider.enqueue({ text: 'peer remains streaming', hold: true })
      const peerRun = f.runners.startRun({
        sessionId: peer.sessionId,
        runId: createRunId(),
        execute: async () => {
          await f.engine.sessions.prompt({
            sessionId: peerParams.sessionId,
            text: 'Keep peer streaming independently'
          })
        }
      })
      while (f.provider.requests.length < 3) await new Promise((resolve) => setTimeout(resolve, 10))
      const before = f.provider.requests.length
      f.provider.enqueue({ text: 'unexpected parent request during child ACK hold', hold: true })
      held = holdChildCancellationAck()
      f.runners.stopRun(f.phi.sessionId)
      const stopped = f.engine.sessions.abort({ sessionId: id })
      void stopped.catch(() => undefined)
      await Promise.race([
        held.acknowledged,
        stopped.then(() => {
          throw new Error('parent stop finished before official child ACK')
        })
      ])
      assert.equal(held.evidence.cancelled, true)
      assert.equal(held.evidence.parentAbortCalls, 0)
      decide('approved')
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(await f.exists(path), false)
      assert.equal(
        f.provider.requests.length,
        before,
        'stopped parent made a provider request while child ACK was held'
      )
      assert.equal(peerRun.signal.aborted, false)
      assert.equal(f.engine.sessions.has(peerParams.sessionId), true)
      held.release()
      await stopped
      await run.done
      assert.equal(run.outcome, 'stopped')
      assert.equal(peerRun.signal.aborted, false)
      await f.engine.sessions.abort({ sessionId: peerParams.sessionId })
      await peerRun.done
      assert.equal(peerRun.outcome, 'stopped')
      held.restore()
      held = undefined
    } else if (mode === 'denied') {
      decide('denied')
      await run.done
      assert.equal(run.outcome, 'failed')
      assert.equal(await f.exists(path), false)
      assert.deepEqual(
        events.map((event) => event.type),
        ['approval_requested', 'approval_denied']
      )
    } else if (mode === 'pending-stop' || mode === 'bash-stop') {
      if (mode === 'bash-stop') {
        decide('approved')
        const began = Date.now()
        while (!(await f.exists(path))) {
          assert.ok(Date.now() - began < 5000, 'approved bash did not start')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      f.runners.stopRun(f.phi.sessionId)
      assert.equal(run.signal.aborted, true)
      await f.engine.sessions.abort({ sessionId: id })
      await run.done
      assert.equal(run.outcome, 'stopped')
      decide('approved')
      assert.equal(await f.exists(mode === 'bash-stop' ? path + '.after' : path), false)
      assert.deepEqual(
        events.map((event) => event.type),
        ['approval_requested', mode === 'bash-stop' ? 'approval_approved' : 'approval_cancelled']
      )
    } else {
      decide('approved')
      await run.done
      assert.equal(run.outcome, 'completed')
      assert.equal(await readFile(path, 'utf8'), 'written by actual native child')
      assert.deepEqual(
        events.map((event) => event.type),
        ['approval_requested', 'approval_approved']
      )
      assert.equal(f.provider.requests.length, 4)
    }
    if (mode !== 'storage-failure') {
      assert.equal(f.engine.sessions.has(id), true)
      if (mode === 'approved') {
        f.provider.enqueue({ text: 'next real parent turn' })
        const next = f.runners.startRun({
          sessionId: f.phi.sessionId,
          runId: createRunId(),
          execute: async () => {
            await f.engine.sessions.prompt({
              sessionId: id,
              text: 'Continue the parent with no child'
            })
          }
        })
        await next.done
        assert.equal(next.outcome, 'completed')
        assert.equal(f.provider.requests.length, 5)
      }
      if (mode === 'repeat-child') {
        const path2 = path + '.second'
        decide = undefined
        f.provider.enqueue(
          {
            tool: {
              name: 'task',
              id: 'actual-root-task',
              args: {
                i: 'Next authorized foreground check',
                agent: nativeName,
                name: 'bounded-child',
                task: 'Write the second independent file',
                solutionSpace: 'Private local fixture'
              }
            }
          },
          {
            tool: {
              name: 'write',
              id: 'actual-child-write',
              args: { path: path2, content: 'second real child turn' }
            }
          },
          { text: 'second child finished' },
          { text: 'second parent finished' }
        )
        const next = f.runners.startRun({
          sessionId: f.phi.sessionId,
          runId: createRunId(),
          execute: async () => {
            await f.engine.sessions.prompt({
              sessionId: id,
              text: 'Delegate again from the next real Phi run'
            })
          }
        })
        const started = Date.now()
        while (!decide) {
          if (next.outcome) throw new Error('Second actual child ended before approval')
          assert.ok(Date.now() - started < 15000)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        assert.equal(await f.exists(path2), false)
        assert.equal(requests.length, 2)
        assert.equal(
          typeof requests[1].agentRunId,
          'string',
          'second approval must belong to an actual child, never a root fallback writer'
        )
        assert.notEqual(requests[1].runId, next.runId)
        assert.notEqual(requests[1].agentRunId, requests[0].agentRunId)
        const approve: (decision: 'approved') => void = decide
        approve('approved')
        await next.done
        assert.equal(next.outcome, 'completed')
        assert.equal(await readFile(path2, 'utf8'), 'second real child turn')
        assert.equal(f.provider.requests.length, 8)
      }
      const durable = readSessionEvents(f.phi.sessionId).filter((event) =>
        event.type.startsWith('approval_')
      )
      assert.deepEqual(
        durable.map((event) => event.type),
        events.map((event) => event.type)
      )
      for (const event of durable) {
        const emitted = events.find((candidate) => candidate.approvalId === event.approvalId)!
        assert.equal(event.runId, emitted.runId)
        assert.equal(event.agentRunId, emitted.runId)
        assert.equal(event.toolCallId, emitted.toolCallId)
        assert.equal(event.cwd, f.f.scope.projectRoot)
      }
      const runtimeConfig = JSON.parse(await readFile(join(directories[0], 'runtime.json'), 'utf8'))
      const reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
      const journal = await readFile(
        join(runtimeConfig.journals, reference.journalBasename),
        'utf8'
      )
      for (const secret of [
        config.capability,
        runtimeConfig.execution.capability,
        runtimeConfig.result.capability,
        'synthetic-facade-regression-key'
      ]) {
        assert.ok(typeof secret === 'string' && secret.length > 20)
        for (const surface of [
          JSON.stringify(publicEvents),
          JSON.stringify(publicStates),
          JSON.stringify(f.provider.requests),
          JSON.stringify(readSessionEvents(f.phi.sessionId)),
          journal
        ])
          assert.equal(
            surface.includes(secret),
            false,
            'private capability or credential escaped its boundary'
          )
      }
      assert.equal(JSON.stringify(publicEvents).includes('host_uri_request'), false)
      assert.equal(JSON.stringify(publicEvents).includes('phi-child:'), false)
      if (mode === 'approved') {
        const before = f.provider.requests.length
        await f.engine.sessions.dispose({ sessionId: id })
        assert.equal(f.engine.sessions.has(id), false)
        f.resume()
        let resumed = 'fresh-child-facade'
        if (applicationRouting)
          resumed = (await f.createApplicationSession()).session.runtimeSessionId
        else await f.engine.sessions.create(f.params(resumed))
        const restored = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
        assert.equal(restored.ompSessionId, reference.ompSessionId)
        assert.equal(restored.journalBasename, reference.journalBasename)
        assert.equal(
          f.provider.requests.length,
          before,
          'fresh generation must not replay/auto-wake a child or parent model'
        )
        assert.equal(f.engine.sessions.has(resumed), true)
        assert.equal((await f.privateDirectories()).length, 1)
      }
      console.log('actual facade foreground task/child write/UI approval/normal terminal passed')
    }
  }
} catch (error) {
  primaryFailed = true
  throw error
} finally {
  try {
    await restoreJournal?.()
  } catch (error) {
    cleanupFailure = error
  }
  held?.release()
  held?.restore()
  try {
    await f.close()
  } catch (error) {
    cleanupFailure ??= error
  }
}
if (!primaryFailed && cleanupFailure) throw cleanupFailure
