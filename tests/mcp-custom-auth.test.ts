import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import type { RemoteMcpConnectorOptions } from '../src/shared/mcpConnectorCatalog'
import * as promptTarget from '../src/preload/promptTarget'
import {
  addRemoteMcpConnector,
  readCustomRemoteMcpConnector
} from '../src/main/agent/mcp-connectors'

type FlowConfig = {
  authorizationUrl: string
  tokenUrl: string
  clientId?: string
  clientSecret?: string
}
type FlowController = { onAuth: (input: { url: string }) => void; signal?: AbortSignal }
type Flow = {
  generateAuthUrl: (state: string, redirectUri: string) => Promise<{ url: string }>
  exchangeToken: (code: string, state: string, redirectUri: string) => Promise<unknown>
}

function loadSource(
  path: string,
  require: (specifier: string) => unknown
): Record<string, unknown> {
  const source = ts.transpileModule(readFileSync(resolve(path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports: Record<string, unknown> = {}
  new Function('require', 'exports', source)(require, exports)
  return exports
}

function actualSdkOAuthFlow(): unknown {
  class CallbackFlow {
    constructor(readonly ctrl: FlowController) {}
    async login(): Promise<unknown> {
      const flow = this as unknown as Flow
      const redirect = 'http://127.0.0.1:1234/callback'
      const { url } = await flow.generateAuthUrl('state', redirect)
      this.ctrl.onAuth({ url })
      return flow.exchangeToken('test-code', 'state', redirect)
    }
  }
  return loadSource('node_modules/@oh-my-pi/pi-coding-agent/src/mcp/oauth-flow.ts', (specifier) => {
    if (specifier === '@oh-my-pi/pi-ai/oauth/callback-server')
      return { OAuthCallbackFlow: CallbackFlow }
    if (specifier === '@oh-my-pi/pi-utils/dirs') return { getActiveProfile: () => undefined }
    if (specifier === './oauth-discovery') return { buildWellKnownUrls: () => [] }
    throw new Error(`Unexpected SDK dependency: ${specifier}`)
  }).MCPOAuthFlow
}

test('saved client fields reach the installed SDK authorization and token exchange, and refresh storage', async (t) => {
  const requests: Array<{ url: string; body: string }> = []
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    requests.push({ url: input, body: String(init?.body ?? '') })
    return new Response(
      JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
    )
  })
  const sdk = actualSdkOAuthFlow()
  const endpoints = {
    authorizationUrl: 'https://auth.example.test/authorize',
    tokenUrl: 'https://auth.example.test/token',
    clientId: 'metadata-client',
    registrationUrl: 'https://auth.example.test/register'
  }
  const flowConfigs: FlowConfig[] = []
  let discoveryCalls = 0
  const module = loadSource('src/main/agent/omp/featured-mcp-auth.ts', (specifier) => {
    if (specifier === '@oh-my-pi/pi-coding-agent/mcp/oauth-discovery')
      return {
        discoverOAuthEndpoints: async () => {
          discoveryCalls += 1
          return endpoints
        }
      }
    if (specifier === '@oh-my-pi/pi-coding-agent/mcp/oauth-flow') {
      const ActualFlow = sdk as new (config: FlowConfig, controller: FlowController) => object
      return {
        MCPOAuthFlow: class extends ActualFlow {
          constructor(config: FlowConfig, controller: FlowController) {
            super(config, controller)
            flowConfigs.push(config)
          }
        },
        mcpOAuthCredentialId: (url: string) => `mcp_oauth:${url}`
      }
    }
    if (specifier === '@oh-my-pi/pi-coding-agent/mcp/client') return {}
    if (specifier === '@oh-my-pi/pi-coding-agent/mcp/manager') return {}
    if (specifier === '../mcp-key-credentials') return { API_KEY_CONNECTOR_IDS: [] }
    throw new Error(`Unexpected auth dependency: ${specifier}`)
  })
  const authorize = module.authorizeFeaturedMcp as (
    url: string,
    storage: { set: (id: string, credential: Record<string, unknown>) => Promise<void> },
    open: (url: string) => Promise<void>,
    signal?: AbortSignal,
    oauth?: RemoteMcpConnectorOptions['oauth'],
    prepared?: FlowConfig,
    beforeStore?: () => void
  ) => Promise<void>
  const stored: Array<{ id: string; credential: Record<string, unknown> }> = []
  const opened: string[] = []
  await authorize(
    'https://mcp.example.test/mcp',
    {
      set: async (id, credential) => {
        stored.push({ id, credential })
      }
    },
    async (url) => {
      opened.push(url)
    },
    undefined,
    {
      clientId: 'configured-client',
      clientSecret: 'configured-secret'
    },
    endpoints
  )
  assert.equal(discoveryCalls, 0)
  assert.equal(flowConfigs[0].clientId, 'configured-client')
  assert.equal(new URL(opened[0]).searchParams.get('client_id'), 'configured-client')
  assert.equal(opened[0].includes('configured-secret'), false)
  assert.deepEqual(
    requests.map((request) => request.url),
    ['https://auth.example.test/token']
  )
  const token = new URLSearchParams(requests[0].body)
  assert.equal(token.get('client_id'), 'configured-client')
  assert.equal(token.get('client_secret'), 'configured-secret')
  assert.equal(token.get('grant_type'), 'authorization_code')
  assert.equal(stored[0].id, 'mcp_oauth:https://mcp.example.test/mcp')
  assert.equal(stored[0].credential.clientId, 'configured-client')
  assert.equal(stored[0].credential.clientSecret, 'configured-secret')
  assert.equal(stored[0].credential.tokenUrl, 'https://auth.example.test/token')
  assert.equal(stored[0].credential.refresh, 'refresh')

  await authorize(
    'https://public.example.test/mcp',
    {
      set: async (id, credential) => {
        stored.push({ id, credential })
      }
    },
    async (url) => {
      opened.push(url)
    }
  )
  assert.equal(new URL(opened[1]).searchParams.get('client_id'), 'metadata-client')
  assert.equal(new URLSearchParams(requests[1].body).has('client_secret'), false)
  assert.equal(stored[1].credential.clientId, 'metadata-client')
  assert.equal(stored[1].credential.clientSecret, undefined)
  assert.equal(discoveryCalls, 1)
  await assert.rejects(
    authorize(
      'https://mcp.example.test/mcp',
      {
        set: async (id, credential) => {
          stored.push({ id, credential })
        }
      },
      async () => undefined,
      undefined,
      { clientId: 'configured-client', clientSecret: 'configured-secret' },
      endpoints,
      () => {
        throw new Error('连接器配置已变化，请重新授权')
      }
    ),
    /配置已变化/
  )
  assert.equal(stored.length, 2)
  const secret = 'private"secret+&/'
  for (const echo of [secret, encodeURIComponent(secret), JSON.stringify(secret)]) {
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(JSON.stringify({ error_description: echo }), { status: 401 })
    )
    await assert.rejects(
      authorize(
        'https://mcp.example.test/mcp',
        {
          set: async (id, credential) => {
            stored.push({ id, credential })
          }
        },
        async () => undefined,
        undefined,
        { clientId: 'configured-client', clientSecret: secret },
        endpoints
      ),
      (error: Error) => {
        assert.equal(error.message, '连接器授权失败，请检查客户端信息并重试')
        assert.equal(error.message.includes(echo), false)
        assert.equal(error.stack?.includes(echo), false)
        assert.equal(error.cause, undefined)
        return true
      }
    )
  }
  assert.equal(stored.length, 2)
})

