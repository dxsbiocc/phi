import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { createDesktopWebSearchAdapter } from '../../src/main/agent/engine/rpc/desktop-websearch-adapter'
import type { DesktopWebSearchAdapter } from '../../src/main/agent/engine/rpc/desktop-websearch-types'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'

export interface DesktopSearchFixture {
  root: string
  agentDir: string
  resourceCwd: string
  env: NodeJS.ProcessEnv
  identity: { runtimeSessionId: string; sessionId: string; projectId: string; cwd: string }
  endpoint: string
  requests: Array<{ url: string; headers: IncomingMessage['headers'] }>
  configure(extra?: Record<string, unknown>): Promise<void>
  sdk(mode: string, argument?: unknown): Promise<unknown>
  respond(handler: (request: IncomingMessage, response: ServerResponse) => void): void
  adapter(
    extra?: Partial<Parameters<typeof createDesktopWebSearchAdapter>[0]>
  ): Promise<DesktopWebSearchAdapter>
  call(
    adapter: DesktopWebSearchAdapter,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<import('../../src/main/agent/engine/types').PhiToolResult>
  close(): Promise<void>
}
export async function desktopWebSearchFixture(): Promise<DesktopSearchFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-search-test-')))
  const agentDir = join(root, 'agent'),
    resourceCwd = join(root, 'resources'),
    home = join(root, 'home')
  await Promise.all([agentDir, resourceCwd, home].map((path) => mkdir(path, { mode: 0o700 })))
  const requests: Array<{ url: string; headers: IncomingMessage['headers'] }> = []
  let respond = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.url!.startsWith('/config')) {
      response.end(JSON.stringify({ engines: [{ name: 'brave', shortcut: 'br' }] }))
      return
    }
    if (request.url!.startsWith('/res/'))
      response.end(
        JSON.stringify({
          web: {
            results: [
              {
                title: 'Fixture brave',
                url: 'https://example.org/brave',
                description: 'Actual SDK Brave parser'
              }
            ]
          }
        })
      )
    else
      response.end(
        JSON.stringify({
          results: [
            {
              title: 'Fixture SearxNG',
              url: 'https://example.org/search',
              content: 'Actual SDK SearxNG parser',
              engine: 'brave'
            }
          ],
          suggestions: ['next query']
        })
      )
  }
  const server = createServer((request, response) => {
    requests.push({ url: request.url!, headers: request.headers })
    response.setHeader('content-type', 'application/json')
    respond(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Search fixture address unavailable')
  const endpoint = `http://127.0.0.1:${address.port}`
  const preload = fileURLToPath(new URL('./desktopWebSearchTransport.ts', import.meta.url))
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: root,
    PI_CODING_AGENT_DIR: agentDir,
    OMP_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    PHI_TEST_SEARCH_ENDPOINT: endpoint,
    PHI_TEST_SEARCH_LEDGER: join(root, 'workers.jsonl'),
    BUN_OPTIONS: `--preload=${preload}`
  }
  const identity = {
    runtimeSessionId: 'search-runtime',
    sessionId: 'search-phi',
    projectId: 'search-project',
    cwd: '/remote/canonical-project'
  }
  const adapters: DesktopWebSearchAdapter[] = []
  async function configure(extra: Record<string, unknown> = {}): Promise<void> {
    await writeFile(
      join(agentDir, 'config.yml'),
      stringify({
        modelRoles: { web: 'web/searxng' },
        retry: { fallbackChains: { web: [] } },
        searxng: { endpoint, engines: 'br' },
        ...extra
      })
    )
  }
  async function sdk(mode: string, argument: unknown = {}): Promise<unknown> {
    const child = spawn(
      resolveBunExecutable(),
      [
        '--no-env-file',
        fileURLToPath(new URL('./desktopWebSearchSdk.ts', import.meta.url)),
        mode,
        agentDir,
        resourceCwd,
        typeof argument === 'string' ? argument : JSON.stringify(argument)
      ],
      { cwd: root, env, stdio: 'pipe' }
    )
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString()
    })
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString()
    })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    if (code !== 0) throw new Error(`Private search SDK fixture failed: ${stderr}`)
    return JSON.parse(stdout)
  }
  await configure()
  return {
    root,
    agentDir,
    resourceCwd,
    env,
    identity,
    endpoint,
    requests,
    configure,
    sdk,
    respond(handler: typeof respond) {
      respond = handler
    },
    async adapter(extra: Partial<Parameters<typeof createDesktopWebSearchAdapter>[0]> = {}) {
      const adapter = await createDesktopWebSearchAdapter({
        identity,
        agentDir,
        resourceCwd,
        env,
        currentModel: () => undefined,
        ...extra
      })
      adapters.push(adapter)
      return adapter
    },
    async call(
      adapter: DesktopWebSearchAdapter,
      params: Record<string, unknown>,
      signal?: AbortSignal
    ) {
      return adapter.tool.execute(
        'search-call',
        params,
        undefined,
        { cwd: adapter.identity.cwd, recentUserImages: () => [] },
        signal
      )
    },
    async close() {
      await Promise.all(adapters.map((adapter) => adapter.close()))
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
      await rm(root, { recursive: true, force: true })
    }
  }
}
