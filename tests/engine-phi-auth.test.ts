import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import type { PhiMcpOAuthCredential } from '../src/main/agent/engine/types'

const execFileAsync = promisify(execFile)
const testFile = fileURLToPath(import.meta.url)
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
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'phi-auth-'))
  try {
    const result = await execFileAsync('bun', [testFile], {
      cwd: fixtureRoot,
      env: {
        PATH: process.env.PATH,
        HOME: fixtureRoot,
        USERPROFILE: fixtureRoot,
        XDG_CONFIG_HOME: join(fixtureRoot, '.config'),
        XDG_CACHE_HOME: join(fixtureRoot, '.cache'),
        XDG_DATA_HOME: join(fixtureRoot, '.local/share'),
        PI_CODING_AGENT_DIR: fixtureRoot,
        PHI_AUTH_BUN_SCENARIO: scenario,
        ...(realStorage ? { PHI_AUTH_AGENT_DIR: fixtureRoot } : {}),
        OMP_AUTH_BROKER_URL: '',
        OMP_AUTH_BROKER_TOKEN: ''
      },
      maxBuffer: 1024 * 1024
    })
    assert.match(result.stdout, new RegExp(`phi-auth:${scenario}:ok`))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}

async function executeChildScenario(scenario: string): Promise<void> {
  const { createPhiAuth } = await import('../src/main/agent/engine/in-process/auth')

  if (scenario === 'login' || scenario === 'login-abort') {
    const controller = new AbortController()
    const signal = controller.signal
    const abortError = new Error('Login aborted')
    const observed = {
      providerId: '',
      signal: undefined as AbortSignal | undefined,
      manualCode: '',
      promptValues: [] as string[]
    }
    const storage = {
      oauth: {
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
          if (scenario === 'login-abort') {
            return new Promise<never>((_resolve, reject) => {
              callbacks.signal?.addEventListener('abort', () => reject(callbacks.signal?.reason), {
                once: true
              })
              controller.abort(abortError)
            })
          }
          callbacks.onAuth({
            url: 'https://long.example.test/authorize?full=true',
            launchUrl: 'http://127.0.0.1/launch',
            instructions: 'Open the browser'
          })
          callbacks.onAuth({ url: 'https://fallback.example.test/authorize' })
          callbacks.onProgress('Waiting for authorization')
          observed.manualCode = await callbacks.onManualCodeInput()
          observed.promptValues.push(
            await callbacks.onPrompt({ message: 'Account', placeholder: 'name@example.com' })
          )
          observed.promptValues.push(await callbacks.onPrompt({ message: 'One-time code' }))
          return { email: 'logged-in@example.com' }
        }
      }
    }
    const auth = createPhiAuth(storage as never)
    const authEvents: Array<{ url: string; instructions?: string }> = []
    const progress: string[] = []
    const prompts: Array<{ message: string; placeholder?: string }> = []

    const login = auth.login('oauth-provider', {
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

    if (scenario === 'login-abort') {
      await assert.rejects(login, (error) => error === abortError)
      assert.strictEqual(observed.signal, signal)
      assert.equal(signal.aborted, true)
      assert.deepEqual(authEvents, [])
      process.stdout.write(`phi-auth:${scenario}:ok\n`)
      return
    }

    assert.equal(await login, undefined)
    assert.equal(observed.providerId, 'oauth-provider')
    assert.strictEqual(observed.signal, signal)
    assert.deepEqual(authEvents, [
      { url: 'http://127.0.0.1/launch', instructions: 'Open the browser' },
      { url: 'https://fallback.example.test/authorize' }
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
    discoverAuthStorage(
      agentDir: string,
      options: { cwd: string }
    ): Promise<{
      close(): void
      keys: {
        describe(providerId: string): string | undefined
        setRuntime(providerId: string, key: string): void
        removeRuntime(providerId: string): void
        setConfig(providerId: string, key: string): void
        removeConfig(providerId: string): void
      }
      credentials: {
        get(providerId: string): unknown
        list(providerId?: string): Array<{
          id: number
          provider: string
          credential: Record<string, unknown> & { type: 'api_key' | 'oauth' }
        }>
        set(providerId: string, credential: unknown): Promise<void>
      }
    }>
  }
  const storage = await discoverAuthStorage(agentDir, { cwd: agentDir })
  const auth = createPhiAuth(storage as never)

  try {
    if (scenario === 'set-and-status') {
      assert.deepEqual(auth.listCredentials(), [])
      assert.deepEqual(auth.credentialStatus('phi-test-provider'), {
        available: false,
        origin: undefined,
        label: undefined
      })
      assert.equal(auth.hasOAuth('phi-test-provider'), false)
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
      assert.equal(storage.credentials.list('phi-test-provider')[0].credential.source, 'login')

      const status = auth.credentialStatus('phi-test-provider')
      assert.equal(status.available, true)
      assert.equal(status.origin, 'stored')
      assert.equal(status.label, storage.keys.describe('phi-test-provider'))
      assert.equal(auth.hasOAuth('phi-test-provider'), false)
      assert.deepEqual(auth.listCredentials('missing-provider'), [])
    } else if (scenario === 'replace-and-clear') {
      await storage.credentials.set('search-auth', [
        oauthCredential({ email: 'person@example.com' }),
        oauthCredential({ accountId: 'second-account', access: 'second-access' }),
        { type: 'api_key', key: 'old-key' },
        { type: 'api_key', key: 'another-old-key' }
      ])
      assert.equal(auth.hasOAuth('search-auth'), true)
      const oauthBefore = storage.credentials
        .list('search-auth')
        .filter((entry) => entry.credential.type === 'oauth')
        .map((entry) => entry.credential)

      await auth.replaceApiKey('search-auth', '  replacement-key  ')
      const replaced = storage.credentials.list('search-auth')
      assert.deepEqual(
        replaced
          .filter((entry) => entry.credential.type === 'oauth')
          .map((entry) => entry.credential),
        oauthBefore
      )
      assert.equal(
        auth.listCredentials('search-auth').find((entry) => entry.type === 'oauth')?.label,
        'person@example.com'
      )
      const apiKeys = replaced.filter((entry) => entry.credential.type === 'api_key')
      assert.equal(apiKeys.length, 1)
      assert.equal(apiKeys[0].credential.key, 'replacement-key')

      await auth.clearApiKeys('search-auth')
      assert.deepEqual(
        storage.credentials.list('search-auth').map((entry) => entry.credential),
        oauthBefore
      )
      assert.equal(auth.hasOAuth('search-auth'), true)
      assert.equal(auth.credentialStatus('search-auth').available, true)
      assert.equal(auth.credentialStatus('search-auth').origin, 'stored')
      await auth.clearApiKeys('search-auth')
      await auth.clearApiKeys('missing-provider')
      await auth.replaceApiKey('key-only', '  only-key  ')
      assert.equal(storage.credentials.list('key-only')[0].credential.key, 'only-key')
      await auth.clearApiKeys('key-only')
      assert.deepEqual(auth.listCredentials('key-only'), [])
      assert.equal(auth.credentialStatus('key-only').available, false)
    } else if (scenario === 'environment') {
      const previous = process.env.JINA_API_KEY
      delete process.env.JINA_API_KEY
      try {
        assert.equal(auth.isFromEnvironment('jina'), false)
        assert.equal(auth.credentialStatus('jina').available, false)
        process.env.JINA_API_KEY = 'environment-key'
        assert.equal(auth.isFromEnvironment('jina'), true)
        assert.deepEqual(auth.credentialStatus('jina'), {
          available: true,
          origin: 'environment',
          label: storage.keys.describe('jina')
        })
        storage.keys.setConfig('jina', 'configured-key')
        assert.equal(auth.isFromEnvironment('jina'), false)
        assert.deepEqual(auth.credentialStatus('jina'), {
          available: true,
          origin: 'models_json_key',
          label: storage.keys.describe('jina')
        })
        storage.keys.setRuntime('jina', 'runtime-key')
        assert.deepEqual(auth.credentialStatus('jina'), {
          available: true,
          origin: 'runtime',
          label: storage.keys.describe('jina')
        })
        storage.keys.removeRuntime('jina')
        storage.keys.removeConfig('jina')
        assert.equal(auth.isFromEnvironment('jina'), true)

        process.env.XAI_API_KEY = 'borrowed-api-key'
        assert.equal(auth.isFromEnvironment('xai-oauth'), false)
        assert.equal(auth.credentialStatus('xai-oauth').available, false)
        delete process.env.XAI_API_KEY

        process.env.AWS_ACCESS_KEY_ID = 'phi-fixture-aws-id'
        process.env.AWS_SECRET_ACCESS_KEY = 'phi-fixture-aws-secret'
        assert.equal(auth.credentialStatus('amazon-bedrock').available, true)
        assert.equal(auth.credentialStatus('amazon-bedrock').origin, 'environment')
        delete process.env.AWS_ACCESS_KEY_ID
        delete process.env.AWS_SECRET_ACCESS_KEY
      } finally {
        if (previous === undefined) delete process.env.JINA_API_KEY
        else process.env.JINA_API_KEY = previous
      }
    } else if (scenario === 'logout') {
      await auth.setApiKey('phi-logout-provider', 'secret-key')
      assert.equal(auth.listCredentials('phi-logout-provider').length, 1)

      await auth.logout('phi-logout-provider')
      assert.deepEqual(auth.listCredentials('phi-logout-provider'), [])
      assert.deepEqual(auth.credentialStatus('phi-logout-provider'), {
        available: false,
        origin: undefined,
        label: undefined
      })
      await storage.credentials.set('phi-logout-provider', [
        oauthCredential({ accountId: 'logout-account' }),
        { type: 'api_key', key: 'logout-api-key' }
      ])
      await auth.logout('phi-logout-provider')
      assert.deepEqual(auth.listCredentials('phi-logout-provider'), [])
      assert.equal(auth.hasOAuth('phi-logout-provider'), false)
      await auth.logout('missing-provider')
    } else if (scenario === 'oauth-labels') {
      await storage.credentials.set(
        'phi-email',
        oauthCredential({
          email: 'person@example.com',
          accountId: 'account-with-email'
        })
      )
      await storage.credentials.set('phi-account', oauthCredential({ accountId: 'account-only' }))
      await storage.credentials.set('phi-anonymous', oauthCredential())
      assert.deepEqual(
        auth.listCredentials().map(({ providerId, label }) => ({ providerId, label })),
        [
          { providerId: 'phi-email', label: 'person@example.com' },
          { providerId: 'phi-account', label: 'account-only' },
          { providerId: 'phi-anonymous', label: 'phi-anonymous' }
        ]
      )
      assert.equal(auth.credentialStatus('phi-email').origin, 'stored')
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
      assert.equal(auth.hasMcpOAuth('https://oauth.example.test/mcp?tenant=two'), false)

      const nonOAuthUrl = 'https://api-key.example.test/mcp'
      const { mcpOAuthCredentialId } = (await import(MCP_OAUTH_PACKAGE)) as {
        mcpOAuthCredentialId(url: string): string
      }
      await storage.credentials.set(mcpOAuthCredentialId(nonOAuthUrl), {
        type: 'api_key',
        key: 'not-an-oauth-token'
      })
      assert.equal(auth.hasMcpOAuth(nonOAuthUrl), true)
      assert.equal(auth.hasMcpOAuthToken(nonOAuthUrl), false)
      assert.deepEqual(storage.credentials.get(mcpOAuthCredentialId(oauthUrl)), credential)
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

  test('OAuth labels prefer email, then account ID, then provider ID', async () => {
    await runBunScenario('oauth-labels')
  })

  test('MCP OAuth presence and token checks round trip through the URL-keyed credential', async () => {
    await runBunScenario('mcp-oauth')
  })

  test('login maps every callback and returns manual-code and prompt values to OMP', async () => {
    await runBunScenario('login', false)
  })

  test('login forwards the abort signal and preserves the OMP rejection', async () => {
    await runBunScenario('login-abort', false)
  })
}
