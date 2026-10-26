import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { KernelSessionFactory } from '../src/main/agent/engine/kernel-session-factory'
import { SessionRoutingEngine } from '../src/main/agent/engine/session-routing-engine'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import {
  OLD_REMOTE_PROCESS_REASON,
  planKernelHistory,
  readKernelOwner,
  type KernelHistoryPlan,
  type RemoteHistoryProbeResult
} from '../src/main/agent/engine/kernel-history'
import {
  createPhiSession,
  deletePhiSession,
  findPhiSessionById
} from '../src/main/agent/session/session-store'
import { writeManifestFile } from '../src/main/agent/session/manifest-file'
import {
  remoteOmpDurableSessionKey,
  type RemoteOmpRuntimeRef,
  type RemoteOmpScope
} from '../src/main/agent/session/runtime-reference'
import type { JsonValue } from '../src/shared/kernel-protocol'
import { FakeKernelClient, legacyEngine, params } from './helpers/kernelSessionFactoryFake'

type LocalSample = 'plain' | 'compacted' | 'tool-subtask' | 'invalid-model' | 'plan-interrupted'

function writeCurrentHistorySamples(
  samples: ReadonlyArray<{ kind: LocalSample; path: string; cwd: string }>,
  agentDir: string
): void {
  const script = `
    import { makeSessionManager } from './src/main/agent/engine/in-process/session-factory'
    const samples = JSON.parse(process.env.PHI_HISTORY_SAMPLES)
    for (const sample of samples) {
      const manager = await makeSessionManager(
        { kind: 'persistent', path: sample.path },
        sample.cwd,
        process.env.PI_CODING_AGENT_DIR
      )
      const first = manager.appendMessage({ role: 'user', content: 'historic ' + sample.kind, timestamp: Date.now() })
      if (sample.kind === 'compacted') {
        manager.appendCompaction('historic compacted summary', undefined, first, 321, { tokensAfter: 42 })
      }
      if (sample.kind === 'tool-subtask') {
        manager.appendMessage({
          role: 'toolResult', toolCallId: 'historic-tool', toolName: 'read',
          content: [{ type: 'text', text: 'historic tool result' }], isError: false,
          timestamp: Date.now()
        })
        manager.appendCustomEntry('phi.agent-run', { runId: 'historic-child', state: 'done' })
      }
      if (sample.kind === 'plan-interrupted') {
        manager.appendModeChange('plan_execute', { phase: 'executing' })
        manager.appendCustomEntry('phi.plan-execution', {
          state: 'interrupted', completedSteps: ['inspect'], pendingSteps: ['apply']
        })
      }
      await manager.close()
    }
  `
  execFileSync(resolveBunExecutable(), ['-e', script], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PHI_HISTORY_SAMPLES: JSON.stringify(samples)
    },
    stdio: ['ignore', 'ignore', 'inherit']
  })
}

class AdoptingKernelClient extends FakeKernelClient {
  readonly adopted = new Map<string, { journal: string; backup: string; migration: string }>()

  constructor(private readonly agentDir: string) {
    super()
  }

  override request(
    method: string,
    wireParams: JsonValue,
    context: { sessionId?: string; runId?: string } = {}
  ): Promise<JsonValue> {
    if (method !== 'session.adopt') return super.request(method, wireParams, context)
    this.requests.push({ method, params: wireParams, context })
    const value = wireParams as {
      source: { path: string; phiSessionId: string }
      model?: { provider?: string; id?: string }
    }
    const source = readFileSync(value.source.path)
    const sourceSha256 = createHash('sha256').update(source).digest('hex')
    const sessionId = `adopted-${value.source.phiSessionId}`
    const directory = join(this.agentDir, 'phi-kernel', 'sessions', sessionId)
    mkdirSync(directory, { recursive: true })
    const journal = join(directory, 'journal.jsonl')
    const backup = join(directory, 'source-backup.jsonl')
    const migration = join(directory, 'migration.json')
    copyFileSync(value.source.path, journal)
    copyFileSync(value.source.path, backup)
    writeFileSync(
      migration,
      JSON.stringify({
        schemaVersion: 1,
        state: 'complete',
        source: { phiSessionId: value.source.phiSessionId, sha256: sourceSha256 }
      })
    )
    this.adopted.set(value.source.phiSessionId, { journal, backup, migration })
    return Promise.resolve({
      sessionId,
      migration: { state: 'complete', sourceSha256 }
    })
  }
}

