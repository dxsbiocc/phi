import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveNpmPackage } from '../src/main/agent/packages/github-project-hint'
import { holdEventLoopForTests } from './helpers/holdEventLoop'

holdEventLoopForTests()

const repository = { owner: 'xieningqing', name: 'qq-email-mcp', repo: 'xieningqing/qq-email-mcp' }

function metadata(
  repositoryValue: unknown = {
    type: 'git',
    url: 'git+https://github.com/xieningqing/qq-email-mcp.git'
  }
): Record<string, unknown> {
  return {
    'dist-tags': { latest: '0.1.1' },
    versions: {
      '0.1.1': {
        name: 'qq-email-mcp',
        version: '0.1.1',
        repository: repositoryValue
      }
    }
  }
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })
}

test('resolves exact npm metadata only when it belongs to the previewed repository', async () => {
  let requestedUrl = ''
  let requestedInit: RequestInit | undefined
  const result = await resolveNpmPackage('qq-email-mcp', repository, '0.1.1', {
    fetch: async (input, init) => {
      requestedUrl = String(input)
      requestedInit = init
      return jsonResponse(metadata())
    },
    timeoutMs: 100
  })

  assert.deepEqual(result, {
    npm: { name: 'qq-email-mcp', version: '0.1.1', repositoryMatches: true }
  })
  assert.equal(requestedUrl, 'https://registry.npmjs.org/qq-email-mcp')
  assert.equal(new Headers(requestedInit?.headers).get('accept'), 'application/json')
  assert.equal(requestedInit?.credentials, 'omit')
  assert.equal(requestedInit?.redirect, 'error')
})

test('normalises supported GitHub repository URL forms case-insensitively', async () => {
  for (const value of [
    'git+https://github.com/XieningQing/QQ-Email-MCP.git',
    'git@github.com:xieningqing/qq-email-mcp.git',
    'ssh://git@github.com/xieningqing/qq-email-mcp.git#readme',
    'git://github.com/xieningqing/qq-email-mcp/',
    { url: 'https://github.com/xieningqing/qq-email-mcp.git' }
  ]) {
    const result = await resolveNpmPackage('qq-email-mcp', repository, '0.1.1', {
      fetch: async () => jsonResponse(metadata(value)),
      timeoutMs: 100
    })
    assert.equal(result.npm?.repositoryMatches, true, JSON.stringify(value))
  }
})

test('rejects missing or mismatched npm repositories', async () => {
  const mismatched = await resolveNpmPackage('qq-email-mcp', repository, '0.1.1', {
    fetch: async () => jsonResponse(metadata('https://github.com/attacker/qq-email-mcp')),
    timeoutMs: 100
  })
  assert.equal(mismatched.npm, undefined)
  assert.match(mismatched.notice, /不匹配/)

  const missing = await resolveNpmPackage('qq-email-mcp', repository, '0.1.1', {
    fetch: async () => jsonResponse(metadata(null)),
    timeoutMs: 100
  })
  assert.equal(missing.npm, undefined)
  assert.match(missing.notice, /缺少仓库地址/)
})

test('preserves the leading at-sign while encoding a scoped npm name', async () => {
  let requestedUrl = ''
  const scopedRepository = { owner: 'scope', name: 'server', repo: 'scope/server' }
  const result = await resolveNpmPackage('@scope/server', scopedRepository, '1.0.0', {
    fetch: async (input) => {
      requestedUrl = String(input)
      return jsonResponse({
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            version: '1.0.0',
            repository: 'git+https://github.com/scope/server.git'
          }
        }
      })
    },
    timeoutMs: 100
  })
  assert.equal(requestedUrl, 'https://registry.npmjs.org/@scope%2Fserver')
  assert.equal(result.npm?.name, '@scope/server')
})

test('prefers a non-deprecated requested version and otherwise uses latest', async () => {
  const document = {
    'dist-tags': { latest: '2.0.0' },
    versions: {
      '1.0.0': {
        version: '1.0.0',
        repository: 'https://github.com/xieningqing/qq-email-mcp'
      },
      '1.5.0': {
        version: '1.5.0',
        deprecated: 'old release',
        repository: 'https://github.com/xieningqing/qq-email-mcp'
      },
      '2.0.0': {
        version: '2.0.0',
        repository: 'https://github.com/xieningqing/qq-email-mcp'
      }
    }
  }
  const preferred = await resolveNpmPackage('qq-email-mcp', repository, '1.0.0', {
    fetch: async () => jsonResponse(document),
    timeoutMs: 100
  })
  assert.equal(preferred.npm?.version, '1.0.0')

  const latest = await resolveNpmPackage('qq-email-mcp', repository, '1.5.0', {
    fetch: async () => jsonResponse(document),
    timeoutMs: 100
  })
  assert.equal(latest.npm?.version, '2.0.0')
})

test('keeps the deprecation message when the chosen latest version is deprecated', async () => {
  const result = await resolveNpmPackage('qq-email-mcp', repository, undefined, {
    fetch: async () =>
      jsonResponse({
        'dist-tags': { latest: '0.1.1' },
        versions: {
          '0.1.1': {
            version: '0.1.1',
            deprecated: 'use the replacement',
            repository: 'https://github.com/xieningqing/qq-email-mcp'
          }
        }
      }),
    timeoutMs: 100
  })
  assert.equal(result.npm?.deprecated, 'use the replacement')
})

test('invalid names and missing releases return notices without fetching or throwing', async () => {
  let calls = 0
  const invalid = await resolveNpmPackage('bad name', repository, '1.0.0', {
    fetch: async () => {
      calls += 1
      throw new Error('must not fetch')
    },
    timeoutMs: 100
  })
  assert.equal(calls, 0)
  assert.ok(invalid.notice)
  assert.match(invalid.notice, /包名无效/)

  const missing = await resolveNpmPackage('qq-email-mcp', repository, '1.0.0', {
    fetch: async () => new Response(null, { status: 404 }),
    timeoutMs: 100
  })
  assert.ok(missing.notice)
  assert.match(missing.notice, /没有这个包/)
})

test('rejects invalid semver, oversized metadata, invalid JSON, and redirects', async () => {
  const cases: Array<{ response: Response; reason: RegExp }> = [
    {
      response: jsonResponse({
        'dist-tags': { latest: 'latest' },
        versions: {
          latest: { repository: 'https://github.com/xieningqing/qq-email-mcp' }
        }
      }),
      reason: /semver/
    },
    {
      response: new Response('{}', {
        status: 200,
        headers: { 'content-length': String(8 * 1024 * 1024 + 1) }
      }),
      reason: /不可用/
    },
    { response: new Response('{invalid', { status: 200 }), reason: /格式无效/ },
    { response: new Response(null, { status: 302 }), reason: /重定向/ }
  ]
  for (const entry of cases) {
    const result = await resolveNpmPackage('qq-email-mcp', repository, undefined, {
      fetch: async () => entry.response,
      timeoutMs: 100
    })
    assert.equal(result.npm, undefined)
    assert.match(result.notice, entry.reason)
  }
})

test('network failures and timeouts return a notice instead of escaping', async () => {
  const network = await resolveNpmPackage('qq-email-mcp', repository, undefined, {
    fetch: async () => {
      throw new Error('offline')
    },
    timeoutMs: 100
  })
  assert.ok(network.notice)
  assert.match(network.notice, /不可用/)

  const timeout = await resolveNpmPackage('qq-email-mcp', repository, undefined, {
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        )
      }),
    timeoutMs: 5
  })
  assert.ok(timeout.notice)
  assert.match(timeout.notice, /不可用/)
})
