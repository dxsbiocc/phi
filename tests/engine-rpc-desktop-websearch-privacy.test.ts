import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import test from 'node:test'
import { desktopWebSearchFixture } from './helpers/desktopWebSearchFixture'

test(
  'real Brave errors redact standard JSON-escaped known keys while successful content stays native',
  { timeout: 60_000 },
  async (t) => {
    for (const source of ['literal', 'environment'] as const)
      for (const representation of ['quote', 'backslash', 'combined-whitespace'] as const)
        await t.test(`${source} ${representation}`, async (t) => {
          const f = await desktopWebSearchFixture()
          t.after(() => f.close())
          await f.configure({ modelRoles: { web: 'web/brave' } })
          const expected =
            representation === 'quote'
              ? 'synthetic-"quote"-key'
              : representation === 'backslash'
                ? 'synthetic-\\backslash-key'
                : 'synthetic-"quote"-\\backslash-key'
          const configured =
            representation === 'combined-whitespace' ? '  ' + expected + '  ' : expected
          f.env.PHI_SYNTHETIC_REFERENCE = configured
          await writeFile(
            f.agentDir + '/models.yml',
            JSON.stringify({
              providers: {
                brave: { apiKey: source === 'literal' ? configured : 'PHI_SYNTHETIC_REFERENCE' }
              }
            })
          )
          const escaped = JSON.stringify(expected).slice(1, -1)
          f.respond((request, response) => {
            assert.equal(request.headers['x-subscription-token'], expected)
            response.statusCode = 500
            response.end(
              JSON.stringify({ error: { message: request.headers['x-subscription-token'] } })
            )
          })
          const adapter = await f.adapter()
          const failed = await f.call(adapter, { query: 'JSON error privacy' })
          assert.equal(f.requests.length, 1, 'the actual native Brave provider must execute')
          assert.equal(f.requests[0].headers['x-subscription-token'], expected)
          const details = failed.details
          assert.ok(
            typeof details === 'object' &&
              details !== null &&
              'error' in details &&
              typeof details.error === 'string'
          )
          const failure = [
            details.error,
            ...failed.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          ]
          for (const text of failure) {
            assert.match(text, /Brave API error \(500\)/)
            assert.equal(text.includes(expected), false, 'raw known key must not leak')
            assert.equal(text.includes(escaped), false, 'JSON-escaped known key must not leak')
            assert.match(text, /\[redacted\]/)
          }
          const publicContent = expected + ' | ' + escaped
          f.respond((request, response) => {
            assert.equal(request.headers['x-subscription-token'], expected)
            response.end(
              JSON.stringify({
                web: {
                  results: [
                    {
                      title: 'Public source',
                      url: 'https://example.org/json-privacy',
                      description: publicContent
                    }
                  ]
                }
              })
            )
          })
          const query = { query: 'successful JSON content' }
          const baseline = await f.sdk('search', query)
          const success = await f.call(adapter, query)
          assert.deepEqual(success, baseline, 'successful results retain the genuine SDK contract')
          const successText = success.content.flatMap((block) =>
            block.type === 'text' ? [block.text] : []
          )
          assert.ok(successText.some((text) => text.includes(publicContent)))
          assert.equal(JSON.stringify(success).includes('[redacted]'), false)
        })
  }
)

const cases = [
  {
    name: 'empty settings username',
    settings: { basicUsername: '', basicPassword: 'synthetic-private-password' },
    username: '',
    password: 'synthetic-private-password'
  },
  {
    name: 'empty settings password',
    settings: { basicUsername: 'synthetic-private-user', basicPassword: '' },
    username: 'synthetic-private-user',
    password: ''
  },
  {
    name: 'both settings fields empty',
    settings: { basicUsername: '', basicPassword: '' },
    username: '',
    password: ''
  },
  {
    name: 'empty environment username',
    env: { SEARXNG_BASIC_USERNAME: '', SEARXNG_BASIC_PASSWORD: 'synthetic-env-password' },
    username: '',
    password: 'synthetic-env-password'
  },
  {
    name: 'empty environment password',
    env: { SEARXNG_BASIC_USERNAME: 'synthetic-env-user', SEARXNG_BASIC_PASSWORD: '' },
    username: 'synthetic-env-user',
    password: ''
  },
  {
    name: 'mixed empty settings username/environment password',
    settings: { basicUsername: '' },
    env: { SEARXNG_BASIC_PASSWORD: 'synthetic-mixed-password' },
    username: '',
    password: 'synthetic-mixed-password'
  },
  {
    name: 'mixed environment username/empty settings password',
    settings: { basicPassword: '' },
    env: { SEARXNG_BASIC_USERNAME: 'synthetic-mixed-user' },
    username: 'synthetic-mixed-user',
    password: ''
  }
] as const