test('A19 desktop route adopts all current history shapes, preserves originals and continues', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-k4-a19-local-'))
  const cwd = join(root, 'project')
  const sourceRoot = join(root, 'history-copies')
  const agentDir = process.env.PI_CODING_AGENT_DIR!
  mkdirSync(cwd, { recursive: true })
  mkdirSync(sourceRoot, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const kinds: LocalSample[] = [
    'plain',
    'compacted',
    'tool-subtask',
    'invalid-model',
    'plan-interrupted'
  ]
  const samples = kinds.map((kind) => ({ kind, path: join(sourceRoot, `${kind}.jsonl`), cwd }))
  writeCurrentHistorySamples(samples, agentDir)

  const client = new AdoptingKernelClient(agentDir)
  const factory = new KernelSessionFactory({
    mode: 'local',
    launchLocal: async () => ({
      client,
      greeting: {
        protocol: { major: 1, minor: 0 },
        kernel: { version: '0.1.0', ompVersion: '18.10.3' },
        kernelInstanceId: 'candidate-history-kernel',
        controllerGeneration: 1,
        capabilities: ['session.adopt'],
        lastSeq: 0,
        runtime: { home: join(root, 'home'), agentDir }
      },
      close: async () => undefined
    })
  })
  const engine = new SessionRoutingEngine(legacyEngine(), () => factory)
  const createdIds: string[] = []
  t.after(async () => {
    await engine.stop().catch(() => undefined)
    for (const id of createdIds) deletePhiSession(id)
  })

  for (const sample of samples) {
    const phi = createPhiSession({
      kind: 'ordinary',
      cwd,
      cwdRealPath: cwd,
      permissionMode: 'auto',
      model:
        sample.kind === 'invalid-model'
          ? { providerId: 'removed-provider', modelId: 'removed-model' }
          : { providerId: 'test', modelId: 'model' }
    })
    createdIds.push(phi.sessionId)
    writeManifestFile(phi.dir, {
      ...phi.manifest,
      runtimeSessionPath: sample.path,
      ...(sample.kind === 'plan-interrupted'
        ? {
            status: 'idle',
            lastRunOutcome: 'interrupted',
            currentRunId: undefined
          }
        : {})
    })
    const before = readFileSync(sample.path)
    const create = params(`runtime-${sample.kind}`)
    create.agentDir = agentDir
    create.cwd = cwd
    create.phiSessionId = phi.sessionId
    create.sessionManager = {
      kind: 'open',
      cwd,
      path: `phi-session:${phi.sessionId}`
    }
    const result = await engine.sessions.create(create)
    assert.equal(result.sessionId, create.sessionId)
    await engine.sessions.prompt({ sessionId: create.sessionId, text: 'continue adopted history' })

    const adopted = client.adopted.get(phi.sessionId)
    assert.ok(adopted, sample.kind)
    assert.deepEqual(readFileSync(sample.path), before, `${sample.kind} original journal`)
    assert.deepEqual(readFileSync(adopted.backup), before, `${sample.kind} source backup`)
    assert.equal(
      JSON.parse(readFileSync(adopted.migration, 'utf8')).source.phiSessionId,
      phi.sessionId
    )
    assert.equal(
      findPhiSessionById(phi.sessionId)?.kernelRuntimeRef?.kernelSessionId,
      `adopted-${phi.sessionId}`
    )
    assert.equal(
      (await readKernelOwner(phi.dir))?.sourceSha256,
      createHash('sha256').update(before).digest('hex')
    )
    await engine.sessions.dispose({ sessionId: create.sessionId })
  }

  const invalidAdopt = client.requests.find(
    (request) =>
      request.method === 'session.adopt' &&
      (request.params as { source?: { phiSessionId?: string } }).source?.phiSessionId ===
        createdIds[3]
  )
  assert.deepEqual((invalidAdopt?.params as { model?: unknown }).model, {
    provider: 'test',
    id: 'model'
  })
})

