import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createInProcessEngine } from '../../src/main/agent/engine/in-process-engine'
import { OmpBridge } from '../../src/main/agent/engine/omp-bridge'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import type { PhiEngine, RuntimeModel } from '../../src/main/agent/engine/types'
import { startLoopbackModel } from './loopback-model'

export type EngineFixture = {
  engine: PhiEngine
  agentDir: string
  cwd: string
  model: RuntimeModel
  replacementModel: RuntimeModel
  provider: Awaited<ReturnType<typeof startLoopbackModel>>
  removeModel(): void
  seedOAuth(): Promise<void>
  close(): Promise<void>
}
export type EngineFactory = (modelId?: string) => Promise<EngineFixture>

type InProcessFixtureOptions = {
  providerFactory?: typeof startLoopbackModel
  api?: 'cursor-agent'
}

export function createInProcessFixture(modelId?: string): Promise<EngineFixture>
export function createInProcessFixture(options?: InProcessFixtureOptions): Promise<EngineFixture>
export async function createInProcessFixture(
  input: string | InProcessFixtureOptions = 'contract-model'
): Promise<EngineFixture> {
  const options = typeof input === 'string' ? undefined : input
  const root = mkdtempSync(join(tmpdir(), 'phi-engine-contract-'))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  const home = join(root, 'home')
  const temp = join(root, 'tmp')
  const providerId = options?.api === 'cursor-agent' ? 'cursor' : 'phi-contract'
  const modelId =
    options?.api === 'cursor-agent'
      ? 'cursor-grok-4.6-fast'
      : typeof input === 'string'
        ? input
        : 'contract-model'
  const model: RuntimeModel = {
    provider: providerId,
    id: modelId,
    name: 'Contract Model',
    reasoning: false
  }
  const replacementModel: RuntimeModel = {
    ...model,
    id: modelId.includes('[') ? 'contractm-replacement' : `${modelId}-v2`,
    name: 'Replacement Model'
  }
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  let provider: Awaited<ReturnType<typeof startLoopbackModel>> | undefined
  let engine: PhiEngine | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        await engine?.stop()
      } finally {
        try {
          await provider?.close()
        } finally {
          if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
          else process.env.PI_CODING_AGENT_DIR = previousAgentDir
          rmSync(root, { recursive: true, force: true })
        }
      }
    })()
    return closing
  }
  try {
    for (const dir of [agentDir, cwd, home, temp]) mkdirSync(dir, { recursive: true })
    const bun = resolveBunExecutable()
    provider = await (options?.providerFactory ?? startLoopbackModel)()
    const configPath = join(agentDir, 'models.yml')
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          [providerId]: {
            baseUrl: provider.url,
            apiKey: 'contract-only-key',
            ...(options?.api === 'cursor-agent'
              ? {
                  modelOverrides: {
                    [modelId]: { baseUrl: provider.url, contextWindow: 32768, maxTokens: 256 }
                  }
                }
              : {
                  api: 'openai-completions',
                  models: [
                    {
                      id: modelId,
                      name: 'Contract Model',
                      reasoning: false,
                      input: ['text'],
                      contextWindow: 32768,
                      maxTokens: 256,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
                    }
                  ]
                })
          }
        }
      })
    )
    writeFileSync(
      join(agentDir, 'config.yml'),
      JSON.stringify({
        compaction: {
          enabled: true,
          thresholdPercent: 80,
          thresholdTokens: -1,
          methodOrder: ['soft']
        },
        mcp: { enableProjectConfig: false },
        defaultProvider: providerId,
        defaultModel: modelId
      })
    )
    process.env.PI_CODING_AGENT_DIR = agentDir
    const bridge = new OmpBridge(() =>
      spawn(
        bun,
        [
          '--preload',
          fileURLToPath(new URL('./network-guard.ts', import.meta.url)),
          resolve('src/main/agent/engine/in-process/main.ts')
        ],
        {
          cwd,
          env: {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: join(home, '.config'),
            XDG_CACHE_HOME: join(home, '.cache'),
            XDG_DATA_HOME: join(home, '.local/share'),
            TMPDIR: temp,
            TMP: temp,
            TEMP: temp,
            PI_CODING_AGENT_DIR: agentDir,
            OMP_APP_NAME: 'Phi',
            NO_PROXY: '127.0.0.1,localhost',
            PHI_CONTRACT_HOST_SECRET: join(root, 'host-only-secret'),
            PYTHONPATH: join(root, 'host-pythonpath')
          },
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
    )
    engine = createInProcessEngine(bridge)
    // Ordinary startup probes do not require any desktop service in these contracts.
    engine.host.register('settings.nextActionSuggestionsEnabled', () => false)
    engine.host.register('skills.scriptTools', () => ({ tools: [] }))
    return {
      engine,
      agentDir,
      cwd,
      provider,
      model,
      replacementModel,
      removeModel: () =>
        writeFileSync(
          configPath,
          JSON.stringify({
            providers:
              options?.api === 'cursor-agent'
                ? {}
                : {
                    'phi-contract': {
                      baseUrl: provider!.url,
                      api: 'openai-completions',
                      apiKey: 'contract-only-key',
                      models: [
                        {
                          id: replacementModel.id,
                          name: 'Replacement Model',
                          reasoning: false,
                          input: ['text'],
                          contextWindow: 32768,
                          maxTokens: 256,
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
                        }
                      ]
                    }
                  }
          })
        ),
      async seedOAuth(): Promise<void> {
        // Let the actual worker create its schema, then release its connection.
        await engine!.models.snapshot({ agentDir })
        await engine!.stop()
        const databasePath = join(agentDir, 'agent.db')
        if (!existsSync(databasePath)) throw new Error('Contract auth database was not created')
        const database = new DatabaseSync(databasePath)
        try {
          // Fixture-only persistence seam, verified against pinned 18.10.3's
          // pi-ai/auth/sqlite-credential-store.ts serializeCredential and table.
          // OAuth data excludes `type`; credential_type carries it separately.
          database
            .prepare(
              "INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, 'oauth', ?)"
            )
            .run(
              'anthropic',
              JSON.stringify({
                refresh: 'contract-oauth-refresh',
                access: 'contract-oauth-access',
                expires: Date.UTC(2035, 0, 1),
                email: 'contract@example.invalid'
              })
            )
        } finally {
          database.close()
        }
      },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
