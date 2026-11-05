import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, win32 } from 'node:path'

import type { Page } from 'playwright-core'
import { redactSensitiveText } from '../src/main/agent/redaction'
import type { ManagedEnvironmentEntry } from '../src/shared/environmentTypes'
import type { ModelAvailabilitySnapshot } from '../src/shared/modelAvailabilityTypes'
import type { WebSearchSettings } from '../src/shared/webSearchSettingsTypes'
import { launchPackagedExecutable, type AppHandle } from './gui-e2e/app-launcher'
import { readAppLogDirectory } from './gui-e2e/jsonl'
import {
  agentConfig,
  MODEL_ID,
  PROVIDER_ID,
  record,
  startLoopbackProvider
} from './kernel-e2e/harness'

const REPLY = 'Phi installed desktop loopback reply verified'
const IPC_TIMEOUT_MS = 90_000
const AUTH_PROVIDER_ID = 'openai'

type ProviderStatus = { providerId: string; configured: boolean }
type SmokeApi = {
  getAuthStatus(): Promise<ProviderStatus[]>
  loginApiKey(providerId: string, key: string): Promise<ProviderStatus[]>
  logout(providerId: string): Promise<void>
  getModelAvailability(): Promise<ModelAvailabilitySnapshot>
  listManagedEnvironments(): Promise<ManagedEnvironmentEntry[]>
  getWebSearchSettings(): Promise<WebSearchSettings>
  selectModel(providerId: string, modelId: string): Promise<void>
  sendPrompt(text: string): Promise<unknown>
  onAgentEvent(listener: (event: unknown) => void): () => void
}

function isolatedEnvironment(profile: string): Record<string, string> {
  const system = new Set(['systemroot', 'systemdrive', 'windir', 'comspec', 'pathext', 'lang'])
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        system.has(entry[0].toLowerCase()) && entry[1] !== undefined
    )
  )
  const windows = process.env.SystemRoot || 'C:\\Windows'
  const path =
    process.platform === 'win32' ? [win32.join(windows, 'System32'), windows] : ['/usr/bin', '/bin']
  return {
    ...inherited,
    PATH: path.join(delimiter),
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: join(profile, 'roaming'),
    LOCALAPPDATA: join(profile, 'local'),
    TMP: join(profile, 'temp'),
    TEMP: join(profile, 'temp'),
    TMPDIR: join(profile, 'temp'),
    PI_CODING_AGENT_DIR: join(profile, '.phi'),
    OMP_CODING_AGENT_DIR: join(profile, '.phi')
  }
}

function withDeadline<T>(label: string, pending: Promise<T>, ms = IPC_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
  })
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer))
}

async function sampleStartupMemory(app: AppHandle): Promise<void> {
  if (app.sampleMemory) {
    try {
      const processes = await withDeadline('Startup memory sample', app.sampleMemory(), 5_000)
      console.log(
        `Startup Electron memory, KiB (excludes external workers): ${JSON.stringify(processes)}`
      )
      return
    } catch {
      // This optional diagnostic must not prevent the actual acceptance checks.
    }
  }
  console.log('Startup Electron memory sample unavailable')
}

async function checkSettings(page: Page, token: string): Promise<void> {
  const settings = await withDeadline(
    'Installed desktop settings IPC',
    page.evaluate(async () => {
      const { api } = globalThis as unknown as { api: SmokeApi }
      return await Promise.all([
        api.getModelAvailability(),
        api.getAuthStatus(),
        api.listManagedEnvironments(),
        api.getWebSearchSettings()
      ])
    })
  )
  const [availability, providers, environments, webSearch] = settings
  assert.ok(
    availability.models.some(
      (model) => model.providerId === PROVIDER_ID && model.modelId === MODEL_ID
    )
  )
  assert.equal(
    providers.find((provider) => provider.providerId === AUTH_PROVIDER_ID)?.configured,
    false
  )
  assert.ok(environments.some((environment) => environment.ref === 'phi:python@1'))
  assert.ok(Array.isArray(webSearch.providers) && webSearch.providers.length > 0)

  const configured = await withDeadline(
    'Save and remove an isolated provider key',
    page.evaluate(
      async ({ providerId, key }) => {
        const { api } = globalThis as unknown as { api: SmokeApi }
        try {
          await api.loginApiKey(providerId, key)
          return (await api.getAuthStatus()).some(
            (provider) => provider.providerId === providerId && provider.configured
          )
        } finally {
          await api.logout(providerId)
        }
      },
      { providerId: AUTH_PROVIDER_ID, key: token }
    )
  )
  assert.equal(configured, true)
  console.log(
    'Installed desktop model availability, provider setup, environments and web search settings passed'
  )
}

