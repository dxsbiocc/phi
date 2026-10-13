import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { startGatewayFixtureProvider } from './model-gateway-sdk-provider'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import type {
  CreateModelGatewayLeaseParams,
  ModelGatewayLease
} from '../../src/main/agent/engine/model-gateway-types'

export const MODEL_GATEWAY_FIXTURE_REFS = {
  key: { provider: 'phi-fixture-key', id: 'key-model' },
  none: { provider: 'phi-fixture-none', id: 'none-model' },
  oauth: { provider: 'phi-fixture-oauth', id: 'oauth-model' },
  rotate: { provider: 'phi-fixture-rotate', id: 'rotate-model' },
  command: { provider: 'phi-fixture-command', id: 'command-model' },
  scopeA: { provider: 'phi-fixture-scope', id: 'scope-a' },
  scopeB: { provider: 'phi-fixture-scope', id: 'scope-b' }
} as const
export const MODEL_GATEWAY_FIXTURE_SECRETS = {
  key: 'fixture-desktop-key-secret',
  replacement: 'fixture-replaced-key-secret',
  refresh: 'fixture-oauth-refresh-secret',
  firstRotation: 'fixture-rotation-first-secret',
  nextRotation: 'fixture-rotation-next-secret',
  scope: 'fixture-scope-key-secret',
  command: 'fixture-command-key-secret',
  error: 'fixture-provider-error-secret',
  context: 'fixture-private-context-sentinel'
} as const
export interface GatewayFixtureReply {
  textChunkChars?: number
  finishReason?: string
  text?: string
  thinking?: string
  tool?: { name: string; args: Record<string, unknown>; id?: string }
  hold?: boolean
  status?: number
  error?: string
  redirect?: string
}
export interface GatewayFixtureSnapshot {
  gateway: { leases: number; activeRequests: number }
  authCalls: number
  commandCalls: number
  registryCalls: number
  authSignalAborts: number
  refreshCalls: number
  invalidationCalls: number
  authScopes: Array<{
    provider: string
    sessionId?: string
    modelId?: string
    baseUrl?: string
    forceRefresh?: boolean
    refreshReason?: string
    signalAborted: boolean
  }>
  providerRequests: Array<{
    path: string
    headers: Record<string, string | string[] | undefined>
    body: Record<string, unknown>
  }>
  activeProviderStreams: number
  debugEnabled: boolean
  rawLogFiles: string[]
  logSentinels: { credential: boolean; gatewayBearer: boolean; context: boolean }
}
export interface ModelGatewaySdkFixture {
  root: string
  cwd: string
  agentDir: string
  create(params: CreateModelGatewayLeaseParams): Promise<ModelGatewayLease>
  revoke(leaseId: string): Promise<void>
  enqueue(...replies: GatewayFixtureReply[]): Promise<void>
  snapshot(): Promise<GatewayFixtureSnapshot>
  resetStats(): Promise<void>
  replaceStore(): Promise<void>
  stderr(): string
  close(): Promise<void>
}

