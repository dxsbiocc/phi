import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createAppKernelSessionLaunchers,
  kernelDiagnosticLogEntry,
  kernelLaunchCwd
} from '../src/main/agent/app-kernel-session-launchers'
import { KernelSessionFactory } from '../src/main/agent/engine/kernel-session-factory'
import type { PhiSessionCreateParams } from '../src/main/agent/engine/types'
import type {
  AppRemoteSessionRoutingDependencies,
  AppRemoteSessionRoutingOptions
} from '../src/main/agent/remote-session-routing'

const ENVIRONMENT_KEYS = [
  'BUN_OPTIONS',
  'HOME',
  'NO_PROXY',
  'PI_CODING_AGENT_DIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE'
] as const

test('kernel diagnostics retain the underlying INTERNAL handler cause', () => {
  assert.deepEqual(
    kernelDiagnosticLogEntry(
      'local',
      JSON.stringify({
        level: 'error',
        message: 'Kernel method handler failed.',
        details: {
          method: 'session.create',
          error: "EPERM: operation not permitted, posix_spawn '/bin/ps'"
        }
      })
    ),
    {
      level: 'error',
      event: 'kernel_diagnostic',
      metadata: {
        target: 'local',
        message: 'Kernel method handler failed.',
        details: {
          method: 'session.create',
          error: "EPERM: operation not permitted, posix_spawn '/bin/ps'"
        }
      }
    }
  )
})

test('Node main launches a kernel-routed faux-provider run without loading the SDK', async () => {
  assert.equal(process.versions.bun, undefined, 'the host side of this test must run under Node')
  const root = mkdtempSync(join(tmpdir(), 'phi-app-kernel-node-'))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  const home = join(root, 'home')
  const temp = join(root, 'tmp')
  for (const directory of [agentDir, cwd, home, temp]) mkdirSync(directory, { recursive: true })

  writeFileSync(
    join(agentDir, 'models.yml'),
    JSON.stringify({
      providers: {
        'phi-faux': {
          baseUrl: 'http://phi-faux.invalid/v1',
          api: 'openai-completions',
          apiKey: 'faux-only-key',
          models: [
            {
              id: 'faux-model',
              name: 'Faux Model',
              reasoning: false,
              input: ['text'],
              contextWindow: 32_768,
              maxTokens: 256,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  )
  writeFileSync(
    join(agentDir, 'config.yml'),
    JSON.stringify({
      defaultProvider: 'phi-faux',
      defaultModel: 'faux-model',
      compaction: { enabled: false },
      mcp: { enableProjectConfig: false },
      extensions: [],
      skills: [],
      memory: { enabled: false }
    })
  )

  const previous = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
  process.env.BUN_OPTIONS = `--preload=${fileURLToPath(
    new URL('./helpers/fauxModelFetch.ts', import.meta.url)
  )}`
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.TMPDIR = temp
  process.env.TMP = temp
  process.env.TEMP = temp
  process.env.NO_PROXY = 'phi-faux.invalid'
  process.env.PI_CODING_AGENT_DIR = agentDir

  const options = {
    agentDir,
    runners: {},
    appPaths: () => ({
      appPath: resolve('.'),
      resourcesPath: resolve('resources'),
      isPackaged: false,
      version: '0.1.0'
    }),
    configuredRoot: () => cwd,
    loadAgents: async () => [],
    approval: {
      shouldGate: () => false,
      requestToolApproval: async () => ({ block: false }),
      onEvent: () => undefined
    }
  } as unknown as AppRemoteSessionRoutingOptions
  const launchers = createAppKernelSessionLaunchers(
    options,
    {} as AppRemoteSessionRoutingDependencies
  )
  const factory = new KernelSessionFactory({
    mode: 'local',
    launchLocal: launchers.launchLocal,
    hostCapabilities: launchers.hostCapabilities,
    configureClient: launchers.configureClient
  })
  const params: PhiSessionCreateParams = {
    sessionId: 'node-main-kernel-session',
    cwd,
    agentDir,
    model: { provider: 'phi-faux', id: 'faux-model', name: 'Faux Model', reasoning: false },
    sessionManager: { kind: 'memory', cwd },
    noTools: 'all',
    enableToolApproval: false,
    autoCompaction: { enabled: false },
    memory: { enabled: false, learn: false },
    resourceOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true
    }
  }

  try {
    const driver = await factory.create(params, new AbortController().signal, {
      event: () => undefined,
      state: () => undefined
    })
    const state = await driver.prompt('Reply with the faux response.')
    assert.match(
      JSON.stringify(state.messages),
      /node main launched the kernel without loading the SDK/u
    )
    await driver.dispose()
  } finally {
    await factory.stop().catch(() => undefined)
    await launchers.close()
    for (const key of ENVIRONMENT_KEYS) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('packaged kernel launches from a real directory, never the app.asar file', () => {
  const packaged = {
    appPath: '/Applications/Phi.app/Contents/Resources/app.asar',
    resourcesPath: '/Applications/Phi.app/Contents/Resources',
    isPackaged: true,
    version: '0.1.0'
  } as ReturnType<AppRemoteSessionRoutingOptions['appPaths']>
  const buildDirectory = '/Applications/Phi.app/Contents/Resources/kernel/0.1.0/darwin-arm64'
  assert.equal(kernelLaunchCwd(packaged, buildDirectory), buildDirectory)
  assert.equal(
    kernelLaunchCwd({ ...packaged, appPath: '/repo', isPackaged: false }, buildDirectory),
    '/repo'
  )
})
