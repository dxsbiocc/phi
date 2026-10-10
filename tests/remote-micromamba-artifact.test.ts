import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  describeRemoteMicromambaArtifact,
  getRemoteMicromambaArtifact,
  REMOTE_MICROMAMBA_TARGETS
} from '../src/main/agent/remote-micromamba-artifact'
import { MICROMAMBA_PLATFORM_IDS } from '../scripts/runtime/fetch-micromamba.mjs'

const bytes = Buffer.from('fake micromamba executable')
const sha256 = createHash('sha256').update(bytes).digest('hex')

function fixture(root: string): { agentDir: string; manifestPath: string; localPath: string } {
  const agentDir = join(root, 'agent')
  const manifestPath = join(root, 'manifest.json')
  const localPath = join(
    agentDir,
    'cache',
    'remote-micromamba',
    'test-version',
    'linux-x64',
    'micromamba'
  )
  writeFileSync(
    manifestPath,
    JSON.stringify({
      micromamba: {
        version: 'test-version',
        platforms: {
          'linux-x64': { url: 'https://example.test/micromamba', sha256, size: bytes.length }
        }
      }
    })
  )
  return { agentDir, manifestPath, localPath }
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-micromamba-artifact-'))
  try {
    await body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function within<T>(promise: Promise<T>, milliseconds = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out waiting for test signal')),
          milliseconds
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test('remote capability platforms map to dedicated manifest targets without expanding desktop bundles', () => {
  const agentDir = '/tmp/phi-agent'
  const manifest = JSON.parse(readFileSync('resources/runtime/manifest.json', 'utf8')) as {
    micromamba: {
      platforms: Record<string, { url: string; sha256: string; size?: number }>
    }
  }

  assert.deepEqual(REMOTE_MICROMAMBA_TARGETS, ['linux-x64', 'linux-arm64'])
  assert.deepEqual(MICROMAMBA_PLATFORM_IDS, ['darwin-arm64', 'darwin-x64', 'linux-x64'])

  const x64 = describeRemoteMicromambaArtifact(
    { os: 'linux', arch: 'x86_64', libc: { name: 'glibc', version: '2.17' } },
    { agentDir }
  )
  assert.deepEqual(x64, {
    version: '2.9.0-0',
    platform: 'linux-x64',
    localPath: join(agentDir, 'cache', 'remote-micromamba', '2.9.0-0', 'linux-x64', 'micromamba'),
    sha256: '366cd9cd8be14df1ab8ed50352a82111082a36686b2d389fdb79a92c3fafb3e3',
    size: 18_292_808,
    url: 'https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-linux-64'
  })

  const arm64 = describeRemoteMicromambaArtifact(
    { os: 'linux', arch: 'aarch64', libc: { name: 'glibc', version: '2.35' } },
    { agentDir }
  )
  assert.equal(arm64.platform, 'linux-arm64')
  assert.equal(arm64.size, 22_020_296)
  assert.equal(
    arm64.url,
    'https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-linux-aarch64'
  )
  assert.deepEqual(manifest.micromamba.platforms['linux-x64'], {
    url: x64.url,
    sha256: x64.sha256,
    size: x64.size
  })
  assert.deepEqual(manifest.micromamba.platforms['linux-arm64'], {
    url: arm64.url,
    sha256: '9f93b974adcb4d166996af969b6cd371287d1a3e52733704727884d9b74cb7a7',
    size: arm64.size
  })
})

test('a verified cached artifact is reused without downloading', async () => {
  await withRoot(async (root) => {
    const { agentDir, manifestPath, localPath } = fixture(root)
    mkdirSync(join(localPath, '..'), { recursive: true })
    writeFileSync(localPath, bytes)

    const artifact = await getRemoteMicromambaArtifact(
      { os: 'linux', arch: 'amd64', libc: { name: 'glibc' } },
      {
        agentDir,
        manifestPath,
        download: async () => {
          throw new Error('verified cache must not download')
        }
      }
    )

    assert.deepEqual(artifact, {
      version: 'test-version',
      platform: 'linux-x64',
      localPath,
      sha256,
      size: bytes.length
    })
  })
})

test('a cache miss downloads to a temporary file and publishes only verified bytes', async () => {
  await withRoot(async (root) => {
    const { agentDir, manifestPath, localPath } = fixture(root)
    const progress: Array<{ downloadedBytes: number; totalBytes: number }> = []
    let destination = ''

    const artifact = await getRemoteMicromambaArtifact(
      { os: 'linux', arch: 'x86_64', libc: { name: 'glibc' } },
      {
        agentDir,
        manifestPath,
        timeoutMs: 1234,
        onProgress: (event) => progress.push(event),
        download: async (request) => {
          destination = request.destination
          assert.notEqual(request.destination, localPath)
          assert.equal(dirname(request.destination), dirname(localPath))
          assert.equal(request.expectedSize, bytes.length)
          assert.equal(request.timeoutMs, 1234)
          writeFileSync(request.destination, bytes)
          request.onProgress?.({ downloadedBytes: bytes.length, totalBytes: bytes.length })
        }
      }
    )

    assert.equal(artifact.localPath, localPath)
    assert.deepEqual(readFileSync(localPath), bytes)
    assert.deepEqual(progress, [{ downloadedBytes: bytes.length, totalBytes: bytes.length }])
    assert.deepEqual(readdirSync(dirname(localPath)), ['micromamba'])
    assert.notEqual(destination, '')
  })
})

test('concurrent requests for one target share a single download', async () => {
  await withRoot(async (root) => {
    const { agentDir, manifestPath } = fixture(root)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let downloads = 0
    const download = async (request: { destination: string }): Promise<void> => {
      downloads += 1
      markStarted()
      await gate
      writeFileSync(request.destination, bytes)
    }
    const platform = { os: 'linux', arch: 'x86_64', libc: { name: 'glibc' as const } }
    const options = { agentDir, manifestPath, download }

    const first = getRemoteMicromambaArtifact(platform, options)
    const second = getRemoteMicromambaArtifact(platform, options)
    await within(started)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(downloads, 1)
    release()

    const [one, two] = await Promise.all([first, second])
    assert.deepEqual(two, one)
    assert.equal(downloads, 1)
  })
})

test('the default downloader streams through the reusable transfer implementation', async () => {
  await withRoot(async (root) => {
    const { agentDir, manifestPath, localPath } = fixture(root)
    const progress: number[] = []
    let requests = 0

    const artifact = await getRemoteMicromambaArtifact(
      { os: 'linux', arch: 'x86_64', libc: { name: 'glibc' } },
      {
        agentDir,
        manifestPath,
        timeoutMs: 1000,
        fetch: (async (_input, init) => {
          requests += 1
          assert.ok(init?.signal)
          return new Response(bytes, {
            headers: { 'content-length': String(bytes.length) }
          })
        }) as typeof fetch,
        onProgress: ({ downloadedBytes }) => progress.push(downloadedBytes)
      }
    )

    assert.equal(requests, 1)
    assert.equal(artifact.localPath, localPath)
    assert.deepEqual(readFileSync(localPath), bytes)
    assert.deepEqual(progress, [bytes.length])
  })
})

test('a same-size tampered cache entry is replaced from the verified download', async () => {
  await withRoot(async (root) => {
    const { agentDir, manifestPath, localPath } = fixture(root)
    mkdirSync(dirname(localPath), { recursive: true })
    writeFileSync(localPath, Buffer.alloc(bytes.length))
    let downloads = 0

    await getRemoteMicromambaArtifact(
      { os: 'linux', arch: 'x86_64', libc: { name: 'glibc' } },
      {
        agentDir,
        manifestPath,
        download: async ({ destination }) => {
          downloads += 1
          writeFileSync(destination, bytes)
        }
      }
    )

    assert.equal(downloads, 1)
    assert.deepEqual(readFileSync(localPath), bytes)
  })
})

test('hash mismatches and download failures remove every temporary file', async () => {
  await withRoot(async (root) => {
    const { agentDir, manifestPath, localPath } = fixture(root)
    const platform = { os: 'linux', arch: 'x86_64', libc: { name: 'glibc' as const } }

    await assert.rejects(
      getRemoteMicromambaArtifact(platform, {
        agentDir,
        manifestPath,
        download: async ({ destination }) => writeFileSync(destination, Buffer.alloc(bytes.length))
      }),
      /大小或 sha256 不匹配/
    )
    assert.deepEqual(readdirSync(dirname(localPath)), [])

    await assert.rejects(
      getRemoteMicromambaArtifact(platform, {
        agentDir,
        manifestPath,
        download: async ({ destination }) => {
          writeFileSync(destination, bytes.subarray(0, 3))
          throw new Error(`simulated transport failure under ${agentDir}`)
        }
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /micromamba linux-x64 下载失败：simulated transport failure/)
        assert.doesNotMatch(error.message, new RegExp(agentDir))
        return true
      }
    )
    assert.deepEqual(readdirSync(dirname(localPath)), [])
  })
})

test('unsupported operating systems, architectures, and libc variants fail before writing', async () => {
  await withRoot(async (root) => {
    const { agentDir, manifestPath } = fixture(root)
    let downloads = 0
    const options = {
      agentDir,
      manifestPath,
      download: async () => {
        downloads += 1
      }
    }

    await assert.rejects(
      getRemoteMicromambaArtifact(
        { os: 'darwin', arch: 'arm64', libc: { name: 'unknown' } },
        options
      ),
      /不支持.*仅支持 Linux/
    )
    await assert.rejects(
      getRemoteMicromambaArtifact(
        { os: 'linux', arch: 'ppc64le', libc: { name: 'glibc' } },
        options
      ),
      /不支持.*架构 ppc64le/
    )
    await assert.rejects(
      getRemoteMicromambaArtifact({ os: 'linux', arch: 'x86_64', libc: { name: 'musl' } }, options),
      /不支持.*需要 glibc.*musl/
    )
    await assert.rejects(
      getRemoteMicromambaArtifact({ os: 'linux', arch: 'x86_64' }, options),
      /不支持.*未知 libc/
    )
    assert.equal(downloads, 0)
    assert.equal(existsSync(agentDir), false)
  })
})

test('the default downloader times out and cleans staging files', async () => {
  await withRoot(async (root) => {
    const { agentDir, manifestPath, localPath } = fixture(root)
    const fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason ?? new Error('aborted')),
          { once: true }
        )
      })) as typeof globalThis.fetch

    await assert.rejects(
      getRemoteMicromambaArtifact(
        { os: 'linux', arch: 'x86_64', libc: { name: 'glibc' } },
        { agentDir, manifestPath, fetch, timeoutMs: 20 }
      ),
      /下载请求超时/
    )
    assert.deepEqual(readdirSync(dirname(localPath)), [])
  })
})