/** Bun owns the real SDK/storage; the Node test sees only a private typed protocol. */
export async function startModelGatewaySdkFixture(
  options: {
    debug?: boolean
    oauthExpired?: boolean
    https?: boolean
    streamLimits?: { maxEventBytes: number; maxQueuedBytes: number; maxQueuedEvents: number }
  } = {}
): Promise<ModelGatewaySdkFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-model-gateway-sdk-')))
  const cwd = join(root, 'project')
  const home = join(root, 'home')
  const agentDir = join(root, 'agent')
  for (const path of [cwd, home, agentDir, join(root, 'tmp')]) await mkdir(path, { mode: 0o700 })
  const certificate = join(root, 'fixture-cert.pem')
  if (options.https) {
    try {
      await promisify(execFile)(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          join(root, 'fixture-key.pem'),
          '-out',
          certificate,
          '-days',
          '1',
          '-subj',
          '/CN=PhiPrivateFixture',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
          '-addext',
          'basicConstraints=critical,CA:TRUE'
        ],
        { cwd: root, maxBuffer: 8192 }
      )
      await chmod(certificate, 0o600)
      await chmod(join(root, 'fixture-key.pem'), 0o600)
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }
  const provider = await startGatewayFixtureProvider({
    errorSentinel: MODEL_GATEWAY_FIXTURE_SECRETS.error,
    ...(options.https ? { certificate, key: join(root, 'fixture-key.pem') } : {})
  }).catch(async (error) => {
    await rm(root, { recursive: true, force: true })
    throw error
  })
  const child = spawn(
    resolveBunExecutable(),
    [fileURLToPath(new URL('./model-gateway-sdk-child.ts', import.meta.url))],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: join(root, 'tmp'),
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_CACHE_HOME: join(home, '.cache'),
        XDG_DATA_HOME: join(home, '.local/share'),
        PI_CODING_AGENT_DIR: agentDir,
        PHI_GATEWAY_FIXTURE_ROOT: root,
        PHI_GATEWAY_FIXTURE_PROVIDER_URL: provider.url,
        PHI_GATEWAY_FIXTURE_STREAM_LIMITS: options.streamLimits
          ? JSON.stringify(options.streamLimits)
          : '',
        PHI_GATEWAY_FIXTURE_OAUTH_VALID: options.oauthExpired === false ? '1' : '',
        ...(options.https
          ? { PHI_GATEWAY_FIXTURE_HTTPS: '1', NODE_EXTRA_CA_CERTS: certificate }
          : {}),
        ...(options.debug ? { PI_REQ_DEBUG: '1' } : {}),
        OMP_AUTH_BROKER_URL: '',
        OMP_AUTH_BROKER_TOKEN: ''
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >()
  let sequence = 0
  let stderr = ''
  let closed = false
  let closePromise: Promise<void> | undefined
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-32_768)
  })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  const fail = (error: Error): void => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    pending.clear()
  }
  child.once('error', fail)
  child.once('exit', (code) => {
    closed = true
    fail(new Error(`SDK fixture child exited (${code}): ${stderr}`))
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    try {
      const response = JSON.parse(line) as {
        id?: string
        ok?: boolean
        result?: unknown
        error?: string
      }
      if (!response.id || typeof response.ok !== 'boolean') throw new Error('Invalid fixture frame')
      const item = pending.get(response.id)
      if (!item) throw new Error('Unexpected fixture response')
      pending.delete(response.id)
      clearTimeout(item.timer)
      if (response.ok) item.resolve(response.result)
      else item.reject(new Error(response.error || 'SDK fixture command failed'))
    } catch {
      fail(new Error('SDK fixture emitted an invalid protocol frame'))
      child.kill()
    }
  })
  const command = <T>(method: string, params?: unknown): Promise<T> => {
    if (closed) return Promise.reject(new Error('SDK fixture child is closed'))
    const id = String(++sequence)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`SDK fixture ${method} timed out`))
        child.kill()
      }, 15_000)
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error)
        }
      })
    })
  }
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        if (!closed) await command('close')
        child.stdin.end()
        const timer = setTimeout(() => child.kill(), 5_000)
        const code = await exited
        clearTimeout(timer)
        if (code !== 0) throw new Error(`SDK fixture did not exit naturally (${code}): ${stderr}`)
      } catch (error) {
        if (!closed) child.kill()
        await exited
        throw error
      } finally {
        lines.close()
        await provider.close()
        await rm(root, { recursive: true, force: true })
      }
    })()
    return closePromise
  }
  try {
    await command('snapshot')
  } catch (error) {
    child.kill()
    await exited
    await provider.close()
    await rm(root, { recursive: true, force: true })
    throw error
  }
  return {
    root,
    cwd,
    agentDir,
    create: (params) => command('create', params),
    revoke: (leaseId) => command('revoke', { leaseId }),
    enqueue: async (...replies) => {
      provider.enqueue(...replies)
    },
    snapshot: async () => ({
      ...(await command<GatewayFixtureSnapshot>('snapshot')),
      ...provider.snapshot()
    }),
    resetStats: async () => {
      await command('resetStats')
      provider.resetStats()
    },
    replaceStore: () => command('replaceStore'),
    stderr: () => stderr,
    close
  }
}
