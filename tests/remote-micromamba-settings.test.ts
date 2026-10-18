import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  installRemoteMicromambaForHost,
  type RemoteMicromambaSettingsDependencies
} from '../src/main/agent/remote-micromamba-settings'
import type { RemoteMicromambaResult } from '../src/shared/remoteMicromambaTypes'
import type { RemoteRuntimeRootCheckResult } from '../src/shared/remoteRuntimeRootTypes'
import { remoteTransferHostKey } from '../src/main/agent/transfer'

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
    installPath: '/data/runtime/bin/micromamba-2.9.0-0/micromamba',
    warningCodes: [] as const,
    message: 'micromamba 已安装并验证。'
  }
}

function checkedRoot(): RemoteRuntimeRootCheckResult {
  return {
    configured: '/data/runtime',
    checkedAt: '2026-10-11T00:00:00.000Z',
    status: 'checked',
    expandedPath: '/data/runtime',
    exists: true,
    nearestExistingAncestor: '/data/runtime',
    ancestorWritable: true,
    ownedByCurrentUser: true,
    groupOrOtherWritable: false,
    hasSymlink: false,
    fsType: 'nfs4',
    availableKiB: 20_000_000,
    diskUsePercent: 20,
    inodeUsePercent: 10,
    executable: true,
    writeCapacity: 'ok',
    sharedFilesystem: true,
    packageCache: { entryCount: 0, bytes: 0 },
    computeNodeVisibility: 'unknown',
    hardErrors: [],
    warnings: [
      { code: 'shared-filesystem-info', message: '共享文件系统', consequence: '稍后验证计算节点' }
    ]
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
          assert.equal(input.transferHostKey, remoteTransferHostKey('cluster'))
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
      /SSH server profile not found/
    )
  })

  it('reuses the completed root check when warning confirmation retries installation', async () => {
    let rootChecks = 0
    let ensureCalls = 0
    const dependencies: RemoteMicromambaSettingsDependencies = {
      getHostProfile: () => ({ id: 'host-cache', label: 'Cluster', hostAlias: 'cluster' }),
      connect: async () => ({ close: async () => undefined }) as never,
      probePlatform: async () => ({
        os: 'linux',
        arch: 'x86_64',
        libc: { name: 'glibc' as const }
      }),
      getArtifact: async () => artifact,
      checkRuntimeRoot: async () => {
        rootChecks += 1
        return checkedRoot()
      },
      ensure: async (session, input) => {
        ensureCalls += 1
        assert.ok(input.checkRuntimeRoot)
        await input.checkRuntimeRoot(session, input.runtimeRoot)
        return ensureCalls === 1
          ? {
              ...installedResult(),
              status: 'needs-confirmation' as const,
              warningCodes: ['shared-filesystem-info' as const]
            }
          : installedResult()
      }
    }

    const first = await installRemoteMicromambaForHost(
      'host-cache',
      { runtimeRoot: '/data/runtime', confirmedWarnings: [] },
      dependencies
    )
    const second = await installRemoteMicromambaForHost(
      'host-cache',
      { runtimeRoot: '/data/runtime', confirmedWarnings: ['shared-filesystem-info'] },
      dependencies
    )

    assert.equal(first.status, 'needs-confirmation')
    assert.equal(second.status, 'installed')
    assert.equal(rootChecks, 1)
  })

  it('persists a micromamba run verification failure as unusable', async () => {
    let savedStatus = ''
    const failed = {
      ...installedResult(),
      status: 'failed' as const,
      errorCode: 'run-verification-failed' as const,
      message: 'micromamba run 激活验证失败。'
    }
    const result = await installRemoteMicromambaForHost(
      'host-1',
      { runtimeRoot: '/data/runtime' },
      {
        getHostProfile: () => ({ id: 'host-1', label: 'Cluster', hostAlias: 'cluster' }),
        connect: async () => ({ close: async () => undefined }) as never,
        probePlatform: async () => ({
          os: 'linux',
          arch: 'x86_64',
          libc: { name: 'glibc' as const }
        }),
        getArtifact: async () => artifact,
        ensure: async () => failed,
        updateLatestProfile: (_alias, status) => {
          savedStatus = `${status.status}:${'version' in status ? status.version : ''}`
        }
      }
    )

    assert.deepEqual(result, failed)
    assert.equal(savedStatus, 'unusable:2.9.0-0')
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

  for (const detail of [
    'Unsupported: remote micromamba requires glibc; detected musl',
    '不支持 musl 远程主机；micromamba 需要 glibc。'
  ]) {
    it(`returns an unsupported result without attempting upload: ${detail}`, async () => {
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
            throw new Error(detail)
          },
          ensure: async () => {
            ensured = true
            return installedResult()
          }
        }
      )

      assert.equal(result.status, 'unsupported')
      assert.equal(result.message, detail)
      assert.equal(ensured, false)
    })
  }
})
