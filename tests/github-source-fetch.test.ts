import assert from 'node:assert/strict'
import { gzipSync, gunzipSync } from 'node:zlib'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import {
  addGithubSource,
  fetchGithubSnapshot,
  previewGithubSource
} from '../src/main/agent/packages/github-source'
import { holdEventLoopForTests } from './helpers/holdEventLoop'

holdEventLoopForTests()

const roots: string[] = []
const sha = 'b'.repeat(40)

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function sandbox(): { root: string; cacheRoot: string; stagingRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'phi-github-fetch-'))
  roots.push(root)
  return { root, cacheRoot: join(root, 'cache'), stagingRoot: join(root, 'cache', '.staging') }
}

function responseFor(bytes: Buffer): typeof fetch {
  return async () =>
    new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.length) }
    })
}

function tarWithType(path: string, type: string): Buffer {
  const tar = gunzipSync(createDeterministicTarGz([{ path, data: Buffer.alloc(0) }]))
  tar[156] = type.charCodeAt(0)
  tar.fill(0x20, 148, 156)
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0)
  tar.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  tar[154] = 0
  tar[155] = 0x20
  return gzipSync(tar)
}

function paxPathArchive(path: string): Buffer {
  const body = `path=${path}\n`
  let length = body.length + 3
  while (`${length} ${body}`.length !== length) length = `${length} ${body}`.length
  const tar = gunzipSync(
    createDeterministicTarGz([
      { path: '000-pax', data: Buffer.from(`${length} ${body}`) },
      { path: 'root/file', data: Buffer.from('x') }
    ])
  )
  tar[156] = 'x'.charCodeAt(0)
  tar.fill(0x20, 148, 156)
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0)
  tar.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  tar[154] = 0
  tar[155] = 0x20
  return gzipSync(tar)
}

/** GitHub (and `git archive`) prepend a pax global header carrying the commit id. */
function githubStyleArchive(files: Array<{ path: string; data: Buffer }>): Buffer {
  const body = `comment=${sha}\n`
  let length = body.length + 3
  while (`${length} ${body}`.length !== length) length = `${length} ${body}`.length
  const tar = gunzipSync(
    createDeterministicTarGz([
      { path: 'pax_global_header', data: Buffer.from(`${length} ${body}`) },
      ...files
    ])
  )
  // Entries are sorted by name, so the global header is the first block.
  assert.equal(tar.subarray(0, 17).toString('utf8'), 'pax_global_header')
  tar[156] = 'g'.charCodeAt(0)
  tar.fill(0x20, 148, 156)
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0)
  tar.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  tar[154] = 0
  tar[155] = 0x20
  return gzipSync(tar)
}

test('accepts the pax global header that real GitHub tarballs start with', async () => {
  const fixture = sandbox()
  const archive = githubStyleArchive([
    { path: `repo-${sha}/phi-package.yaml`, data: Buffer.from('schemaVersion: 1\n') },
    { path: `repo-${sha}/nested/readme.txt`, data: Buffer.from('hello') }
  ])
  const source = await fetchGithubSnapshot(
    { owner: 'acme', name: 'repo', repo: 'acme/repo' },
    sha,
    { cacheRoot: fixture.cacheRoot, fetch: responseFor(archive) }
  )
  assert.equal(readFileSync(join(source, 'nested', 'readme.txt'), 'utf8'), 'hello')
  assert.equal(existsSync(join(source, 'pax_global_header')), false)
})

test('still rejects a lookalike special file that is not the pax global header', async () => {
  const fixture = sandbox()
  const archive = tarWithType(`repo-${sha}/pax_global_header`, 'g')
  await assert.rejects(
    fetchGithubSnapshot({ owner: 'acme', name: 'repo', repo: 'acme/repo' }, sha, {
      cacheRoot: fixture.cacheRoot,
      fetch: responseFor(archive)
    }),
    /特殊文件|顶层目录/
  )
})