test(
  'real SDK Basic presence semantics never disclose encoded empty credentials in failed-search envelopes',
  { timeout: 60_000 },
  async (t) => {
    for (const value of cases)
      await t.test(value.name, async (t) => {
        const f = await desktopWebSearchFixture()
        t.after(() => f.close())
        await f.configure({
          searxng: { endpoint: f.endpoint, ...('settings' in value ? value.settings : {}) }
        })
        const expected = Buffer.from(`${value.username}:${value.password}`).toString('base64')
        f.respond((request, response) => {
          assert.equal(request.headers.authorization, 'Basic ' + expected)
          response.statusCode = 500
          response.end(
            JSON.stringify({ error: 'upstream echoed ' + request.headers.authorization })
          )
        })
        const adapter = await f.adapter({ env: { ...f.env, ...('env' in value ? value.env : {}) } })
        const result = await f.call(adapter, { query: 'basic error privacy' })
        assert.equal(f.requests.at(-1)?.headers.authorization, 'Basic ' + expected)
        assert.match(JSON.stringify(result), /error/)
        assert.equal(
          JSON.stringify(result).includes(expected),
          false,
          'encoded credential must stay desktop-side'
        )
      })
  }
)

test(
  'a missing Basic field retains the genuine SDK explicit failure and makes no HTTP request',
  { timeout: 30_000 },
  async (t) => {
    const f = await desktopWebSearchFixture()
    t.after(() => f.close())
    await f.configure({ searxng: { endpoint: f.endpoint, basicUsername: '' } })
    const adapter = await f.adapter()
    const result = await f.call(adapter, { query: 'missing password' })
    assert.match(JSON.stringify(result), /requires both/)
    assert.equal(f.requests.length, 0)
  }
)

test(
  'real grounded search preserves header source semantics and scrubs only failed results',
  { timeout: 60_000 },
  async (t) => {
    for (const kind of [
      'provider-literal',
      'provider-env-normalized',
      'model-env',
      'override-env'
    ] as const)
      await t.test(kind, async (t) => {
        const f = await desktopWebSearchFixture()
        t.after(() => f.close())
        const models = await f.sdk('search-models')
        assert.ok(Array.isArray(models) && models.length > 0 && typeof models[0].id === 'string')
        const modelId = models[0].id
        await f.configure({ modelRoles: { web: 'openai/' + modelId } })
        const secret = 'synthetic-resolved-header-value'
        const headers = {
          'X-Private': kind === 'provider-literal' ? secret : 'PHI_SYNTHETIC_HEADER'
        }
        const provider = {
          baseUrl: f.endpoint,
          apiKey: 'synthetic-openai-key',
          api: 'openai-responses',
          ...(kind.startsWith('provider')
            ? { headers }
            : kind === 'model-env'
              ? { models: [{ id: modelId, headers }] }
              : { modelOverrides: { [modelId]: { headers } } })
        }
        const { writeFile } = await import('node:fs/promises')
        await writeFile(
          f.agentDir + '/models.yml',
          JSON.stringify({ providers: { openai: provider } })
        )
        f.respond((request, response) => {
          assert.equal(request.url, '/responses')
          assert.equal(request.headers['x-private'], secret)
          response.statusCode = 500
          response.end(
            JSON.stringify({
              error: { type: 'synthetic_provider_error', code: request.headers['x-private'] }
            })
          )
        })
        const a = await f.adapter({
          env: {
            ...f.env,
            PHI_SYNTHETIC_HEADER: kind === 'provider-env-normalized' ? '  ' + secret + '  ' : secret
          }
        })
        const failed = await f.call(a, { query: 'header error' })
        assert.equal(f.requests.length, 1, 'the actual selected grounded provider must execute')
        assert.match(JSON.stringify(failed), /synthetic_provider_error/)
        assert.equal(JSON.stringify(failed).includes(secret), false)
        f.respond((request, response) => {
          assert.equal(request.headers['x-private'], secret)
          response.end(
            JSON.stringify({
              id: 'native-search',
              model: modelId,
              output: [
                {
                  type: 'web_search_call',
                  status: 'completed',
                  action: {
                    sources: [{ url: 'https://example.org/native', title: 'Native source' }]
                  }
                },
                {
                  type: 'message',
                  content: [
                    {
                      type: 'output_text',
                      text: secret,
                      annotations: [
                        {
                          type: 'url_citation',
                          url: 'https://example.org/native',
                          title: 'Native source'
                        }
                      ]
                    }
                  ]
                }
              ]
            })
          )
        })
        const success = await f.call(a, { query: 'successful header query' })
        assert.equal(
          JSON.stringify(success).includes(secret),
          true,
          'successful provider content remains unchanged even when a public value equals a header'
        )
        assert.equal(JSON.stringify(success).includes('redacted'), false)
      })
  }
)
