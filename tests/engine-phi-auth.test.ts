import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import type { PhiMcpOAuthCredential } from '../src/main/agent/engine/types'

const execFileAsync = promisify(execFile)
const testFile = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(testFile), '..')
const childScenario = process.env.PHI_AUTH_BUN_SCENARIO
const CODING_AGENT_PACKAGE = ['@oh-my-pi', 'pi-coding-agent'].join('/')
const MCP_OAUTH_PACKAGE = [CODING_AGENT_PACKAGE, 'mcp', 'oauth-flow'].join('/')

function oauthCredential(overrides: Partial<PhiMcpOAuthCredential> = {}): PhiMcpOAuthCredential {
  return {
    type: 'oauth',
    refresh: 'refresh-token',
    access: 'access-token',
    expires: Date.now() + 60_000,
    ...overrides
  }
}

async function runBunScenario(scenario: string, realStorage = true): Promise<void> {
  const agentDir = realStorage ? await mkdtemp(join(tmpdir(), 'phi-auth-')) : undefined
  try {
    const result = await execFileAsync('bun', [testFile], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PHI_AUTH_BUN_SCENARIO: scenario,
        ...(agentDir ? { PHI_AUTH_AGENT_DIR: agentDir } : {}),
        OMP_AUTH_BROKER_URL: '',
        OMP_AUTH_BROKER_TOKEN: ''
      },
      maxBuffer: 1024 * 1024
    })
    assert.match(result.stdout, new RegExp(`phi-auth:${scenario}:ok`))
  } finally {
    if (agentDir) await rm(agentDir, { recursive: true, force: true })
  }
}

