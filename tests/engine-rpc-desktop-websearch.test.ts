import assert from 'node:assert/strict'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { desktopWebSearchFixture } from './helpers/desktopWebSearchFixture'
import { pathToFileURL } from 'node:url'
import { resolveDesktopWebSearchWorkerPath } from '../src/main/agent/engine/rpc/desktop-websearch-adapter'
import { createRpcDesktopToolScope } from '../src/main/agent/engine/rpc/desktop-tool-scope'
import { HostServiceRegistry } from '../src/main/agent/engine/host-service-registry'
import { BrowserTextVault } from '../src/main/agent/browser/browser-text-vault'
import {
  copyOmpWorkerClosure,
  collectOmpWorkerSources,
  ompWorkerOutputFiles
} from '../scripts/build/omp-worker-closure.mjs'
import type { DesktopWebSearchAdapter } from '../src/main/agent/engine/rpc/desktop-websearch-types'

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Private search fixture deadline')
    await delay(10)
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test(
  'genuine SDK metadata and SearxNG results/query constraints match the standalone API; no idle process',
  { timeout: 45_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    const a = await f.adapter()
    const meta = await f.sdk('metadata')
    assert.deepEqual(
      {
        name: a.tool.name,
        label: a.tool.label,
        description: a.tool.description,
        parameters: a.tool.parameters
      },
      meta
    )
    assert.equal(a.tool.approval, 'read')
    assert.equal(a.tool.site, 'host')
    const query = { query: 'site:example.org research', limit: 2, recency: 'week' }
    const baseline = await f.sdk('search', query)
    assert.deepEqual(await f.call(a, query), baseline)
    assert.equal(
      f.requests.some((request) => request.url.includes('time_range=month')),
      true
    )
    assert.equal(JSON.stringify(a.tool.parameters).includes(f.agentDir), false)
    const workers = (await readFile(join(f.root, 'workers.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(workers.length, 4)
    for (const worker of workers)
      assert.equal(alive(worker.pid), false, 'idle worker must have exited')
    // Metadata probe never initializes native settings or creates agent markers.
    const untouched = join(f.root, 'unused-agent')
    const b = await f.adapter({ agentDir: untouched })
    await assert.rejects(access(untouched), { code: 'ENOENT' })
    await b.close()
  }
)

test(
  'live configuration, Basic/Bearer precedence and project overlay reload only on the next real query',
  { timeout: 45_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    const a = await f.adapter()
    await f.configure({ searxng: { endpoint: f.endpoint, token: 'synthetic-token-1' } })
    await f.call(a, { query: 'first' })
    assert.equal(f.requests.at(-1)?.headers.authorization, 'Bearer synthetic-token-1')
    await f.configure({
      searxng: {
        endpoint: f.endpoint,
        token: 'synthetic-token-2',
        basicUsername: 'fixture-user',
        basicPassword: 'fixture-password'
      }
    })
    await f.call(a, { query: 'second' })
    assert.equal(
      f.requests.at(-1)?.headers.authorization,
      'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64')
    )
    await f.configure({ searxng: { endpoint: f.endpoint, token: 'global-token' } })
    const configDir = join(f.resourceCwd, '.omp')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(configDir)
    await writeFile(join(configDir, 'config.yml'), 'searxng:\n  token: project-token\n')
    await f.call(a, { query: 'overlay' })
    assert.equal(f.requests.at(-1)?.headers.authorization, 'Bearer project-token')
  }
)

test(
  'real Brave AuthStorage uses Phi credential updates, sees key rotation/removal and sanitizes provider failure',
  { timeout: 60_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    await f.configure({ modelRoles: { web: 'web/brave' } })
    await f.sdk('key', 'synthetic-brave-key-1')
    const a = await f.adapter()
    const baseline = await f.sdk('search', { query: 'brave' })
    assert.deepEqual(await f.call(a, { query: 'brave' }), baseline)
    assert.equal(f.requests.at(-1)?.headers['x-subscription-token'], 'synthetic-brave-key-1')
    await f.sdk('key', 'synthetic-brave-key-2')
    await f.call(a, { query: 'rotation' })
    assert.equal(f.requests.at(-1)?.headers['x-subscription-token'], 'synthetic-brave-key-2')
    f.respond((_request, response) => {
      response.statusCode = 500
      response.end('provider echoed synthetic-brave-key-2')
    })
    const failed = await f.call(a, { query: 'failure' })
    assert.match(JSON.stringify(failed), /error/)
    assert.doesNotMatch(JSON.stringify(failed), /synthetic-brave-key-2/)
    await f.sdk('key', '')
    const count = f.requests.length
    const missing = await f.call(a, { query: 'no auth' })
    assert.match(JSON.stringify(missing), /error/)
    assert.equal(f.requests.length, count)
  }
)

test(
  'literal and environment config keys retain real SDK selection and error privacy',
  { timeout: 60_000 },
  async (t) => {
    for (const kind of [
      'literal',
      'environment',
      'environment-literal-bang',
      'literal-whitespace',
      'environment-whitespace'
    ] as const)
      await t.test(kind, async (t) => {
        const f = await desktopWebSearchFixture()
        t.after(() => f.close())
        await f.configure({ modelRoles: { web: 'web/brave' } })
        const expected = kind.startsWith('literal')
          ? 'synthetic-config-literal'
          : kind === 'environment-literal-bang'
            ? '!literal-env-token'
            : 'synthetic-config-env'
        await writeFile(
          join(f.agentDir, 'models.yml'),
          JSON.stringify({
            providers: {
              brave: {
                apiKey: kind.startsWith('literal')
                  ? kind.includes('whitespace')
                    ? '  ' + expected + '  '
                    : expected
                  : 'PHI_SYNTHETIC_REFERENCE'
              }
            }
          })
        )
        f.respond((request, response) => {
          assert.equal(request.headers['x-subscription-token'], expected)
          response.statusCode = 500
          response.end('provider echoed ' + expected)
        })
        const a = await f.adapter({
          env: {
            ...f.env,
            PHI_SYNTHETIC_REFERENCE: kind.includes('whitespace') ? '  ' + expected + '  ' : expected
          }
        })
        const failed = await f.call(a, { query: 'failure' })
        assert.doesNotMatch(JSON.stringify(failed), new RegExp(expected))
        assert.match(JSON.stringify(failed), /redacted/)
        assert.deepEqual(a.configurationLimits, {
          commandBackedCredentials: 'unsupported',
          commandBackedModelHeaders: 'unsupported',
          previouslyCachedDiscoveredModels: 'unsupported'
        })
      })
  }
)

test(
  'bad/missing provider and auth initialization fail explicitly without another transport or local session',
  { timeout: 45_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    const a = await f.adapter()
    await f.configure({ modelRoles: { web: 'web/not-a-provider' } })
    const result = await f.call(a, { query: 'missing' })
    assert.match(JSON.stringify(result), /error/)
    assert.equal(f.requests.length, 0)
    await f.configure({ auth: { broker: { url: f.endpoint } } })
    await assert.rejects(f.call(a, { query: 'missing broker token' }), /initialization/)
    assert.equal(f.requests.length, 0)
  }
)

test(
  'abort/retire reject immediately; queued work and late HTTP replies cannot affect the next call',
  { timeout: 45_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    const a = await f.adapter()
    let reply: (() => void) | undefined
    f.respond((_request, response) => {
      reply = () =>
        response.end(
          JSON.stringify({ results: [{ title: 'late', url: 'https://example.org/late' }] })
        )
    })
    const active = new AbortController(),
      queued = new AbortController()
    const first = f.call(a, { query: 'slow' }, active.signal)
    const firstError = assert.rejects(first, /active abort/)
    await until(() => !!reply)
    const second = f.call(a, { query: 'queued' }, queued.signal)
    const secondError = assert.rejects(second, /queued abort/)
    queued.abort(new Error('queued abort'))
    await secondError
    active.abort(new Error('active abort'))
    await firstError
    reply!()
    f.respond((_request, response) =>
      response.end(
        JSON.stringify({ results: [{ title: 'next', url: 'https://example.org/next' }] })
      )
    )
    const next = await f.call(a, { query: 'next' })
    assert.match(JSON.stringify(next), /next/)
    assert.doesNotMatch(JSON.stringify(next), /https:\/\/example.org\/late/)
    assert.equal(
      f.requests.some((r) => r.url.includes('queued')),
      false
    )
    a.retire(new Error('retired session'))
    await assert.rejects(f.call(a, { query: 'retired' }), /retired session/)
    await a.close()
    await a.close()
  }
)

test(
  'two real sessions isolate global settings, credentials, cancellation and cleanup',
  { timeout: 45_000 },
  async (t) => {
    const f = await desktopWebSearchFixture(),
      g = await desktopWebSearchFixture()
    t.after(async () => {
      await f.close()
      await g.close()
    })
    await f.configure({ searxng: { endpoint: f.endpoint, token: 'session-A-token' } })
    await g.configure({ searxng: { endpoint: g.endpoint, token: 'session-B-token' } })
    const a = await f.adapter(),
      b = await g.adapter({ identity: { ...g.identity, runtimeSessionId: 'session-B' } })
    let pending = false
    f.respond(() => {
      pending = true
    })
    const p = f.call(a, { query: 'session-A' })
    const rejection = assert.rejects(p, /retired/)
    await until(() => pending)
    const other = await g.call(b, { query: 'session-B' })
    a.retire()
    await rejection
    await a.close()
    assert.match(JSON.stringify(other), /SearxNG/)
    assert.equal(f.requests.at(-1)?.headers.authorization, 'Bearer session-A-token')
    assert.equal(g.requests.at(-1)?.headers.authorization, 'Bearer session-B-token')
    assert.match(JSON.stringify(await g.call(b, { query: 'still usable' })), /SearxNG/)
  }
)

test(
  'optional scope binds only a genuine exact-session adapter, remains read gated and retires its owner',
  { timeout: 45_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    const a = await f.adapter()
    const run = { id: 'run', signal: new AbortController().signal }
    const options = {
      identity: f.identity,
      services: new HostServiceRegistry(),
      currentRun: () => run,
      recentUserImages: () => [],
      allowBrowserTypeText: () => false,
      browserTextVault: new BrowserTextVault(),
      agentDir: f.agentDir,
      allowedSkills: [],
      scriptTools: []
    }
    const absent = createRpcDesktopToolScope(options)
    assert.equal(
      absent.tools.some((t) => t.name === 'web_search'),
      false
    )
    absent.dispose()
    assert.throws(
      () =>
        createRpcDesktopToolScope({
          ...options,
          desktopWebSearch: { ...a } as DesktopWebSearchAdapter
        }),
      /different trusted session/
    )
    assert.throws(
      () =>
        createRpcDesktopToolScope({
          ...options,
          identity: { ...f.identity, sessionId: 'other' },
          desktopWebSearch: a
        }),
      /different trusted session/
    )
    const scope = createRpcDesktopToolScope({ ...options, desktopWebSearch: a })
    assert.equal(scope.approvalFor('web_search', {}), 'read')
    assert.deepEqual(
      scope.unavailable.map((item) => item.capability),
      [
        'library',
        'MCP',
        'agent delegation',
        'websearch command-backed configuration',
        'websearch cached discovery'
      ]
    )
    const tool = scope.tools.find((t) => t.name === 'web_search')!
    assert.match(
      JSON.stringify(
        await tool.execute('trusted-call', { query: 'scope' }, undefined, {
          cwd: f.identity.cwd,
          recentUserImages: () => []
        })
      ),
      /SearxNG/
    )
    scope.dispose()
    await assert.rejects(f.call(a, { query: 'disposed' }), /disposed/)
  }
)

test(
  'input/selected model failures have zero provider effects and project dotenv cannot replace launcher auth',
  { timeout: 45_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    const a = await f.adapter()
    for (const params of [
      { query: 'x', model: 'web/brave' },
      { query: 'x', limit: NaN },
      { query: 'x', recency: 'decade' }
    ])
      await assert.rejects(f.call(a, params), /Invalid desktop/)
    const b = await f.adapter({ currentModel: () => ({ provider: 'missing', id: 'model' }) })
    await assert.rejects(f.call(b, { query: 'unknown active model' }), /unavailable/)
    assert.equal(f.requests.length, 0)
    await writeFile(join(f.resourceCwd, '.env'), 'SEARXNG_TOKEN=project-private-injection\n')
    await f.call(a, { query: 'safe' })
    assert.equal(f.requests.at(-1)?.headers.authorization, undefined)
  }
)

test(
  'copied out worker and unpacked asar closure execute the real SDK search',
  { timeout: 45_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    copyOmpWorkerClosure(process.cwd())
    const source = 'src/main/agent/engine/rpc/desktop-websearch-worker.ts'
    assert.equal(collectOmpWorkerSources(process.cwd()).files.includes(source), true)
    assert.equal(ompWorkerOutputFiles(process.cwd()).includes(source.replace('src/', 'out/')), true)
    const a = await f.adapter({ workerPath: join(process.cwd(), source.replace('src/', 'out/')) })
    assert.match(JSON.stringify(await f.call(a, { query: 'out smoke' })), /SearxNG/)
    const { cp, symlink, mkdir } = await import('node:fs/promises')
    const unpacked = join(f.root, 'app.asar.unpacked')
    await mkdir(unpacked)
    await cp(join(process.cwd(), 'out'), join(unpacked, 'out'), { recursive: true })
    await symlink(join(process.cwd(), 'node_modules'), join(unpacked, 'node_modules'), 'dir')
    await cp(join(process.cwd(), 'package.json'), join(unpacked, 'package.json'))
    const b = await f.adapter({
      workerPath: resolveDesktopWebSearchWorkerPath(
        pathToFileURL(join(f.root, 'app.asar/out/main/index.mjs')).href
      )
    })
    assert.match(JSON.stringify(await f.call(b, { query: 'asar unpacked smoke' })), /SearxNG/)
  }
)

test(
  'actual query worker crash is explicit and never replays; next explicit call can start cleanly',
  { timeout: 45_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    const a = await f.adapter({
      env: { ...f.env, PHI_TEST_SEARCH_CRASH_ONCE: join(f.root, 'crashed-once') }
    })
    await assert.rejects(f.call(a, { query: 'crash this request' }), /worker exited/)
    assert.equal(f.requests.length, 0, 'crash must not retry in another worker/provider')
    assert.match(JSON.stringify(await f.call(a, { query: 'explicit next request' })), /SearxNG/)
    assert.equal(f.requests.filter((r) => r.url.startsWith('/search')).length, 1)
  }
)

test(
  'provider transport returning after cancellation cannot publish late success; result overflow is explicit',
  { timeout: 45_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    await f.configure({ searxng: { endpoint: f.endpoint } })
    const a = await f.adapter({ env: { ...f.env, PHI_TEST_SEARCH_IGNORE_ABORT: '1' } })
    let reply: (() => void) | undefined
    f.respond((_request, response) => {
      reply = () => response.end(JSON.stringify({ answers: ['late private transport success'] }))
    })
    const abort = new AbortController()
    const request = f.call(a, { query: 'late' }, abort.signal)
    const rejected = assert.rejects(request, /cancel late query/)
    await until(() => !!reply)
    abort.abort(new Error('cancel late query'))
    await rejected
    reply!()
    f.respond((_request, response) =>
      response.end(JSON.stringify({ answers: ['valid new result'] }))
    )
    assert.match(JSON.stringify(await f.call(a, { query: 'new' })), /valid new result/)
    f.respond((_request, response) =>
      response.end(JSON.stringify({ answers: ['x'.repeat(17 * 1024 * 1024)] }))
    )
    await assert.rejects(f.call(a, { query: 'too large' }), /32 MiB/)
    await assert.rejects(f.call(a, { query: 'x'.repeat(1024 * 1024) }), /frame limit/)
  }
)

test(
  'trusted owner cancellation drains a bounded serial queue without creating query workers',
  { timeout: 45_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    const owner = new AbortController(),
      a = await f.adapter({ signal: owner.signal })
    const calls = Array.from({ length: 64 }, (_, index) => f.call(a, { query: 'queued ' + index }))
    const settled = Promise.allSettled(calls)
    const excess = assert.rejects(f.call(a, { query: 'overflow' }), /queue limit/)
    owner.abort(new Error('window closed'))
    await excess
    const outcomes = await settled
    assert.equal(
      outcomes.every(
        (outcome) => outcome.status === 'rejected' && outcome.reason.message === 'window closed'
      ),
      true
    )
    await a.close()
    await assert.rejects(f.adapter({ signal: owner.signal }), /window closed/)
    assert.equal(f.requests.length, 0)
    const workers = (await readFile(join(f.root, 'workers.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(workers.length, 1, 'only the completed metadata probe may have existed')
    for (const worker of workers) assert.equal(alive(worker.pid), false)
  }
)

test(
  'the original hung credential-helper input is rejected before any helper or provider can start',
  { timeout: 30_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    await f.configure({ modelRoles: { web: 'web/brave' } })
    const { stringify } = await import('yaml')
    const marker = join(f.root, 'credential-started')
    const command = `!touch '${marker}'; sleep 30; printf synthetic-never-used-key`
    await writeFile(
      join(f.agentDir, 'models.yml'),
      stringify({ providers: { brave: { apiKey: command } } })
    )
    const a = await f.adapter()
    await assert.rejects(
      f.call(a, { query: 'hung credential command' }),
      /command-backed.*unsupported/i
    )
    await assert.rejects(access(marker), { code: 'ENOENT' })
    assert.equal(f.requests.length, 0)
    await a.close()
    const workers = (await readFile(join(f.root, 'workers.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    for (const worker of workers) assert.equal(alive(worker.pid), false)
  }
)
