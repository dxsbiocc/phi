import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { facadeMetadataFixture } from './facadeMetadataFixture'
import { startCursorChildProvider } from './rpcCursorChildProvider'
import { getOmpBridge } from '../../src/main/agent/engine/omp-bridge'
import { createScopedCursorH2Gateway } from '../../src/main/agent/engine/in-process/scoped-cursor-h2-gateway'
import { cursorChildBarrierBundle, cursorChildBarrierPaths } from './rpcCursorChildBarrier'
import type { PhiAgentDefinition } from '../../src/main/agent/agents/definition'
import type { RpcChildRunSnapshot } from '../../src/main/agent/engine/rpc/subagents/types'
import type { RpcChildRuntimeConfig } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'

/** The accepted composed Task/child-authority fixture with a genuine Cursor child provider. */
export async function rpcCursorChildFixture(
  parallel = false,
  queuedStop = false
): Promise<{
  f: Awaited<ReturnType<typeof facadeMetadataFixture>>
  cursor: Awaited<ReturnType<typeof startCursorChildProvider>>
  children: Map<string, Readonly<RpcChildRunSnapshot>>
  diagnostics: unknown[]
  barrier?: ReturnType<typeof cursorChildBarrierPaths>
  observedText(marker: string): boolean
  create(): Promise<{ sessionId: string; nativeName: string }>
  close(): Promise<void>
}> {
  const cursor = await startCursorChildProvider(parallel)
  const children = new Map<string, Readonly<RpcChildRunSnapshot>>()
  const diagnostics: unknown[] = []
  const observed = new Set<string>()
  const definition: PhiAgentDefinition = {
    name: 'CursorCheck',
    description: 'Complete the bounded private Cursor recovery check',
    source: 'phi',
    filePath: '/trusted/CursorCheck.md',
    visibility: 'entry',
    warnings: [],
    tools: ['read'],
    skills: [],
    model: ['cursor/cursor-grok-4.6-fast'],
    thinkingLevel: 'off',
    systemPrompt: 'PRIVATE_CURSOR_CHILD. Complete only the assigned fixture request.'
  }
  let f: Awaited<ReturnType<typeof facadeMetadataFixture>>
  let barrierDirectory: string | undefined
  try {
    if (queuedStop) barrierDirectory = await mkdtemp(join(tmpdir(), 'phi-cursor-child-dequeue-'))
    f = await facadeMetadataFixture({
      isolatedProject: true,
      cursorProvider: {
        apiKey: 'synthetic-cursor-child-key',
        baseUrl: cursor.url,
        modelOverrides: {
          'cursor-grok-4.6-fast': { baseUrl: cursor.url, maxTokens: 256 }
        }
      },
      select: (selected) => {
        const bundle = barrierDirectory
          ? cursorChildBarrierBundle(selected.bundle, barrierDirectory)
          : selected.bundle
        diagnostics.push({
          productionBundle: selected.bundle.contentHash,
          selectedBundle: bundle.contentHash,
          dequeueObserver: !!barrierDirectory
        })
        return {
          ...selected,
          bundle,
          foregroundChildren: {
            definitions: [definition],
            allowParallel: true,
            onChildChange: (snapshot: Readonly<RpcChildRunSnapshot>) =>
              children.set(snapshot.id, snapshot)
          }
        }
      }
    })
  } catch (error) {
    await cursor.close().catch(() => undefined)
    if (barrierDirectory) await rm(barrierDirectory, { recursive: true, force: true })
    throw error
  }
  const token = randomBytes(32).toString('base64url')
  let scoped: Awaited<ReturnType<typeof createScopedCursorH2Gateway>>
  try {
    scoped = await createScopedCursorH2Gateway({
      token,
      allowedModelIds: [
        'cursor-grok-4.6-fast',
        'cursor-grok-4.6-low-fast',
        'cursor-grok-4.6-medium-fast',
        'cursor-grok-4.6-high-fast',
        'cursor-grok-4.6-xhigh-fast'
      ],
      resolveBearer: async () => 'synthetic-cursor-child-key',
      upstreamOrigin: cursor.url
    })
  } catch (error) {
    await f.close().catch(() => undefined)
    await cursor.close().catch(() => undefined)
    if (barrierDirectory) await rm(barrierDirectory, { recursive: true, force: true })
    throw error
  }
  const bridge = getOmpBridge()
  const createLease = bridge.createModelGatewayLease
  bridge.createModelGatewayLease = async (params, signal) => {
    const cursorModels = params.models.filter((model) => model.provider === 'cursor')
    if (!cursorModels.length) return createLease.call(bridge, params, signal)
    const base = await createLease.call(
      bridge,
      { ...params, models: params.models.filter((model) => model.provider !== 'cursor') },
      signal
    )
    let closing: Promise<void> | undefined
    return {
      ...base,
      cursor: { localPort: scoped.port, bearerToken: token },
      models: [
        ...base.models,
        ...cursorModels.map((model) => ({
          ...model,
          name: model.id,
          reasoning: true,
          input: ['text' as const, 'image' as const],
          contextWindow: 32768,
          maxTokens: 256
        }))
      ],
      close: () =>
        (closing ??= Promise.allSettled([base.close(), scoped.close()]).then(() => undefined))
    }
  }
  let closing: Promise<void> | undefined
  return {
    f,
    cursor,
    children,
    diagnostics,
    barrier: barrierDirectory ? cursorChildBarrierPaths(barrierDirectory) : undefined,
    observedText: (marker) => observed.has(marker),
    async create() {
      const sessionId = 'actual-cursor-child-parent'
      await f.engine.sessions.create(f.params(sessionId))
      const directory = (await f.privateDirectories())[0]
      const config = JSON.parse(
        await readFile(join(directory, 'child-runtime.json'), 'utf8')
      ) as RpcChildRuntimeConfig
      assert.equal(config.profiles.length, 1)
      const profile = config.profiles[0]
      assert.equal(profile.definition.blocking, true)
      assert.equal(profile.definition.model.provider, 'cursor')
      assert.equal(profile.definition.model.id, 'cursor-grok-4.6-fast')
      assert.equal(profile.definition.thinkingLevel, 'off')
      diagnostics.push({ expectedModel: profile.model, expectedRoute: profile.route })
      const decoder = new StringDecoder('utf8')
      let pending = ''
      f.channels.at(-1)!.stdout.on('data', (chunk: Buffer) => {
        pending += decoder.write(chunk)
        for (
          let boundary = pending.indexOf('\n');
          boundary >= 0;
          boundary = pending.indexOf('\n')
        ) {
          const line = pending.slice(0, boundary)
          pending = pending.slice(boundary + 1)
          const frame = JSON.parse(line) as Record<string, unknown>
          if (line.includes('CHILD_STOP_PARTIAL.')) observed.add('CHILD_STOP_PARTIAL.')
          if (
            frame.type === 'subagent_lifecycle' &&
            frame.payload &&
            typeof frame.payload === 'object'
          ) {
            const payload = frame.payload as Record<string, unknown>
            diagnostics.push({ lifecycle: payload.status, nativeId: payload.id })
          }
          if (
            frame.type === 'host_uri_request' &&
            typeof frame.content === 'string' &&
            typeof frame.url === 'string' &&
            frame.url.startsWith('phi-child:')
          ) {
            const request = JSON.parse(frame.content) as Record<string, unknown>
            diagnostics.push({
              operation: request.operation,
              ...(request.actual ? { actual: request.actual } : {})
            })
          }
          if (frame.type === 'extension_error') diagnostics.push({ error: frame.error })
        }
      })
      return { sessionId, nativeName: profile.definition.nativeName }
    },
    close: () =>
      (closing ??= (async () => {
        bridge.createModelGatewayLease = createLease
        try {
          await f.close()
        } finally {
          try {
            await scoped.close()
            await cursor.close()
          } finally {
            if (barrierDirectory) await rm(barrierDirectory, { recursive: true, force: true })
          }
        }
      })())
  }
}
