import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { facadeRoutingRegressionFixture } from './facadeRoutingRegressionFixture'
import { createRuntimeAgentSession } from '../../src/main/agent/runtime/runtime-adapter'
import {
  createRunId,
  findPhiSessionById,
  getSessionDir,
  readSessionEvents
} from '../../src/main/agent/session/session-store'
import { ownsRemoteRuntimeSession } from '../../src/main/agent/engine/in-process-engine'
import { remoteOmpJournalPath } from '../../src/main/agent/session/runtime-reference'

const mode = process.env.PHI_FACADE_REGRESSION_MODE!
const f = await facadeRoutingRegressionFixture()
const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  const start = Date.now()
  while (!(await predicate())) {
    assert.ok(Date.now() - start < 5000, 'bounded test observation did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const createProxy = async (): Promise<
  Awaited<ReturnType<typeof createRuntimeAgentSession>>['session']
> => {
  const params = f.params('unused')
  return (
    await createRuntimeAgentSession({
      cwd: params.cwd,
      agentDir: params.agentDir,
      model: params.model,
      thinkingLevel: params.thinkingLevel,
      projectBound: true,
      remoteProject: params.remoteProject
    })
  ).session
}
let failed = false,
  cleanupFailed = false
let cleanupError: unknown
try {
  if (mode === 'model-policy') {
    const snapshot = f.engine.models.snapshot.bind(f.engine.models)
    let lookups = 0
    f.engine.models.snapshot = async (params) => {
      lookups++
      return snapshot(params)
    }
    let failure: unknown
    try {
      await f.engine.sessions.create(f.params('mismatched-model', 'model-b'))
    } catch (error) {
      failure = error
    }
    const manifest = findPhiSessionById(f.phi.sessionId)!
    process.stdout.write(
      JSON.stringify({
        mode,
        rejected: !!failure,
        modelLookups: lookups,
        leases: f.leases.length,
        savedModel: manifest.model,
        adopted: !!manifest.runtimeRef,
        providerRequests: f.provider.requests.length
      }) + '\n'
    )
    assert.ok(failure, 'fresh model B must not be admitted while Phi saved model A')
    assert.equal(lookups, 0, 'reject before model-registry/provider/deployment awaits')
    assert.equal(f.leases.length, 0)
    assert.equal(f.channels.length, 0)
    assert.equal(manifest.runtimeRef, undefined)
    assert.deepEqual(manifest.model, {
      providerId: f.model('model-a').provider,
      modelId: 'model-a'
    })
    assert.equal(f.provider.requests.length, 0)
  } else if (mode === 'provider-retry') {
    const session = await createProxy()
    const publicRetry: unknown[] = []
    const detach = f.engine.events.onSessionEvent(session.runtimeSessionId, (event) => {
      if (event.type === 'auto_retry_start' || event.type === 'auto_retry_end')
        publicRetry.push(event)
    })
    // Pinned OpenAI-compatible finish_reason:error is a documented session
    // retry trigger. Commit thinking-only content: the transport marks it as
    // emitted while session replay safety explicitly allows thinking-only retries.
    f.provider.enqueueStreamError('synthetic thinking-only partial before provider failure')
    f.provider.enqueue('recovered actual retry')
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => session.prompt('ordinary provider retry')
    })
    await run.done
    process.stdout.write(
      JSON.stringify({
        mode,
        outcome: run.outcome,
        providerRequests: f.provider.requests.length,
        rawRetryTypes: f.rawRetryEvents.map((event) => event.type),
        publicRetryCount: publicRetry.length
      }) + '\n'
    )
    assert.equal(run.outcome, 'completed', JSON.stringify(readSessionEvents(f.phi.sessionId)))
    assert.ok(
      f.rawRetryEvents.some((event) => event.type === 'auto_retry_start'),
      'real SDK retry start was observed'
    )
    assert.ok(
      f.rawRetryEvents.some((event) => event.type === 'auto_retry_end'),
      'real SDK retry end was observed'
    )
    assert.equal(
      publicRetry.length,
      f.rawRetryEvents.length,
      'actual default retry events must reach public consumers'
    )
    assert.ok(
      session.messages.some((value) => JSON.stringify(value).includes('recovered actual retry'))
    )
    detach()
    await session.dispose()
  } else {
    const old = await createProxy()
    f.provider.enqueue('durable generation A')
    const seed = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => old.prompt('first genuine submission')
    })
    await seed.done
    assert.equal(seed.outcome, 'completed', JSON.stringify(readSessionEvents(f.phi.sessionId)))
    const original = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
    const oldPrivate = (await f.privateDirectories())[0]
    if (mode === 'damaged-reference') {
      await old.dispose()
      const manifestPath = join(getSessionDir(f.phi.sessionId), 'manifest.json')
      const document = JSON.parse(await readFile(manifestPath, 'utf8'))
      const serverJournal = remoteOmpJournalPath(original)
      const journalBytes = await readFile(serverJournal, 'utf8')
      const legacyPath = join(process.env.HOME!, 'damaged-legacy-server-journal.jsonl')
      await writeFile(legacyPath, journalBytes, { mode: 0o600 })
      const blockedPaths = new Set([serverJournal, legacyPath])
      const request = f.bridge.request.bind(f.bridge)
      let remoteDesktopDelegates = 0,
        localDelegates = 0
      // Observe actual legacy delegation while preventing desktop mutation of
      // the loopback server journal. Valid local IO still calls the real worker.
      f.bridge.request = async <T>(method: string, params?: unknown): Promise<T> => {
        const path =
          params && typeof params === 'object' && 'path' in params ? params.path : undefined
        if (['sessions.open', 'sessions.rename'].includes(method)) {
          if (typeof path === 'string' && blockedPaths.has(path)) {
            remoteDesktopDelegates++
            throw new Error('TEST_BLOCKED_DESKTOP_REMOTE_JOURNAL_IO')
          }
          localDelegates++
        }
        return request<T>(method, params)
      }
      f.disableRouting()
      const variants = [
        { ref: { ...document.runtimeRef, version: 99 }, path: serverJournal },
        { ref: { ...document.runtimeRef, bindingHash: 'c'.repeat(64) }, path: serverJournal },
        { ref: { ...document.runtimeRef, unknownReferenceField: true }, path: serverJournal },
        { ref: { ...document.runtimeRef, version: 99 }, path: legacyPath, legacy: true }
      ]
      for (const variant of variants) {
        const damagedDocument = {
          ...document,
          runtimeRef: variant.ref,
          ...(variant.legacy ? { runtimeSessionPath: legacyPath } : {})
        }
        await writeFile(manifestPath, JSON.stringify(damagedDocument), { mode: 0o600 })
        const damaged = findPhiSessionById(f.phi.sessionId)!
        assert.equal(damaged.runtimeRef, undefined)
        assert.equal(damaged.runtimeRecoveryError?.code, 'INVALID_RUNTIME_REFERENCE')
        await f.engine.history
          .open({ agentDir: f.params('unused').agentDir, path: variant.path })
          .catch(() => undefined)
        await f.engine.history
          .rename({
            agentDir: f.params('unused').agentDir,
            path: variant.path,
            name: 'must not rename remote on desktop'
          })
          .catch(() => undefined)
        assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).runtimeRef, variant.ref)
        assert.equal(await readFile(variant.path, 'utf8'), journalBytes)
      }
      const localCwd = join(process.env.HOME!, 'real-local-history')
      await mkdir(localCwd)
      const local = await f.engine.sessions.create({
        sessionId: 'real-local',
        cwd: localCwd,
        agentDir: f.params('unused').agentDir,
        model: f.model('model-a'),
        noTools: 'all',
        enableToolApproval: false,
        sessionManager: { kind: 'persistent', cwd: localCwd }
      })
      assert.ok(local.state.sessionFile)
      await f.engine.history.open({
        agentDir: f.params('unused').agentDir,
        path: local.state.sessionFile
      })
      await f.engine.history.rename({
        agentDir: f.params('unused').agentDir,
        path: local.state.sessionFile,
        name: 'genuine local history remains usable'
      })
      assert.equal(localDelegates, 2)
      assert.deepEqual(
        JSON.parse(await readFile(manifestPath, 'utf8')).runtimeRef,
        variants.at(-1)!.ref
      )
      process.stdout.write(
        JSON.stringify({
          mode,
          remoteDesktopDelegates,
          localDelegates,
          malformedRefPreserved: true
        }) + '\n'
      )
      assert.equal(
        remoteDesktopDelegates,
        0,
        'malformed private reference must deny desktop legacy delegation'
      )
    } else if (mode === 'disconnect-dispose-resume') {
      assert.equal(f.channels.length, 1, 'exact actual mode-rpc CLI channel captured')
      const priorHistory = structuredClone(old.messages)
      const providerRequests = f.provider.requests.length
      const failedRunId = createRunId()
      f.f.session.killLatestStdio('SIGKILL')
      await f.channels[0].closed
      const rejected = f.runners.startRun({
        sessionId: f.phi.sessionId,
        runId: failedRunId,
        execute: () => old.prompt('must fail on the disconnected generation')
      })
      await rejected.done
      assert.equal(rejected.outcome, 'failed')
      assert.equal(
        f.provider.requests.length,
        providerRequests,
        'transport loss must not replay or reconnect the rejected prompt'
      )
      const failedEvent = readSessionEvents(f.phi.sessionId).find(
        (event) => event.type === 'run_failed' && event.runId === failedRunId
      )
      assert.ok(failedEvent?.type === 'run_failed')

      await old.dispose()
      const errorMessage = failedEvent.errorMessage
      assert.equal(typeof errorMessage, 'string')
      assert.match(
        typeof errorMessage === 'string' ? errorMessage : '',
        /RPC (?:output stream ended|process exited)|EPIPE|closed/,
        'the failed run must retain its original transport-loss cause'
      )
      await waitFor(async () => !(await f.exists(oldPrivate)))
      await f.leases[0].closed
      await f.tunnels[0].closed

      f.resume()
      const fresh = await createProxy()
      const resumed = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
      assert.equal(resumed.ompSessionId, original.ompSessionId)
      assert.equal(resumed.journalBasename, original.journalBasename)
      assert.deepEqual(fresh.messages, priorHistory)
      assert.equal(
        f.provider.requests.length,
        providerRequests,
        'explicit resume must not invoke the provider'
      )
      assert.equal(f.channels.length, 2, 'explicit resume must launch a fresh RPC generation')

      f.provider.enqueue('explicit request on generation B')
      const current = f.runners.startRun({
        sessionId: f.phi.sessionId,
        runId: createRunId(),
        execute: () => fresh.prompt('new explicit request after transport loss')
      })
      await current.done
      assert.equal(current.outcome, 'completed')
      assert.equal(f.provider.requests.length, providerRequests + 1)
      assert.ok(
        fresh.messages.some((value) =>
          JSON.stringify(value).includes('explicit request on generation B')
        )
      )
      await fresh.dispose()
      await f.leases.at(-1)!.closed
      await f.tunnels.at(-1)!.closed
      assert.equal((await f.privateDirectories()).length, 0)
      assert.equal(await f.exists(remoteOmpJournalPath(original)), true)
      assert.equal(f.f.session.closed, false)
    } else {
      // Actual generation A loses its CLI; the old proxy intentionally remains alive.
      assert.equal(f.channels.length, 1, 'exact actual mode-rpc CLI channel captured')
      await f.channels[0].close()
      await f.channels[0].closed
      await waitFor(async () => !(await f.exists(oldPrivate)))
      await f.leases[0].closed
      await f.tunnels[0].closed
      f.resume()
      const fresh = await createProxy()
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.ompSessionId,
        original.ompSessionId
      )
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
        original.journalBasename
      )
      assert.equal(
        f.provider.requests.length,
        1,
        'fresh generation restore submits no provider request'
      )
      const freshPrivate = (await f.privateDirectories())[0]
      assert.notEqual(freshPrivate, oldPrivate)
      f.provider.enqueue('generation B remains active', true)
      const current = f.runners.startRun({
        sessionId: f.phi.sessionId,
        runId: createRunId(),
        execute: () => fresh.prompt('new generation actual submission')
      })
      await waitFor(() => f.provider.requests.length === 2)
      if (mode === 'old-abort') {
        await old.abort().catch(() => undefined)
        await old.dispose()
      } else {
        await old.dispose()
        await old.abort().catch(() => undefined)
      }
      process.stdout.write(
        JSON.stringify({
          mode,
          freshRunAbortedByOldCleanup: current.signal.aborted,
          freshPresent: f.engine.sessions.has(fresh.runtimeSessionId),
          oldPresent: f.engine.sessions.has(old.runtimeSessionId),
          newPrivateExists: await f.exists(freshPrivate)
        }) + '\n'
      )
      assert.equal(
        current.signal.aborted,
        false,
        'old generation cleanup must not stop the new generation Phi run'
      )
      assert.equal(f.engine.sessions.has(fresh.runtimeSessionId), true)
      assert.equal(await f.exists(freshPrivate), true)
      assert.equal(f.f.session.closed, false)
      f.provider.releaseHeld()
      await current.done
      assert.equal(current.outcome, 'completed')
      const beforeStop = f.provider.requests.length
      f.provider.enqueue('own scoped stop', true)
      const owned = f.runners.startRun({
        sessionId: f.phi.sessionId,
        runId: createRunId(),
        execute: () => fresh.prompt('own stop must remain effective')
      })
      await waitFor(() => f.provider.requests.length > beforeStop)
      await fresh.abort()
      await owned.done
      assert.equal(owned.outcome, 'stopped')
      assert.equal(owned.signal.aborted, true)
      f.provider.enqueue('next turn still works')
      const next = f.runners.startRun({
        sessionId: f.phi.sessionId,
        runId: createRunId(),
        execute: () => fresh.prompt('next explicit submission')
      })
      await next.done
      assert.equal(next.outcome, 'completed')
      assert.ok(
        fresh.messages.some((value) => JSON.stringify(value).includes('next turn still works'))
      )
      const beforeOldPrompt = f.provider.requests.length
      await assert.rejects(old.prompt('must never locally recreate'), /显式恢复原会话/)
      assert.equal(ownsRemoteRuntimeSession(old.runtimeSessionId), true)
      assert.equal(f.provider.requests.length, beforeOldPrompt)
      await fresh.dispose()
      await f.leases.at(-1)!.closed
      await f.tunnels.at(-1)!.closed
      assert.equal(await f.exists(freshPrivate), false)
      assert.equal(await f.exists(remoteOmpJournalPath(original)), true)
      assert.equal(f.f.session.closed, false)
    }
  }
} catch (error) {
  failed = true
  throw error
} finally {
  try {
    await f.close()
  } catch (error) {
    cleanupFailed = true
    cleanupError = error
  }
}
if (cleanupFailed && !failed) throw cleanupError