test('downloads a bounded GitHub tarball and atomically exposes its stripped source tree', async () => {
  const fixture = sandbox()
  const archive = createDeterministicTarGz([
    { path: `repo-${sha}/phi-package.yaml`, data: Buffer.from('schemaVersion: 1\n') },
    { path: `repo-${sha}/nested/readme.txt`, data: Buffer.from('hello'), mode: 0o640 }
  ])
  const requests: string[] = []
  const source = await fetchGithubSnapshot(
    { owner: 'acme', name: 'repo', repo: 'acme/repo' },
    sha,
    {
      cacheRoot: fixture.cacheRoot,
      tmpDir: fixture.stagingRoot,
      fetch: async (input) => {
        requests.push(String(input))
        return new Response(archive, { status: 200 })
      }
    }
  )

  assert.equal(source, join(fixture.cacheRoot, 'acme', 'repo', sha, 'src'))
  assert.equal(requests[0], `https://codeload.github.com/acme/repo/tar.gz/${sha}`)
  assert.equal(readFileSync(join(source, 'nested', 'readme.txt'), 'utf8'), 'hello')
  assert.equal(
    await fetchGithubSnapshot({ owner: 'acme', name: 'repo', repo: 'acme/repo' }, sha, {
      cacheRoot: fixture.cacheRoot,
      tmpDir: fixture.stagingRoot,
      fetch: async () => {
        throw new Error('complete snapshots must be reused')
      }
    }),
    source
  )
})

test('rejects unsafe tar entries and removes every staging artifact', async () => {
  const prefix = `repo-${sha}`
  const malicious = [
    createDeterministicTarGz([{ path: `${prefix}/../../escape`, data: Buffer.from('x') }]),
    createDeterministicTarGz([{ path: `/root/absolute`, data: Buffer.from('x') }]),
    paxPathArchive(`${prefix}/bad\0name`),
    tarWithType(`${prefix}/link`, '2'),
    tarWithType(`${prefix}/hardlink`, '1'),
    tarWithType(`${prefix}/device`, '3')
  ]
  for (const [index, archive] of malicious.entries()) {
    const fixture = sandbox()
    await assert.rejects(
      fetchGithubSnapshot({ owner: 'acme', name: `repo${index}`, repo: `acme/repo${index}` }, sha, {
        cacheRoot: fixture.cacheRoot,
        tmpDir: fixture.stagingRoot,
        fetch: responseFor(archive)
      }),
      /压缩包|路径|链接|文件|安全/
    )
    assert.equal(existsSync(join(fixture.cacheRoot, 'acme', `repo${index}`, sha)), false)
    assert.deepEqual(existsSync(fixture.stagingRoot) ? readdirSync(fixture.stagingRoot) : [], [])
  }
})

test('enforces compressed, expanded, entry-count, and depth bounds', async () => {
  const fixture = sandbox()
  const prefix = `repo-${sha}`
  const cases: Array<{ archive: Buffer; limits: Record<string, number> }> = [
    {
      archive: createDeterministicTarGz([{ path: `${prefix}/a`, data: Buffer.from('123456') }]),
      limits: { maxCompressedBytes: 10 }
    },
    {
      archive: createDeterministicTarGz([{ path: `${prefix}/bomb`, data: Buffer.alloc(20_000) }]),
      limits: { maxExpandedBytes: 1024 }
    },
    {
      archive: createDeterministicTarGz([
        { path: `${prefix}/a`, data: Buffer.from('a') },
        { path: `${prefix}/b`, data: Buffer.from('b') }
      ]),
      limits: { maxEntries: 1 }
    },
    {
      archive: createDeterministicTarGz([
        {
          path: `${prefix}/${Array.from({ length: 13 }, (_, index) => `d${index}`).join('/')}/x`,
          data: Buffer.from('x')
        }
      ]),
      limits: { maxDepth: 12 }
    }
  ]

  for (const [index, entry] of cases.entries()) {
    await assert.rejects(
      fetchGithubSnapshot(
        { owner: 'acme', name: `bounded${index}`, repo: `acme/bounded${index}` },
        sha,
        {
          cacheRoot: fixture.cacheRoot,
          tmpDir: fixture.stagingRoot,
          fetch: responseFor(entry.archive),
          limits: entry.limits
        }
      ),
      /限制|压缩包|大小|条目|深度/
    )
  }
})

