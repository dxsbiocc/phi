import { dirname, join, resolve } from 'node:path'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  KernelClientError,
  spawnKernelStdio,
  type KernelProtocolClient,
  type LocalKernelCloseOutcome,
  type SpawnedKernelClient
} from '../../src/main/agent/engine/kernel-client'
import type {
  PhiAgentEvent,
  RuntimeModel,
  WorkerCreateSessionResult,
  WorkerSessionState
} from '../../src/main/agent/engine/types'
import {
  createModelAccessBroker,
  MODEL_ACCESS_BROKER_CAPABILITIES,
  registerModelAccessBroker,
  type ModelAccessAuthStorage,
  type ModelAccessBroker
} from '../../src/main/agent/engine/kernel-host/model-access-broker'
import type { KernelEventFrame, JsonValue } from '../../src/shared/kernel-protocol'
import type { BasicEngineFixture } from './basic-suite'
import { createInProcessFixture } from './in-process-factory'

type RunCompletion = {
  status: 'completed' | 'failed' | 'cancelled' | 'unknown'
  detail?: string
}

export type KernelEngineFixture = BasicEngineFixture & {
  client: KernelProtocolClient
  kernelInstanceId: string
  agentDir: string
  cwd: string
  model: RuntimeModel
  kernelSessionId(sessionId: string): string | undefined
  /** Drops the connection the way a lost SSH channel does: no session.close is sent. */
  disconnect(): Promise<LocalKernelCloseOutcome>
  /** Kills the kernel without cleanup for durable-session fault injection. */
  kill(): Promise<void>
  /** Starts another negotiated kernel against the same disposable agent directory. */
  spawnPeer(): Promise<SpawnedKernelClient>
  waitForRun(runId: string): Promise<RunCompletion>
  createSession(
    sessionId: string,
    options?: {
      cwd?: string
      enableToolApproval?: boolean
      workMode?: 'direct' | 'plan' | 'plan_execute' | 'auto'
      noTools?: 'all' | boolean
      persistent?: boolean
      resourceOptions?: {
        noExtensions: boolean
        noSkills: boolean
        noContextFiles: boolean
        noPromptTemplates: boolean
        noThemes: boolean
      }
    }
  ): Promise<WorkerCreateSessionResult>
}

export type KernelFixtureOptions = {
  testPause?: 'a' | 'c' | 'd1' | 'd2'
  hostCapabilities?: string[]
  modelAccess?: 'desktop-stored'
}

function storedCredentialBroker(provider: string): ModelAccessBroker {
  const credential = {
    id: 1,
    provider,
    credential: { type: 'api_key' as const, key: 'fake-desktop-stored-key' },
    identityKey: null
  }
  return createModelAccessBroker({
    credentials: {
      snapshot: () => ({ generation: 1, generatedAt: Date.now(), credentials: [credential] })
    },
    oauth: {
      refresh: async () => {
        throw new Error('The stored-key fixture does not use OAuth refresh.')
      }
    }
  } satisfies ModelAccessAuthStorage)
}

function record(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Kernel returned a non-object result')
  }
  return value
}

function stateFrom(value: JsonValue, fallbackModel: RuntimeModel | undefined): WorkerSessionState {
  const raw = record(value)
  const selected = raw.model
  const model =
    selected && typeof selected === 'object' && !Array.isArray(selected)
      ? {
          provider: String(selected.provider),
          id: String(selected.id),
          name: fallbackModel?.name ?? String(selected.id),
          reasoning: fallbackModel?.reasoning ?? false
        }
      : undefined
  return {
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    ...(model ? { model } : {}),
    ...(typeof raw.thinkingLevel === 'string'
      ? { thinkingLevel: raw.thinkingLevel as WorkerSessionState['thinkingLevel'] }
      : {}),
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {})
  }
}

