import assert from 'node:assert/strict'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { stringify } from 'yaml'
import { desktopWebSearchFixture } from './helpers/desktopWebSearchFixture'

function command(path: string): string {
  return `!touch '${path}'; printf synthetic-command-key`
}
const modelCases = [
  { name: 'provider API key', provider: (cmd: string) => ({ apiKey: cmd }) },
  {
    name: 'provider header',
    provider: (cmd: string) => ({ apiKey: 'literal-key', headers: { 'X-Credential': cmd } })
  },
  {
    name: 'model header',
    provider: (cmd: string) => ({
      apiKey: 'literal-key',
      api: 'openai-completions',
      baseUrl: 'https://unused.invalid',
      models: [{ id: 'fixture-model', headers: { 'X-Credential': cmd } }]
    })
  },
  {
    name: 'model override header',
    provider: (cmd: string) => ({
      apiKey: 'literal-key',
      modelOverrides: { '*': { headers: { 'X-Credential': cmd } } }
    })
  }
]

test(
  'native-typed command-backed model configuration is rejected before every command/provider effect',
  { timeout: 60_000 },
  async (t) => {
    for (const value of modelCases)
      await t.test(value.name, async (t) => {
        const f = await desktopWebSearchFixture()
        t.after(() => f.close())
        await f.configure({ modelRoles: { web: 'web/brave' } })
        const sentinel = join(f.root, 'must-not-run')
        await writeFile(
          join(f.agentDir, 'models.yml'),
          stringify({ providers: { brave: value.provider(command(sentinel)) } })
        )
        const adapter = await f.adapter()
        await assert.rejects(
          f.call(adapter, { query: 'unsupported model credentials' }),
          /command-backed.*unsupported/i
        )
        await assert.rejects(access(sentinel), { code: 'ENOENT' })
        assert.equal(f.requests.length, 0)
        await assert.rejects(
          f.call(adapter, { query: 'explicit repeated request' }),
          /command-backed.*unsupported/i
        )
        assert.equal(f.requests.length, 0)
      })
  }
)

test(
  'real login and fallback stored API-key command references fail before hydration/provider requests',
  { timeout: 45_000 },
  async (t) => {
    for (const mode of ['key', 'login-key'])
      await t.test(mode, async (t) => {
        const f = await desktopWebSearchFixture()
        t.after(() => f.close())
        await f.configure({ modelRoles: { web: 'web/brave' } })
        const sentinel = join(f.root, 'stored-must-not-run')
        await f.sdk(mode, command(sentinel))
        const adapter = await f.adapter()
        await assert.rejects(
          f.call(adapter, { query: 'unsupported stored credentials' }),
          /command-backed.*unsupported/i
        )
        await assert.rejects(access(sentinel), { code: 'ENOENT' })
        assert.equal(f.requests.length, 0)
      })
  }
)

test(
  'native nested/dotted/YAML broker command resolution is rejected before execution or broker HTTP',
  { timeout: 60_000 },
  async (t) => {
    for (const variant of ['nested-token', 'dotted-token', 'yaml-url'] as const)
      await t.test(variant, async (t) => {
        const f = await desktopWebSearchFixture()
        t.after(() => f.close())
        const sentinel = join(f.root, 'broker-must-not-run')
        if (variant === 'nested-token')
          await f.configure({ auth: { broker: { url: f.endpoint, token: command(sentinel) } } })
        else if (variant === 'dotted-token')
          await f.configure({
            'auth.broker.url': f.endpoint,
            'auth.broker.token': command(sentinel)
          })
        else {
          const { rm } = await import('node:fs/promises')
          await rm(join(f.agentDir, 'config.yml'))
          await writeFile(
            join(f.agentDir, 'config.yaml'),
            stringify({ auth: { broker: { url: command(sentinel) } } })
          )
        }
        const adapter = await f.adapter()
        await assert.rejects(
          f.call(adapter, { query: 'unsupported broker credentials' }),
          /command-backed.*unsupported/i
        )
        await assert.rejects(access(sentinel), { code: 'ENOENT' })
        assert.equal(f.requests.length, 0)
      })
  }
)