async function checkChat(page: Page): Promise<void> {
  const rejected = await withDeadline(
    'Installed desktop local chat',
    page.evaluate(
      async ({ providerId, modelId, reply }) => {
        const { api } = globalThis as unknown as { api: SmokeApi }
        await api.selectModel(providerId, modelId)
        let unsubscribe: () => void = () => undefined
        const eventTypes = new Set<string>()
        const observed = new Promise<void>((resolve) => {
          unsubscribe = api.onAgentEvent((event) => {
            const type =
              event && typeof event === 'object' && 'type' in event ? event.type : undefined
            if (typeof type === 'string' && /^[a-z_]{1,48}$/.test(type)) eventTypes.add(type)
            if (JSON.stringify(event)?.includes(reply)) resolve()
          })
        })
        try {
          const submitted = await api.sendPrompt('Respond with the scripted acceptance result.')
          if (!submitted) return [...eventTypes]
          await observed
          return null
        } finally {
          unsubscribe()
        }
      },
      { providerId: PROVIDER_ID, modelId: MODEL_ID, reply: REPLY }
    )
  )
  assert.equal(
    rejected,
    null,
    `Installed desktop did not complete the local prompt (events: ${rejected?.join(', ') || 'none'})`
  )
}

function reportSmokeFailure(agentDir: string, token: string): void {
  try {
    const relevantEvents = new Set([
      'run_started',
      'run_failed',
      'run_interrupted',
      'run_completed',
      'kernel_diagnostic',
      'omp_worker_exited'
    ])
    const { entries } = readAppLogDirectory(join(agentDir, 'logs'))
    const diagnostics = entries
      .filter((entry) => relevantEvents.has(entry.event))
      .slice(-12)
      .map((entry) => {
        const source: Record<string, unknown> = {
          ...entry.metadata,
          detail: record(entry.metadata?.details).error
        }
        const metadata = Object.fromEntries(
          (['error', 'message', 'reason', 'target', 'stderrTail', 'detail'] as const).flatMap(
            (field) => {
              const text = source[field]
              return typeof text === 'string'
                ? [[field, redactSensitiveText(text.replaceAll(token, '[redacted]')).slice(0, 400)]]
                : []
            }
          )
        )
        return { event: entry.event, metadata }
      })
    console.error(
      `Installed desktop diagnostics from isolated profile: ${JSON.stringify(diagnostics)}`
    )
  } catch {
    console.error('Could not read diagnostics from the isolated desktop profile')
  }
}

function writeModelFixture(agentDir: string, url: string, token: string): void {
  const fixture = agentConfig(url, token)
  writeFileSync(join(agentDir, 'models.yml'), fixture.models)
  writeFileSync(join(agentDir, 'config.yml'), fixture.config)
}

async function main(): Promise<void> {
  const [flag, executable, ...rest] = process.argv.slice(2)
  if (flag !== '--app' || !executable || !isAbsolute(executable) || rest.length > 0) {
    throw new Error('Usage: smoke-installed-desktop.ts --app <absolute installed executable>')
  }
  const profile = mkdtempSync(join(tmpdir(), 'phi-installed-desktop-'))
  try {
    const agentDir = join(profile, '.phi')
    const userData = join(profile, 'user-data')
    for (const directory of [
      agentDir,
      userData,
      join(profile, 'temp'),
      join(profile, 'roaming'),
      join(profile, 'local')
    ]) {
      mkdirSync(directory, { mode: 0o700 })
    }
    const token = randomBytes(32).toString('base64url')
    const provider = await startLoopbackProvider(token)
    try {
      writeModelFixture(agentDir, provider.url, token)
      const app = await launchPackagedExecutable(executable, {
        env: isolatedEnvironment(profile),
        userData,
        args: ['--disable-background-networking', '--proxy-server=http://127.0.0.1:9']
      })
      try {
        await sampleStartupMemory(app)
        await checkSettings(app.page, token)
        provider.enqueue({ text: REPLY })
        await checkChat(app.page)
        assert.ok(provider.completedRequestCount() > 0)
        console.log('Installed desktop local chat passed with the synthetic loopback provider')
      } catch (error) {
        console.error(
          `Loopback model requests observed: ${provider.requests.length}, completed: ${provider.completedRequestCount()}`
        )
        reportSmokeFailure(agentDir, token)
        throw error
      } finally {
        await app.close()
      }
    } finally {
      await provider.close()
    }
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

await main()
