import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeBrowserUrl } from '../src/main/browser/browser-policy'

test('normalizes hostnames to https', () => {
  assert.deepEqual(normalizeBrowserUrl('example.test', {}), {
    ok: true,
    url: 'https://example.test/'
  })
})

test('allows https', () => {
  assert.deepEqual(normalizeBrowserUrl('https://example.test/docs?q=browser#result', {}), {
    ok: true,
    url: 'https://example.test/docs?q=browser#result'
  })
})

test('allows loopback http', () => {
  for (const [input, expected] of [
    ['http://localhost:3000', 'http://localhost:3000/'],
    ['http://127.42.0.8:8080/path', 'http://127.42.0.8:8080/path'],
    ['http://[::1]:4173', 'http://[::1]:4173/']
  ]) {
    assert.deepEqual(normalizeBrowserUrl(input, {}), { ok: true, url: expected })
  }
})

test('rejects public http', () => {
  const result = normalizeBrowserUrl('http://example.test', {})

  assert.equal(result.ok, false)
  if (result.ok) assert.fail('public HTTP must be rejected')
  assert.equal(result.error.code, 'SCHEME_BLOCKED')
})

test('rejects unsafe schemes', () => {
  for (const input of [
    'file:///tmp/private.txt',
    'javascript:alert(1)',
    'data:text/html,hello',
    'blob:https://example.test/id',
    'devtools://devtools/bundled/inspector.html',
    'chrome://settings'
  ]) {
    const result = normalizeBrowserUrl(input, {})
    assert.equal(result.ok, false, input)
    if (result.ok) assert.fail(`${input} must be rejected`)
    assert.equal(result.error.code, 'SCHEME_BLOCKED', input)
  }
})

test('rejects dangerous scheme tokens before host-port normalization', () => {
  for (const scheme of ['javascript', 'file', 'data', 'blob', 'devtools', 'chrome']) {
    for (const suffix of ['443', '443/path?token=secret-token#secret-fragment']) {
      const input = `${scheme}:${suffix}`
      const result = normalizeBrowserUrl(input, {})

      assert.equal(result.ok, false, input)
      if (result.ok) assert.fail(`${input} must be rejected`)
      assert.equal(result.error.code, 'SCHEME_BLOCKED', input)
      assert.equal(result.error.url, undefined, input)
      assert.equal(JSON.stringify(result.error).includes('secret-token'), false, input)
      assert.equal(JSON.stringify(result.error).includes('secret-fragment'), false, input)
    }
  }
})

test('rejects embedded credentials', () => {
  for (const input of [
    'https://user@example.test',
    'https://user:password@example.test',
    'http://user:password@localhost:3000'
  ]) {
    const result = normalizeBrowserUrl(input, {})
    assert.equal(result.ok, false, input)
    if (result.ok) assert.fail(`${input} must be rejected`)
    assert.equal(result.error.code, 'INVALID_URL', input)
  }
})

test('rejects the Phi app origin', () => {
  const result = normalizeBrowserUrl('https://phi.internal/browser', {
    applicationOrigins: ['https://phi.internal']
  })

  assert.equal(result.ok, false)
  if (result.ok) assert.fail('the application origin must be rejected')
  assert.equal(result.error.code, 'SCHEME_BLOCKED')
})

test('does not expose sensitive URL content in policy errors', () => {
  const cases = [
    normalizeBrowserUrl('http://example.test/private?token=secret-token#secret-fragment', {}),
    normalizeBrowserUrl('https://user:secret-password@example.test/private', {}),
    normalizeBrowserUrl('https://phi.internal/callback?code=secret-oauth-code', {
      applicationOrigins: ['https://phi.internal']
    })
  ]

  for (const result of cases) {
    assert.equal(result.ok, false)
    if (result.ok) assert.fail('sensitive addresses must be rejected')
    const serialized = JSON.stringify(result.error)
    assert.equal(serialized.includes('secret-token'), false)
    assert.equal(serialized.includes('secret-fragment'), false)
    assert.equal(serialized.includes('secret-password'), false)
    assert.equal(serialized.includes('secret-oauth-code'), false)
  }
})

test('canonicalizes Phi app origins across case, default ports, paths, and trailing dots', () => {
  const cases = [
    {
      input: 'https://phi.internal/browser',
      applicationOrigin: 'https://PHI.Internal.:443/setup/path'
    },
    {
      input: 'https://PHI.INTERNAL.:443/browser',
      applicationOrigin: 'https://phi.internal'
    }
  ]

  for (const { input, applicationOrigin } of cases) {
    const result = normalizeBrowserUrl(input, { applicationOrigins: [applicationOrigin] })
    assert.equal(result.ok, false, input)
    if (result.ok) assert.fail(`${input} must match the application origin`)
    assert.equal(result.error.code, 'SCHEME_BLOCKED', input)
  }
})
