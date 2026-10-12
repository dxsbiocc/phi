import assert from 'node:assert/strict'
import test from 'node:test'

import { parseGithubRepoUrl, resolveGithubRef } from '../src/main/agent/packages/github-source'
import { parseGitRefAdvertisement } from '../src/main/agent/packages/github-git-refs'

test('accepts canonical GitHub repository URLs with optional .git and tree refs', () => {
  assert.deepEqual(parseGithubRepoUrl('https://github.com/OpenAI/example'), {
    owner: 'OpenAI',
    name: 'example',
    repo: 'OpenAI/example'
  })
  assert.deepEqual(parseGithubRepoUrl('https://github.com/acme/repo.git/'), {
    owner: 'acme',
    name: 'repo',
    repo: 'acme/repo'
  })
  assert.deepEqual(parseGithubRepoUrl('https://github.com/acme/repo/tree/feature/import-v1'), {
    owner: 'acme',
    name: 'repo',
    repo: 'acme/repo',
    ref: 'feature/import-v1'
  })
})

test('rejects non-GitHub, credentialed, ambiguous, and traversal URLs', () => {
  const rejected = [
    'http://github.com/acme/repo',
    'https://gitlab.com/acme/repo',
    'https://github.com.evil.com/acme/repo',
    'https://github.com@evil.com/acme/repo',
    'https://user:secret@github.com/acme/repo',
    'https://github.com:443/acme/repo',
    'file:///tmp/repo',
    'https://github.com/acme/repo/issues',
    'https://github.com/acme/repo?token=secret',
    'https://github.com/acme/repo#readme',
    'https://github.com/acme/%2e%2e',
    'https://github.com/acme/repo/tree/%2e%2e/main',
    'https://github.com/acme/repo/tree/-branch',
    'https://github.com/acme/repo/tree/main/',
    'https://github.com/-bad/repo',
    'https://github.com/acme/.',
    'https://github.com/acme/..'
  ]
  for (const value of rejected) {
    assert.throws(() => parseGithubRepoUrl(value), /GitHub|仓库|地址|分支/, value)
  }
})