test('preload preserves optional connector authentication fields across IPC', async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const exposed = new Map<string, unknown>()
  class IpcRenderer extends EventEmitter {
    async invoke(channel: string, ...args: unknown[]): Promise<void> {
      calls.push({ channel, args })
    }
  }
  const compiled = ts.transpileModule(readFileSync(resolve('src/preload/index.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const ipcRenderer = new IpcRenderer()
  new Function('require', 'exports', 'process', 'window', 'console', compiled)(
    (specifier: string) => {
      if (specifier === './promptTarget') return promptTarget
      assert.equal(specifier, 'electron')
      return {
        contextBridge: {
          exposeInMainWorld: (key: string, value: unknown) => exposed.set(key, value)
        },
        ipcRenderer,
        webUtils: { getPathForFile: () => '' }
      }
    },
    {},
    { contextIsolated: true, platform: 'darwin', env: {} },
    { addEventListener: () => undefined },
    console
  )
  const api = exposed.get('api') as {
    addRemoteMcpConnector: (
      name: string,
      url: string,
      options?: RemoteMcpConnectorOptions
    ) => Promise<void>
    authorizeRemoteMcpConnector: (name: string) => Promise<void>
    cancelRemoteMcpAuth: (name: string) => Promise<void>
  }
  const options = { oauth: { clientId: 'client', clientSecret: 'secret' } }
  await api.addRemoteMcpConnector('custom', 'https://example.test/mcp', options)
  await api.addRemoteMcpConnector('public', 'https://public.test/mcp')
  await api.authorizeRemoteMcpConnector('custom')
  await api.cancelRemoteMcpAuth('custom')
  assert.deepEqual(calls, [
    { channel: 'mcp:addRemoteConnector', args: ['custom', 'https://example.test/mcp', options] },
    { channel: 'mcp:addRemoteConnector', args: ['public', 'https://public.test/mcp', undefined] },
    { channel: 'mcp:authorizeRemoteConnector', args: ['custom'] },
    { channel: 'mcp:cancelRemoteAuth', args: ['custom'] }
  ])
})

test('custom OAuth discovery permits only secure endpoints and does not echo provider errors', async () => {
  let result: { authorizationUrl: string; tokenUrl: string } | null = null
  let failure: Error | undefined
  const module = loadSource('src/main/agent/omp/featured-mcp-auth.ts', (specifier) => {
    if (specifier === '@oh-my-pi/pi-coding-agent/mcp/oauth-discovery') {
      return {
        discoverOAuthEndpoints: async () => {
          if (failure) throw failure
          return result
        }
      }
    }
    return {}
  })
  const discover = module.discoverCustomMcpOAuthEndpoints as (
    url: string,
    signal?: AbortSignal
  ) => Promise<unknown>
  for (const endpoints of [
    null,
    { authorizationUrl: 'http://auth.test/authorize', tokenUrl: 'https://auth.test/token' },
    { authorizationUrl: 'https://auth.test/authorize', tokenUrl: 'http://auth.test/token' },
    {
      authorizationUrl: 'https://user:pass@auth.test/authorize',
      tokenUrl: 'https://auth.test/token'
    }
  ]) {
    result = endpoints
    await assert.rejects(discover('https://server.test/mcp'), /HTTPS OAuth/)
  }
  failure = new Error('private-client-secret')
  await assert.rejects(discover('https://server.test/mcp'), (error: Error) => {
    assert.equal(error.message.includes('private-client-secret'), false)
    return /HTTPS OAuth/.test(error.message)
  })
  failure = undefined
  result = { authorizationUrl: 'https://auth.test/authorize', tokenUrl: 'https://auth.test/token' }
  assert.deepEqual(await discover('https://server.test/mcp'), result)
  const cancel = new AbortController()
  cancel.abort('授权已取消')
  await assert.rejects(discover('https://server.test/mcp', cancel.signal), /授权已取消/)
})

function customWorkerRpc(
  dependencies: Record<string, unknown>
): (method: string, params: unknown) => Promise<unknown> {
  const source = ts.createSourceFile(
    'worker.ts',
    readFileSync(resolve('src/main/agent/omp/omp-sdk-worker.ts'), 'utf8'),
    ts.ScriptTarget.ES2022,
    true
  )
  const handler = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'handleRequest'
  )
  const dispatch = handler?.body?.statements.find(ts.isSwitchStatement)
  assert.ok(dispatch)
  const clauses = dispatch.caseBlock.clauses.filter(
    (clause) =>
      ts.isCaseClause(clause) &&
      ts.isStringLiteral(clause.expression) &&
      ['mcp.prepareRemoteAuth', 'mcp.authorizeRemote', 'mcp.cancelRemoteAuth'].includes(
        clause.expression.text
      )
  )
  assert.equal(clauses.length, 3)
  const body = `const { readCustomRemoteMcpConnector, discoverCustomMcpOAuthEndpoints, authorizeFeaturedMcp, getContext, requestHost } = dependencies;
  const pendingCustomMcpAuth = new Map();
  const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
  const stringValue = (value) => typeof value === 'string' ? value : '';
  return async function(method, params) { switch (method) { ${clauses.map((clause) => clause.getText(source)).join('\n')} } }`
  const compiled = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function('dependencies', compiled)(dependencies)
}

test('worker custom OAuth RPC reaches the helper with exact saved credentials and pinned endpoints', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-worker-custom-auth-'))
  try {
    const url = 'https://example.test/mcp'
    const oauth = { clientId: 'client', clientSecret: 'private-secret' }
    addRemoteMcpConnector('custom', url, agentDir, { oauth })
    const endpoints = {
      authorizationUrl: 'https://auth.test/authorize',
      tokenUrl: 'https://auth.test/token'
    }
    const hostRequests: Array<{ method: string; params: unknown }> = []
    let authorized = false
    const rpc = customWorkerRpc({
      readCustomRemoteMcpConnector: (name: string) => readCustomRemoteMcpConnector(name, agentDir),
      discoverCustomMcpOAuthEndpoints: async (savedUrl: string) => {
        assert.equal(savedUrl, url)
        return endpoints
      },
      getContext: async () => ({ authStorage: 'private-store' }),
      requestHost: async (method: string, params: unknown) => {
        hostRequests.push({ method, params })
      },
      authorizeFeaturedMcp: async (
        savedUrl: string,
        storage: string,
        open: (url: string) => Promise<void>,
        signal: AbortSignal,
        credentials: unknown,
        prepared: unknown,
        beforeStore: () => void
      ) => {
        assert.equal(savedUrl, url)
        assert.equal(storage, 'private-store')
        assert.equal(signal.aborted, false)
        assert.deepEqual(credentials, oauth)
        assert.equal(prepared, endpoints)
        await open('https://auth.test/authorize?state=state')
        beforeStore()
        authorized = true
      }
    })
    const request = { name: 'custom', attemptId: 'attempt-1' }
    assert.deepEqual(await rpc('mcp.prepareRemoteAuth', request), {
      serverUrl: url,
      authorizationUrl: endpoints.authorizationUrl
    })
    await rpc('mcp.authorizeRemote', { ...request, serverUrl: url })
    assert.equal(authorized, true)
    assert.deepEqual(hostRequests, [
      {
        method: 'mcp.openCustomAuthUrl',
        params: { ...request, url: 'https://auth.test/authorize?state=state' }
      }
    ])
    assert.equal(JSON.stringify(hostRequests).includes('private-secret'), false)
    await assert.rejects(rpc('mcp.authorizeRemote', { ...request, serverUrl: url }), /已失效/)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('worker custom OAuth cancellation aborts discovery and expires the attempt', async () => {
  let started!: () => void
  const discoveryStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  let authorized = false
  const rpc = customWorkerRpc({
    readCustomRemoteMcpConnector: () => ({
      name: 'custom',
      url: 'https://example.test/mcp',
      oauth: { clientId: 'client' }
    }),
    discoverCustomMcpOAuthEndpoints: async (_url: string, signal: AbortSignal) => {
      started()
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('授权已取消')), { once: true })
      )
    },
    authorizeFeaturedMcp: async () => {
      authorized = true
    }
  })
  const request = { name: 'custom', attemptId: 'attempt-1' }
  const preparing = rpc('mcp.prepareRemoteAuth', request)
  await discoveryStarted
  await rpc('mcp.cancelRemoteAuth', request)
  await assert.rejects(preparing, /授权已取消/)
  await assert.rejects(
    rpc('mcp.authorizeRemote', { ...request, serverUrl: 'https://example.test/mcp' }),
    /已失效/
  )
  assert.equal(authorized, false)
})