export async function createKernelFixture(
  options: KernelFixtureOptions = {}
): Promise<KernelEngineFixture> {
  const base = await createInProcessFixture()
  const root = dirname(base.agentDir)
  const diagnostics: string[] = []
  let spawned: SpawnedKernelClient | undefined
  try {
    const modelAccessBroker =
      options.modelAccess === 'desktop-stored'
        ? storedCredentialBroker(base.model.provider)
        : undefined
    if (modelAccessBroker) {
      const modelsPath = join(base.agentDir, 'models.yml')
      const config = JSON.parse(readFileSync(modelsPath, 'utf8')) as {
        providers: Record<string, { apiKey?: string }>
      }
      // The disposable kernel must authenticate only through the same broker surface as desktop.
      delete config.providers[base.model.provider]?.apiKey
      writeFileSync(modelsPath, JSON.stringify(config))
    }
    const hostCapabilities = modelAccessBroker
      ? [...new Set([...(options.hostCapabilities ?? []), ...MODEL_ACCESS_BROKER_CAPABILITIES])]
      : options.hostCapabilities
    const registerBroker = (client: KernelProtocolClient): void => {
      if (modelAccessBroker) registerModelAccessBroker(client, modelAccessBroker)
    }
    const kernelEnv = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: join(root, 'home'),
      USERPROFILE: join(root, 'home'),
      XDG_CONFIG_HOME: join(root, 'home', '.config'),
      XDG_CACHE_HOME: join(root, 'home', '.cache'),
      XDG_DATA_HOME: join(root, 'home', '.local/share'),
      TMPDIR: join(root, 'tmp'),
      TMP: join(root, 'tmp'),
      TEMP: join(root, 'tmp'),
      PI_CODING_AGENT_DIR: base.agentDir,
      OMP_APP_NAME: 'Phi',
      NO_PROXY: '127.0.0.1,localhost',
      PHI_CONTRACT_HOST_SECRET: join(root, 'host-only-secret'),
      PYTHONPATH: join(root, 'host-pythonpath'),
      ...(options.testPause ? { PHI_KERNEL_TEST_PAUSE: options.testPause } : {})
    }
    const peerEnv = { ...kernelEnv }
    delete peerEnv.PHI_KERNEL_TEST_PAUSE
    const spawnPeer = async (): Promise<SpawnedKernelClient> => {
      const peer = spawnKernelStdio({
        cwd: resolve('.'),
        bunArgs: ['--preload', fileURLToPath(new URL('./network-guard.ts', import.meta.url))],
        env: peerEnv,
        onDiagnostic: (text) => diagnostics.push(text)
      })
      try {
        registerBroker(peer.client)
        await peer.client.hello({ hostCapabilities })
        await peer.client.subscribe(0)
        return peer
      } catch (error) {
        await peer.close()
        throw error
      }
    }
    spawned = spawnKernelStdio({
      cwd: resolve('.'),
      bunArgs: ['--preload', fileURLToPath(new URL('./network-guard.ts', import.meta.url))],
      env: kernelEnv,
      onDiagnostic: (text) => diagnostics.push(text)
    })
    const client = spawned.client
    registerBroker(client)
    const greeting = await client.hello({ hostCapabilities })
    await client.subscribe(0)

    const logicalToKernel = new Map<string, string>()
    const kernelToLogical = new Map<string, string>()
    const models = new Map<string, RuntimeModel | undefined>()
    const eventListeners = new Map<string, Set<(event: PhiAgentEvent) => void>>()
    const completedRuns = new Map<string, RunCompletion>()
    const runWaiters = new Map<string, (completion: RunCompletion) => void>()

    const waitForRun = (runId: string): Promise<RunCompletion> => {
      const completed = completedRuns.get(runId)
      if (completed) return Promise.resolve(completed)
      return new Promise<RunCompletion>((resolveRun) => runWaiters.set(runId, resolveRun))
    }

    const stopEvents = client.onEvent((event: KernelEventFrame) => {
      if (event.type === 'session.event' && event.sessionId) {
        const logical = kernelToLogical.get(event.sessionId)
        if (!logical) return
        for (const listener of eventListeners.get(logical) ?? []) {
          listener(event.payload as unknown as PhiAgentEvent)
        }
        return
      }
      if (event.type !== 'run.completed') return
      const payload = record(event.payload)
      if (typeof payload.runId !== 'string' || typeof payload.status !== 'string') return
      const completion: RunCompletion = {
        status: payload.status as RunCompletion['status'],
        ...(typeof payload.detail === 'string' ? { detail: payload.detail } : {})
      }
      completedRuns.set(payload.runId, completion)
      const resolveRun = runWaiters.get(payload.runId)
      runWaiters.delete(payload.runId)
      resolveRun?.(completion)
    })

    const requiredKernelSessionId = (sessionId: string): string => {
      const kernelSessionId = logicalToKernel.get(sessionId)
      if (!kernelSessionId) throw new Error(`Unknown kernel session: ${sessionId}`)
      return kernelSessionId
    }

    const snapshot = async (sessionId: string): Promise<WorkerSessionState> => {
      const result = await client.request(
        'session.snapshot',
        {},
        { sessionId: requiredKernelSessionId(sessionId) }
      )
      return stateFrom(result, models.get(sessionId))
    }

    const createSession = async (
      sessionId: string,
      options: Parameters<KernelEngineFixture['createSession']>[1] = {}
    ): Promise<WorkerCreateSessionResult> => {
      const result = record(
        await client.request('session.create', {
          cwd: options.cwd ?? base.cwd,
          model: { provider: base.model.provider, id: base.model.id },
          sessionManager: { kind: options.persistent ? 'persistent' : 'memory' },
          resourceOptions: options.resourceOptions ?? {
            noExtensions: true,
            noSkills: true,
            noContextFiles: true,
            noPromptTemplates: true,
            noThemes: true
          },
          noTools: options.noTools ?? false,
          enableToolApproval: options.enableToolApproval ?? false,
          ...(options.workMode ? { workMode: options.workMode } : {}),
          autoCompaction: { enabled: false }
        })
      )
      if (typeof result.sessionId !== 'string') {
        throw new TypeError('Kernel create result omitted sessionId')
      }
      logicalToKernel.set(sessionId, result.sessionId)
      kernelToLogical.set(result.sessionId, sessionId)
      models.set(sessionId, base.model)
      return { sessionId, state: await snapshot(sessionId) }
    }

    let closing: Promise<void> | undefined
    return {
      client,
      kernelInstanceId: greeting.kernelInstanceId,
      provider: base.provider,
      agentDir: base.agentDir,
      cwd: base.cwd,
      model: base.model,
      params: (sessionId) => ({
        sessionId,
        cwd: base.cwd,
        agentDir: base.agentDir,
        model: base.model
      }),
      kernelSessionId: (sessionId) => logicalToKernel.get(sessionId),
      waitForRun,
      spawnPeer,
      createSession,
      onSessionEvent(sessionId, listener) {
        let listeners = eventListeners.get(sessionId)
        if (!listeners) {
          listeners = new Set()
          eventListeners.set(sessionId, listeners)
        }
        listeners.add(listener)
        return () => listeners?.delete(listener)
      },
      sessions: {
        async create(params): Promise<WorkerCreateSessionResult> {
          const created = await createSession(params.sessionId, {
            cwd: params.cwd,
            noTools: 'all'
          })
          models.set(params.sessionId, params.model ?? base.model)
          return created
        },
        async prompt(params): Promise<WorkerSessionState> {
          const result = record(
            await client.request(
              'session.prompt',
              { text: params.text },
              { sessionId: requiredKernelSessionId(params.sessionId) }
            )
          )
          if (typeof result.runId !== 'string') {
            throw new TypeError('Kernel prompt result omitted runId')
          }
          const completion = await waitForRun(result.runId)
          if (completion.status === 'failed' || completion.status === 'unknown') {
            throw new KernelClientError({
              code: 'INTERNAL',
              message: completion.detail ?? `Kernel run ended with ${completion.status}`
            })
          }
          return snapshot(params.sessionId)
        },
        async abort(params): Promise<WorkerSessionState> {
          await client.request(
            'session.abort',
            {},
            { sessionId: requiredKernelSessionId(params.sessionId) }
          )
          return snapshot(params.sessionId)
        },
        async dispose(params): Promise<unknown> {
          const kernelSessionId = requiredKernelSessionId(params.sessionId)
          const result = await client.request('session.close', {}, { sessionId: kernelSessionId })
          logicalToKernel.delete(params.sessionId)
          kernelToLogical.delete(kernelSessionId)
          models.delete(params.sessionId)
          eventListeners.delete(params.sessionId)
          return result
        },
        has: (sessionId) => logicalToKernel.has(sessionId)
      },
      async disconnect() {
        stopEvents()
        if (!spawned) throw new Error('Kernel was not spawned')
        return spawned.close()
      },
      async kill() {
        stopEvents()
        if (!spawned) throw new Error('Kernel was not spawned')
        const child = spawned.process
        if (child.exitCode !== null || child.signalCode !== null) return
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      },
      close() {
        closing ??= (async () => {
          stopEvents()
          try {
            await Promise.allSettled(
              [...logicalToKernel.values()].map((sessionId) =>
                client.request('session.close', {}, { sessionId })
              )
            )
          } finally {
            await spawned?.close()
            await base.close()
          }
        })()
        return closing
      }
    }
  } catch (error) {
    await spawned?.close()
    await base.close()
    if (diagnostics.length > 0 && error instanceof Error) {
      error.message = `${error.message}\nKernel diagnostics:\n${diagnostics.join('')}`
    }
    throw error
  }
}