test('resolves refs without credentials and maps public-repository API failures', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const sha = 'a'.repeat(40)
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return new Response(JSON.stringify({ sha }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  assert.equal(
    await resolveGithubRef({ owner: 'acme', name: 'repo', repo: 'acme/repo' }, 'feature/import', {
      fetch: fetcher
    }),
    sha
  )
  const api = requests.find((request) => request.url.startsWith('https://api.github.com/'))
  assert.equal(api?.url, 'https://api.github.com/repos/acme/repo/commits/feature%2Fimport')
  const headers = new Headers(api?.init?.headers)
  assert.equal(headers.get('accept'), 'application/vnd.github+json')
  assert.equal(headers.get('authorization'), null)

  assert.equal(
    await resolveGithubRef({ owner: 'acme', name: 'repo', repo: 'acme/repo' }, sha.toUpperCase(), {
      fetch: async () => {
        throw new Error('must not fetch a pinned sha')
      }
    }),
    sha
  )

  await assert.rejects(
    resolveGithubRef({ owner: 'acme', name: 'missing', repo: 'acme/missing' }, undefined, {
      fetch: async () => new Response('', { status: 404 })
    }),
    /找不到仓库或分支（仅支持公开仓库）/
  )
  await assert.rejects(
    resolveGithubRef({ owner: 'acme', name: 'repo', repo: 'acme/repo' }, undefined, {
      fetch: async () =>
        new Response('', { status: 429, headers: { 'x-ratelimit-remaining': '0' } })
    }),
    /GitHub 请求次数已用完/
  )
})

const repository = { owner: 'acme', name: 'repo', repo: 'acme/repo' }
const headSha = 'b'.repeat(40)
const featureSha = 'c'.repeat(40)
const tagObjectSha = 'd'.repeat(40)
const peeledSha = 'e'.repeat(40)

function pkt(text: string): string {
  return `${(text.length + 4).toString(16).padStart(4, '0')}${text}`
}

function advertisement(): Buffer {
  return Buffer.from(
    [
      pkt('# service=git-upload-pack\n'),
      '0000',
      pkt(
        `${headSha} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/main agent=git/github\n`
      ),
      pkt(`${headSha} refs/heads/main\n`),
      pkt(`${featureSha} refs/heads/feature/import\n`),
      pkt(`${tagObjectSha} refs/tags/v1\n`),
      pkt(`${peeledSha} refs/tags/v1^{}\n`),
      '0000'
    ].join('')
  )
}

test('parses a git ref advertisement and prefers peeled tags', () => {
  const refs = parseGitRefAdvertisement(advertisement())
  assert.equal(refs.head, headSha)
  assert.equal(refs.resolve(undefined), headSha)
  assert.equal(refs.resolve('HEAD'), headSha)
  assert.equal(refs.resolve('main'), headSha)
  assert.equal(refs.resolve('feature/import'), featureSha)
  assert.equal(refs.resolve('v1'), peeledSha)
  assert.equal(refs.resolve('missing'), undefined)
  assert.throws(() => parseGitRefAdvertisement(Buffer.from('not a pkt line')), /引用/)
  assert.throws(
    () =>
      parseGitRefAdvertisement(
        Buffer.from(`${pkt('# service=git-upload-pack\n')}0000${pkt('zz HEAD\n')}`)
      ),
    /引用/
  )
})

test('resolves refs through the git advertisement without touching the rate-limited API', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return new Response(advertisement(), { status: 200 })
  }
  assert.equal(await resolveGithubRef(repository, undefined, { fetch: fetcher }), headSha)
  assert.equal(await resolveGithubRef(repository, 'feature/import', { fetch: fetcher }), featureSha)
  assert.equal(await resolveGithubRef(repository, 'v1', { fetch: fetcher }), peeledSha)
  assert.equal(
    requests.every((request) =>
      request.url.startsWith('https://github.com/acme/repo.git/info/refs')
    ),
    true
  )
  assert.match(requests[0]!.url, /service=git-upload-pack$/)
  const headers = new Headers(requests[0]!.init?.headers)
  assert.equal(headers.get('accept'), 'application/x-git-upload-pack-advertisement')
  assert.equal(headers.get('authorization'), null)
  assert.equal(requests[0]!.init?.credentials, 'omit')
  assert.equal(requests[0]!.init?.redirect, 'error')
})

test('falls back to the API only when the git advertisement cannot answer', async () => {
  const sha = 'a'.repeat(40)
  const calls: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith('https://github.com/')) return new Response(advertisement(), { status: 200 })
    return new Response(JSON.stringify({ sha }), { status: 200 })
  }
  // A ref that is not advertised (for example a short sha) still resolves through the API.
  assert.equal(await resolveGithubRef(repository, 'abc1234', { fetch: fetcher }), sha)
  assert.equal(calls.length, 2)

  const broken: typeof fetch = async (input) => {
    const url = String(input)
    if (url.startsWith('https://github.com/')) return new Response('oops', { status: 500 })
    return new Response(JSON.stringify({ sha }), { status: 200 })
  }
  assert.equal(await resolveGithubRef(repository, undefined, { fetch: broken }), sha)
})

test('a missing repository is reported without spending API quota', async () => {
  const urls: string[] = []
  await assert.rejects(
    resolveGithubRef(repository, undefined, {
      fetch: async (input) => {
        urls.push(String(input))
        return new Response('', { status: 404 })
      }
    }),
    /找不到仓库或分支（仅支持公开仓库）/
  )
  assert.equal(urls.length, 1)
})

test('an exhausted API quota says when it recovers', async () => {
  const reset = Math.floor(Date.now() / 1000) + 11 * 60
  await assert.rejects(
    resolveGithubRef(repository, 'abc1234', {
      fetch: async (input) =>
        String(input).startsWith('https://github.com/')
          ? new Response(advertisement(), { status: 200 })
          : new Response('', {
              status: 403,
              headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }
            })
    }),
    /GitHub 请求次数已用完（约 1[01] 分钟后恢复）/
  )
})