test('times out a response body that stops making progress', async () => {
  const fixture = sandbox()
  await assert.rejects(
    fetchGithubSnapshot({ owner: 'acme', name: 'timeout', repo: 'acme/timeout' }, sha, {
      cacheRoot: fixture.cacheRoot,
      tmpDir: fixture.stagingRoot,
      timeoutMs: 10,
      fetch: async () => new Response(new ReadableStream<Uint8Array>())
    }),
    /读取超时/
  )
  assert.deepEqual(existsSync(fixture.stagingRoot) ? readdirSync(fixture.stagingRoot) : [], [])
})

test('previews an ordinary Node repository as a local draft but still rejects source import', async () => {
  const fixture = sandbox()
  const archive = createDeterministicTarGz([
    {
      path: `qq-email-mcp-${sha}/package.json`,
      data: Buffer.from(
        JSON.stringify({
          name: 'qq-email-mcp',
          version: '0.1.1',
          bin: { 'qq-email-mcp': 'dist/index.js' },
          scripts: { build: 'tsc -p tsconfig.json' },
          engines: { node: '>=20.19' },
          repository: {
            url: 'git+https://github.com/xieningqing/qq-email-mcp.git'
          }
        })
      )
    },
    {
      path: `qq-email-mcp-${sha}/README.md`,
      data: Buffer.from('# QQ Email MCP\n\n```sh\nnpx -y qq-email-mcp init\n```\n')
    }
  ])
  const requests: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({ sha }), { status: 200 })
    }
    if (url.startsWith('https://codeload.github.com/'))
      return new Response(archive, { status: 200 })
    if (url === 'https://registry.npmjs.org/qq-email-mcp') {
      return new Response(
        JSON.stringify({
          'dist-tags': { latest: '0.1.1' },
          versions: {
            '0.1.1': {
              version: '0.1.1',
              repository: {
                url: 'git+https://github.com/xieningqing/qq-email-mcp.git'
              }
            }
          }
        }),
        { status: 200 }
      )
    }
    throw new Error(`unexpected request ${url}`)
  }
  const options = { agentDir: join(fixture.root, 'agent'), fetch: fetcher }

  const preview = await previewGithubSource('https://github.com/xieningqing/qq-email-mcp', options)
  assert.deepEqual(preview.packages, [])
  assert.equal(preview.projectHint?.kind, 'node')
  assert.equal(preview.projectHint?.needsBuild, true)
  assert.deepEqual(preview.projectHint?.npm, {
    name: 'qq-email-mcp',
    version: '0.1.1',
    repositoryMatches: true
  })
  assert.deepEqual(preview.localDraft, {
    suggestedName: 'qq-email-mcp',
    command: 'x',
    args: ['--bun', 'qq-email-mcp@0.1.1'],
    runtimeHint: 'bun',
    setup: {
      readmeUrl: `https://github.com/xieningqing/qq-email-mcp/blob/${sha}/README.md`,
      commands: ['npx -y qq-email-mcp init']
    }
  })
  assert.ok(
    preview.projectHint?.notices.includes(
      '将通过 Phi 内置 Bun 运行 npm 发布的 qq-email-mcp@0.1.1（不是这个仓库提交的源码）。Bun 以 Node 兼容模式运行，个别依赖可能不兼容；依赖版本不锁定，每次启动会联网。'
    )
  )
  assert.ok(
    preview.projectHint?.notices.includes(
      '如果该服务需要先运行初始化命令（例如 init），请先在终端完成，再添加。'
    )
  )
  assert.equal(requests.filter((url) => url.startsWith('https://registry.npmjs.org/')).length, 1)

  await assert.rejects(
    addGithubSource({ url: 'https://github.com/xieningqing/qq-email-mcp', sha }, options),
    /没有可导入的 MCP 连接器/
  )
})