test('A19 desktop route maps all RPC-era samples to adoption or reasoned read-only state', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-k4-a19-remote-'))
  const desktopAgentDir = process.env.PI_CODING_AGENT_DIR!
  const remoteAgentDir = join(root, 'remote-agent')
  const projectRoot = '/srv/candidate-project'
  const localAnchor = join(root, 'project-anchor')
  const sourceRoot = join(root, 'remote-copies')
  mkdirSync(remoteAgentDir, { recursive: true })
  mkdirSync(localAnchor, { recursive: true })
  mkdirSync(sourceRoot, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const scope: RemoteOmpScope = {
    hostProfileId: 'ssh-config:candidate',
    bindingHash: 'a'.repeat(64),
    projectId: 'candidate-project',
    projectRoot,
    runtimeRoot: '/srv/phi-runtime'
  }
  const location = {
    kind: 'ssh' as const,
    hostProfileId: scope.hostProfileId,
    remoteRoot: projectRoot,
    canonicalRoot: projectRoot
  }
  const plans = new Map<string, KernelHistoryPlan>()
  const client = new AdoptingKernelClient(remoteAgentDir)
  const factory = new KernelSessionFactory({
    mode: 'remote',
    launchRemote: async () => ({
      client,
      greeting: {
        protocol: { major: 1, minor: 0 },
        kernel: { version: '0.1.0', ompVersion: '18.10.3' },
        kernelInstanceId: 'candidate-remote-history',
        controllerGeneration: 1,
        capabilities: ['session.adopt'],
        lastSeq: 0,
        runtime: { home: join(root, 'remote-home'), agentDir: remoteAgentDir }
      },
      runtimeRoot: scope.runtimeRoot,
      planHistory: async (candidate) => {
        const plan = plans.get(candidate.remoteProject!.phiSessionId)
        if (!plan) throw new Error('Candidate history plan is missing')
        return plan
      },
      close: async () => undefined
    })
  })
  const engine = new SessionRoutingEngine(legacyEngine(), () => factory)
  const createdIds: string[] = []
  t.after(async () => {
    await engine.stop().catch(() => undefined)
    for (const id of createdIds) deletePhiSession(id)
  })

  const outcomes = new Map<string, { action: string; reason: string; status: string }>()
  for (const kind of ['normal-end', 'interrupted', 'run-lock-residue', 'recovery-error'] as const) {
    const phi = createPhiSession({
      kind: 'project',
      projectId: scope.projectId,
      projectLocation: location,
      cwd: localAnchor,
      cwdRealPath: localAnchor,
      remoteRuntime: 'rpc',
      permissionMode: 'ask',
      model: { providerId: 'test', modelId: 'model' }
    })
    createdIds.push(phi.sessionId)
    const ref: RemoteOmpRuntimeRef = {
      kind: 'remote-omp',
      version: 1,
      ...scope,
      durableSessionKey: remoteOmpDurableSessionKey(scope, phi.sessionId),
      ompSessionId: `omp-${kind}`,
      journalBasename: `${kind}.jsonl`,
      ompVersion: '18.10.3'
    }
    if (kind === 'recovery-error') {
      const manifest = {
        ...phi.manifest,
        runtimeRecoveryError: {
          code: 'INVALID_RUNTIME_REFERENCE' as const,
          message: 'saved RPC recovery metadata is invalid'
        }
      }
      plans.set(phi.sessionId, planKernelHistory({ manifest }))
    } else {
      const source = join(sourceRoot, `${kind}.jsonl`)
      writeFileSync(source, `rpc history ${kind}\n`)
      const manifest = {
        ...phi.manifest,
        runtimeRef: ref,
        ...(kind === 'interrupted' || kind === 'run-lock-residue'
          ? {
              status: 'running' as const,
              currentRunId: `run-${kind}`,
              lastRunOutcome: 'interrupted' as const
            }
          : {})
      }
      writeManifestFile(phi.dir, manifest)
      const probe: RemoteHistoryProbeResult = {
        identity: {
          ...scope,
          phiSessionId: phi.sessionId,
          durableSessionKey: ref.durableSessionKey,
          ompSessionId: ref.ompSessionId,
          journalBasename: ref.journalBasename
        },
        sourcePath: source,
        sourceSize: readFileSync(source).byteLength,
        sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
        sourceOmpSessionId: ref.ompSessionId,
        sourceCwd: projectRoot,
        writer: 'gone',
        runLock: kind === 'run-lock-residue' ? 'held' : 'gone',
        diagnostics: { sample: kind }
      }
      plans.set(
        phi.sessionId,
        planKernelHistory({ manifest, expectedRemoteScope: scope, remoteProbe: probe })
      )
    }
    const plan = plans.get(phi.sessionId)!
    outcomes.set(kind, { action: plan.action, reason: plan.reason, status: plan.status })

    const create = params(`remote-runtime-${kind}`)
    create.agentDir = desktopAgentDir
    create.cwd = localAnchor
    create.phiSessionId = phi.sessionId
    create.sessionManager = { kind: 'open', cwd: localAnchor, path: `phi-session:${phi.sessionId}` }
    create.remoteProject = {
      phiSessionId: phi.sessionId,
      projectId: scope.projectId,
      location,
      contextFiles: []
    }
    if (plan.action === 'read-only') {
      await assert.rejects(engine.sessions.create(create), (error: unknown) => {
        assert.match(
          error instanceof Error ? error.message : String(error),
          new RegExp(plan.reason, 'u')
        )
        return true
      })
    } else {
      await engine.sessions.create(create)
      await engine.sessions.prompt({ sessionId: create.sessionId, text: 'continue RPC history' })
      assert.equal(findPhiSessionById(phi.sessionId)?.kernelRuntimeRef?.host.kind, 'ssh')
      assert.ok(await readKernelOwner(phi.dir))
      await engine.sessions.dispose({ sessionId: create.sessionId })
    }
  }

  assert.deepEqual(outcomes.get('normal-end'), {
    action: 'adopt-remote',
    reason: 'remote identity is verified and the old writer is gone',
    status: 'ready'
  })
  assert.deepEqual(outcomes.get('interrupted'), {
    action: 'adopt-remote',
    reason: 'remote identity is verified and the old writer is gone',
    status: 'ready'
  })
  assert.deepEqual(outcomes.get('run-lock-residue'), {
    action: 'read-only',
    reason: OLD_REMOTE_PROCESS_REASON,
    status: 'unknown'
  })
  assert.deepEqual(outcomes.get('recovery-error'), {
    action: 'read-only',
    reason: 'saved RPC recovery metadata is invalid',
    status: 'read-only'
  })
})