test(
  'validated model snapshot is private/immutable for the current query and old discovery cache is not read',
  { timeout: 30_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    await f.configure({ modelRoles: { web: 'web/brave' } })
    const original = {
      providers: {
        brave: { apiKey: 'literal-snapshot-key', headers: { 'X-Public': 'static-value' } }
      }
    }
    const source = join(f.agentDir, 'models.yml'),
      marker = join(f.root, 'changed-config-must-not-run')
    await writeFile(source, stringify(original))
    const oldCache = Buffer.from('unsupported old cached model/header data')
    await writeFile(join(f.agentDir, 'models.db'), oldCache)
    const { readFileSync, writeFileSync, statSync } = await import('node:fs')
    let privateDirectory = ''
    f.respond((request, response) => {
      const ledger = readFileSync(join(f.root, 'workers.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      privateDirectory = ledger.at(-1).cwd
      assert.deepEqual(
        JSON.parse(readFileSync(join(privateDirectory, 'models.yml'), 'utf8')),
        original
      )
      assert.equal(statSync(join(privateDirectory, 'models.yml')).mode & 0o777, 0o600)
      assert.equal(statSync(privateDirectory).mode & 0o777, 0o700)
      assert.equal(request.headers['x-subscription-token'], 'literal-snapshot-key')
      writeFileSync(source, stringify({ providers: { brave: { apiKey: command(marker) } } }))
      response.end(
        JSON.stringify({
          web: { results: [{ title: 'snapshot retained', url: 'https://example.org/snapshot' }] }
        })
      )
    })
    const a = await f.adapter(),
      result = await f.call(a, { query: 'current snapshot' })
    assert.match(JSON.stringify(result), /snapshot retained/)
    await assert.rejects(access(privateDirectory), { code: 'ENOENT' })
    assert.deepEqual(readFileSync(join(f.agentDir, 'models.db')), oldCache)
    const count = f.requests.length
    await assert.rejects(f.call(a, { query: 'changed next query' }), /command-backed.*unsupported/i)
    await assert.rejects(access(marker), { code: 'ENOENT' })
    assert.equal(f.requests.length, count)
  }
)

test(
  'unsupported source/JSON complexity bounds fail before native model hydration or provider HTTP',
  { timeout: 60_000 },
  async (t) => {
    for (const kind of ['invalid', 'bytes', 'depth', 'nodes'] as const)
      await t.test(kind, async (t) => {
        const f = await desktopWebSearchFixture()
        t.after(() => f.close())
        let source: string
        if (kind === 'invalid') source = 'providers: ['
        else if (kind === 'bytes') source = 'x'.repeat(4 * 1024 * 1024 + 1)
        else {
          let extra: unknown =
            kind === 'nodes'
              ? Object.fromEntries(Array.from({ length: 100_001 }, (_, i) => ['n' + i, true]))
              : true
          if (kind === 'depth') for (let i = 0; i < 40; i++) extra = { child: extra }
          source = JSON.stringify({
            providers: { brave: { apiKey: 'literal-key', compat: { extraBody: { extra } } } }
          })
        }
        await writeFile(join(f.agentDir, 'models.yml'), source)
        const a = await f.adapter()
        await assert.rejects(
          f.call(a, { query: 'invalid configuration' }),
          /invalid or exceeds supported bounds/
        )
        assert.equal(f.requests.length, 0)
      })
  }
)

test(
  'a new stored command encountered by native 401 retry aborts the query instead of provider fallback',
  { timeout: 45_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    await f.configure({ modelRoles: { web: 'web/brave' } })
    await f.sdk('key', 'initial-literal-key')
    const marker = join(f.root, 'retry-command-must-not-run')
    let calls = 0
    f.respond((_request, response) => {
      calls++
      void f.sdk('key', command(marker)).then(
        () => {
          response.statusCode = 401
          response.end('synthetic auth retry')
        },
        (error) => response.destroy(error)
      )
    })
    const a = await f.adapter()
    await assert.rejects(
      f.call(a, { query: 'revoke during retry' }),
      /command-backed.*unsupported/i
    )
    assert.equal(calls, 1, 'native auth retry must not admit another provider request')
    await assert.rejects(access(marker), { code: 'ENOENT' })
  }
)

test(
  'native broker discovery keeps literal/env/token-file sources and actual remote credential store',
  { timeout: 60_000 },
  async (t) => {
    for (const kind of ['literal', 'env-reference', 'token-file'] as const)
      await t.test(kind, async (t) => {
        const f = await desktopWebSearchFixture()
        t.after(() => f.close())
        await f.configure({ modelRoles: { web: 'web/brave' } })
        await f.sdk('key', 'synthetic-broker-brave-key')
        const saved = await f.sdk('snapshot')
        assert.ok(
          saved &&
            typeof saved === 'object' &&
            'snapshot' in saved &&
            'tokenPath' in saved &&
            typeof saved.tokenPath === 'string'
        )
        const snapshot = saved.snapshot
        assert.ok(
          snapshot &&
            typeof snapshot === 'object' &&
            'credentials' in snapshot &&
            Array.isArray(snapshot.credentials)
        )
        const response = {
          ...snapshot,
          serverNowMs: Date.now(),
          refresher: { enabled: false, intervalMs: 10_000, skewMs: 0, nextSweepInMs: 10_000 },
          credentials: snapshot.credentials.map((entry) => ({ ...entry, rotatesInMs: null }))
        }
        const token = 'synthetic-native-broker-token'
        let env = { ...f.env }
        if (kind === 'literal')
          await f.configure({
            modelRoles: { web: 'web/brave' },
            auth: { broker: { url: f.endpoint, token } }
          })
        else if (kind === 'env-reference') {
          await f.configure({
            modelRoles: { web: 'web/brave' },
            auth: { broker: { url: 'PHI_BROKER_ENDPOINT', token: 'PHI_BROKER_REFERENCE' } }
          })
          env = { ...env, PHI_BROKER_ENDPOINT: f.endpoint, PHI_BROKER_REFERENCE: token }
        } else {
          const { mkdir } = await import('node:fs/promises')
          const { dirname } = await import('node:path')
          await mkdir(dirname(saved.tokenPath), { recursive: true })
          await writeFile(saved.tokenPath, token, { mode: 0o600 })
          env = { ...env, OMP_AUTH_BROKER_URL: f.endpoint }
        }
        f.respond((request, res) => {
          if (request.url!.startsWith('/v1/snapshot/stream')) {
            res.statusCode = 404
            res.end('{}')
            return
          }
          if (request.url!.startsWith('/v1/snapshot')) {
            assert.equal(request.headers.authorization, 'Bearer ' + token)
            res.end(JSON.stringify(response))
            return
          }
          assert.equal(request.headers['x-subscription-token'], 'synthetic-broker-brave-key')
          res.end(
            JSON.stringify({
              web: {
                results: [{ title: 'native broker credential', url: 'https://example.org/broker' }]
              }
            })
          )
        })
        const a = await f.adapter({ env }),
          result = await f.call(a, { query: 'broker query' })
        assert.match(JSON.stringify(result), /native broker credential/)
        assert.equal(
          f.requests.some((request) => request.url.startsWith('/v1/snapshot')),
          true
        )
        assert.doesNotMatch(
          JSON.stringify(result),
          /synthetic-native-broker-token|synthetic-broker-brave-key/
        )
      })
  }
)

test(
  'native credential cascade retains login-over-environment and environment-over-fallback precedence',
  { timeout: 45_000 },
  async (t) => {
    for (const mode of ['key', 'login-key'])
      await t.test(mode, async (t) => {
        const f = await desktopWebSearchFixture()
        t.after(() => f.close())
        await f.configure({ modelRoles: { web: 'web/brave' } })
        await f.sdk(mode, 'synthetic-stored-key')
        const expected = mode === 'login-key' ? 'synthetic-stored-key' : 'synthetic-environment-key'
        f.respond((request, response) => {
          assert.equal(request.headers['x-subscription-token'], expected)
          response.end(
            JSON.stringify({
              web: {
                results: [{ title: 'native key cascade', url: 'https://example.org/cascade' }]
              }
            })
          )
        })
        const a = await f.adapter({ env: { ...f.env, BRAVE_API_KEY: 'synthetic-environment-key' } })
        assert.match(
          JSON.stringify(await f.call(a, { query: 'native precedence' })),
          /native key cascade/
        )
      })
  }
)

test(
  'native models.yaml/legacy models.json sources cannot bypass the typed command gate',
  { timeout: 45_000 },
  async (t) => {
    for (const extension of ['yaml', 'json'])
      await t.test(extension, async (t) => {
        const f = await desktopWebSearchFixture()
        t.after(() => f.close())
        const marker = join(f.root, 'alternate-source-must-not-run')
        const config = { providers: { brave: { headers: { 'X-Credential': command(marker) } } } }
        await writeFile(
          join(f.agentDir, 'models.' + extension),
          extension === 'json' ? JSON.stringify(config) : stringify(config)
        )
        const a = await f.adapter()
        await assert.rejects(
          f.call(a, { query: 'alternate model source' }),
          /command-backed.*unsupported/i
        )
        await assert.rejects(access(marker), { code: 'ENOENT' })
        assert.equal(f.requests.length, 0)
      })
  }
)

test(
  'abrupt death of a query containing the former orphan-producing input has zero helper/provider effects',
  { timeout: 30_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    const marker = join(f.root, 'abrupt-helper-must-not-run')
    await writeFile(
      join(f.agentDir, 'models.yml'),
      stringify({ providers: { brave: { apiKey: command(marker) + '; sleep 30' } } })
    )
    const a = await f.adapter()
    const outcome = f.call(a, { query: 'unsupported abrupt worker' }).then(
      () => ({ success: true, error: '' }),
      (error) => ({ success: false, error: error.message })
    )
    const { readFile } = await import('node:fs/promises')
    let pid: number | undefined
    const deadline = Date.now() + 5000
    while (!pid) {
      const rows = (await readFile(join(f.root, 'workers.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      if (rows.length > 1) pid = rows.at(-1).pid
      else {
        if (Date.now() > deadline) throw new Error('Private owned worker did not launch')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    const result = await outcome
    assert.equal(result.success, false)
    assert.match(result.error, /worker exited|command-backed.*unsupported/i)
    await a.close()
    await assert.rejects(access(marker), { code: 'ENOENT' })
    assert.equal(f.requests.length, 0)
  }
)