async function executeChildScenario(scenario: string): Promise<void> {
  const { createPhiAuth } = await import('../src/main/agent/engine/in-process/auth')

  if (scenario === 'login') {
    const signal = new AbortController().signal
    const observed = {
      providerId: '',
      signal: undefined as AbortSignal | undefined,
      manualCode: '',
      promptValues: [] as string[]
    }
    const storage = {
      async login(
        providerId: string,
        callbacks: {
          signal?: AbortSignal
          onAuth(info: { url: string; launchUrl?: string; instructions?: string }): void
          onProgress(message: string): void
          onManualCodeInput(): Promise<string>
          onPrompt(prompt: { message: string; placeholder?: string }): Promise<string>
        }
      ) {
        observed.providerId = providerId
        observed.signal = callbacks.signal
        callbacks.onAuth({
          url: 'https://long.example.test/authorize?full=true',
          launchUrl: 'http://127.0.0.1/launch',
          instructions: 'Open the browser'
        })
        callbacks.onProgress('Waiting for authorization')
        observed.manualCode = await callbacks.onManualCodeInput()
        observed.promptValues.push(
          await callbacks.onPrompt({ message: 'Account', placeholder: 'name@example.com' })
        )
        observed.promptValues.push(await callbacks.onPrompt({ message: 'One-time code' }))
      }
    }
    const auth = createPhiAuth(storage as never)
    const authEvents: Array<{ url: string; instructions?: string }> = []
    const progress: string[] = []
    const prompts: Array<{ message: string; placeholder?: string }> = []

    await auth.login('oauth-provider', {
      signal,
      onAuth(info) {
        authEvents.push(info)
      },
      onProgress(message) {
        progress.push(message)
      },
      async onManualCodeInput() {
        return 'manual-code-value'
      },
      async onPrompt(prompt) {
        prompts.push(prompt)
        return `answer-${prompts.length}`
      }
    })

    assert.equal(observed.providerId, 'oauth-provider')
    assert.strictEqual(observed.signal, signal)
    assert.deepEqual(authEvents, [
      { url: 'http://127.0.0.1/launch', instructions: 'Open the browser' }
    ])
    assert.deepEqual(progress, ['Waiting for authorization'])
    assert.equal(observed.manualCode, 'manual-code-value')
    assert.deepEqual(prompts, [
      { message: 'Account', placeholder: 'name@example.com' },
      { message: 'One-time code' }
    ])
    assert.deepEqual(observed.promptValues, ['answer-1', 'answer-2'])
    process.stdout.write(`phi-auth:${scenario}:ok\n`)
    return
  }

  const agentDir = process.env.PHI_AUTH_AGENT_DIR
  assert.ok(agentDir, 'storage-backed scenarios require a temporary agent directory')
  const { discoverAuthStorage } = (await import(CODING_AGENT_PACKAGE)) as {
    discoverAuthStorage(agentDir: string): Promise<{
      close(): void
      describeCredentialSource(providerId: string): string | undefined
      get(providerId: string): unknown
      listStoredCredentials(providerId?: string): Array<{
        id: number
        provider: string
        credential: Record<string, unknown> & { type: 'api_key' | 'oauth' }
      }>
      set(providerId: string, credential: unknown): Promise<void>
    }>
  }
  const storage = await discoverAuthStorage(agentDir)
  const auth = createPhiAuth(storage as never)

  try {
    if (scenario === 'set-and-status') {
      await auth.setApiKey('phi-test-provider', 'secret-key')

      const all = auth.listCredentials()
      const filtered = auth.listCredentials('phi-test-provider')
      assert.deepEqual(all, filtered)
      assert.equal(all.length, 1)
      assert.match(all[0].id, /^\d+$/)
      assert.deepEqual(
        { providerId: all[0].providerId, type: all[0].type, label: all[0].label },
        {
          providerId: 'phi-test-provider',
          type: 'api_key',
          label: 'phi-test-provider'
        }
      )
      assert.equal(storage.listStoredCredentials('phi-test-provider')[0].credential.source, 'login')

      const status = auth.credentialStatus('phi-test-provider')
      assert.equal(status.available, true)
      assert.equal(status.origin, 'stored')
      assert.equal(status.label, storage.describeCredentialSource('phi-test-provider'))
    } else if (scenario === 'replace-and-clear') {
      await storage.set('search-auth', [
        oauthCredential({ email: 'person@example.com' }),
        { type: 'api_key', key: 'old-key' }
      ])
      assert.equal(auth.hasOAuth('search-auth'), true)

      await auth.replaceApiKey('search-auth', '  replacement-key  ')
      const replaced = storage.listStoredCredentials('search-auth')
      assert.equal(replaced.filter((entry) => entry.credential.type === 'oauth').length, 1)
      assert.equal(
        auth.listCredentials('search-auth').find((entry) => entry.type === 'oauth')?.label,
        'person@example.com'
      )
      const apiKeys = replaced.filter((entry) => entry.credential.type === 'api_key')
      assert.equal(apiKeys.length, 1)
      assert.equal(apiKeys[0].credential.key, 'replacement-key')

      await auth.clearApiKeys('search-auth')
      assert.deepEqual(
        storage.listStoredCredentials('search-auth').map((entry) => entry.credential.type),
        ['oauth']
      )
      assert.equal(auth.hasOAuth('search-auth'), true)
    } else if (scenario === 'environment') {
      const previous = process.env.JINA_API_KEY
      delete process.env.JINA_API_KEY
      try {
        assert.equal(auth.isFromEnvironment('jina'), false)
        process.env.JINA_API_KEY = 'environment-key'
        assert.equal(auth.isFromEnvironment('jina'), true)
      } finally {
        if (previous === undefined) delete process.env.JINA_API_KEY
        else process.env.JINA_API_KEY = previous
      }
    } else if (scenario === 'logout') {
      await auth.setApiKey('phi-logout-provider', 'secret-key')
      assert.equal(auth.listCredentials('phi-logout-provider').length, 1)

      await auth.logout('phi-logout-provider')
      assert.deepEqual(auth.listCredentials('phi-logout-provider'), [])
    } else if (scenario === 'mcp-oauth') {
      const oauthUrl = 'https://oauth.example.test/mcp?tenant=one'
      const credential = oauthCredential({
        tokenUrl: 'https://oauth.example.test/token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        resource: oauthUrl,
        authorizationUrl: 'https://oauth.example.test/authorize'
      })

      assert.equal(auth.hasMcpOAuth(oauthUrl), false)
      assert.equal(auth.hasMcpOAuthToken(oauthUrl), false)
      await auth.setMcpOAuth(oauthUrl, credential)
      assert.equal(auth.hasMcpOAuth(oauthUrl), true)
      assert.equal(auth.hasMcpOAuthToken(oauthUrl), true)

      const nonOAuthUrl = 'https://api-key.example.test/mcp'
      const { mcpOAuthCredentialId } = (await import(MCP_OAUTH_PACKAGE)) as {
        mcpOAuthCredentialId(url: string): string
      }
      await storage.set(mcpOAuthCredentialId(nonOAuthUrl), {
        type: 'api_key',
        key: 'not-an-oauth-token'
      })
      assert.equal(auth.hasMcpOAuth(nonOAuthUrl), true)
      assert.equal(auth.hasMcpOAuthToken(nonOAuthUrl), false)
    } else {
      throw new Error(`Unknown PhiAuth test scenario: ${scenario}`)
    }
  } finally {
    storage.close()
  }

  process.stdout.write(`phi-auth:${scenario}:ok\n`)
}

if (childScenario) {
  await executeChildScenario(childScenario)
} else {
  test('setApiKey is reflected by credential listing and provider status', async () => {
    await runBunScenario('set-and-status')
  })

  test('replaceApiKey preserves OAuth, trims the replacement, and clearApiKeys removes only API keys', async () => {
    await runBunScenario('replace-and-clear')
  })

  test('isFromEnvironment reflects the provider environment variable', async () => {
    await runBunScenario('environment')
  })

  test('logout removes all credentials for the provider', async () => {
    await runBunScenario('logout')
  })

  test('MCP OAuth presence and token checks round trip through the URL-keyed credential', async () => {
    await runBunScenario('mcp-oauth')
  })

  test('login maps every callback and returns manual-code and prompt values to OMP', async () => {
    await runBunScenario('login', false)
  })
}
