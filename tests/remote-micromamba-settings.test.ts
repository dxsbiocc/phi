import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installRemoteMicromambaForHost } from '../src/main/agent/remote-micromamba-settings'
import type { RemoteMicromambaResult } from '../src/shared/remoteMicromambaTypes'

const artifact = {
  version: '2.9.0-0',
  platform: 'linux-x64' as const,
  localPath: '/private/cache/micromamba',
  sha256: 'a'.repeat(64),
  size: 18_292_808
}

function installedResult(): RemoteMicromambaResult {
  return {
    status: 'installed' as const,
    version: artifact.version,
    platform: artifact.platform,
    durationMs: 25,
    installPath: '/data/runtime/bin/micromamba-2.9.0-0',
    warningCodes: [] as const,
    message: 'micromamba 已安装并验证。'
  }
}

describe('remote micromamba settings operation', () => {
  it('probes, obtains the desktop artifact, installs, persists only redacted status, and closes', async () => {
    const calls: string[] = []
    const progress: string[] = []
    const session = { close: async () => calls.push('close') }
    const result = await installRemoteMicromambaForHost(
      'host-1',
      {
        runtimeRoot: '/data/runtime',
        confirmedWarnings: [],
        onProgress: (update) => progress.push(update.stage)
      },
      {
        getHostProfile: () => ({ id: 'host-1', label: 'Cluster', hostAlias: 'cluster' }),
        connect: async () => {
          calls.push('connect')
          return session as never
        },
        probePlatform: async () => {
          calls.push('probe')
          return { os: 'linux', arch: 'x86_64', libc: { name: 'glibc' as const } }
        },
        getArtifact: async (platform, options) => {
          calls.push(`artifact:${platform.arch}`)
          options?.onProgress?.({ downloadedBytes: artifact.size, totalBytes: artifact.size })
          return artifact
        },
        ensure: async (_session, input) => {
          calls.push(`ensure:${input.runtimeRoot}`)
          return installedResult()
        },
        updateLatestProfile: (_alias, status) => {
          calls.push(`profile:${status.status}:${'version' in status ? status.version : ''}`)
          assert.equal('installPath' in status, false)
        }
      }
    )

    assert.deepEqual(result, installedResult())
    assert.deepEqual(calls, [
      'connect',
      'probe',
      'artifact:x86_64',
      'ensure:/data/runtime',
      'profile:installed:2.9.0-0',
      'close'
    ])
    assert.deepEqual(progress, ['probe', 'download', 'download', 'install'])
  })

  it('rejects a missing host before connecting', async () => {
    await assert.rejects(
      installRemoteMicromambaForHost(
        'missing',
        { runtimeRoot: '~/.phi/runtime' },
        {
          getHostProfile: () => undefined,
          connect: async () => {
            throw new Error('must not connect')
          }
        }
      ),
      /SSH 服务器档案不存在/
    )
  })

  it('puts the validated user mirror before manifest mirrors in the remote artifact plan', async () => {
    let urls: readonly string[] | undefined
    const result = await installRemoteMicromambaForHost(
      'host-1',
      {
        runtimeRoot: '/data/runtime',
        downloadMirrorPrefix: ' https://user-mirror.example/ '
      },
      {
        getHostProfile: () => ({ id: 'host-1', label: 'Cluster', hostAlias: 'cluster' }),
        connect: async () => ({ close: async () => undefined }) as never,
        probePlatform: async () => ({
          os: 'linux',
          arch: 'x86_64',
          libc: { name: 'glibc' as const }
        }),
        describeArtifact: () => ({
          ...artifact,
          url: 'https://github.com/example/micromamba',
          mirrorPrefixes: ['https://manifest-mirror.example/']
        }),
        ensure: async (_session, input) => {
          urls = input.artifact.urls
          return installedResult()
        }
      }
    )

    assert.equal(result.status, 'installed')
    assert.deepEqual(urls, [
      'https://github.com/example/micromamba',
      'https://user-mirror.example/https://github.com/example/micromamba',
      'https://manifest-mirror.example/https://github.com/example/micromamba'
    ])
  })

  it('returns an unsupported result without attempting upload', async () => {
    let ensured = false
    const result = await installRemoteMicromambaForHost(
      'host-1',
      { runtimeRoot: '~/.phi/runtime' },
      {
        getHostProfile: () => ({ id: 'host-1', label: 'Cluster', hostAlias: 'cluster' }),
        connect: async () => ({ close: async () => undefined }) as never,
        probePlatform: async () => ({
          os: 'linux',
          arch: 'x86_64',
          libc: { name: 'musl' as const }
        }),
        getArtifact: async () => {
          throw new Error('不支持 musl 远程主机；micromamba 需要 glibc。')
        },
        ensure: async () => {
          ensured = true
          return installedResult()
        }
      }
    )

    assert.equal(result.status, 'unsupported')
    assert.match(result.message, /不支持 musl/)
    assert.equal(ensured, false)
  })
})
