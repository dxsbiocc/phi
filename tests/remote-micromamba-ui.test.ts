import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'

import { ThemeProvider, createTheme } from '@mui/material/styles'

import { RemoteMicromambaControl } from '../src/renderer/src/features/wrapper/components/RemoteMicromambaControl'
import { RemoteHostProfilesPanel } from '../src/renderer/src/features/wrapper/components/RemoteHostProfilesPanel'
import {
  remoteDoctorTargetKey,
  remoteHostDoctorTarget
} from '../src/renderer/src/features/wrapper/lib/remoteDoctorUi'
import { CAPABILITY_PROFILE, HOST } from './helpers/remoteRuntimeRootUiFixtures'

function render(props: React.ComponentProps<typeof RemoteMicromambaControl>): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(RemoteMicromambaControl, props)
    )
  )
}

describe('remote micromamba settings UI', () => {
  it('shows the cached status, upload size, and configured target before installation', () => {
    const markup = render({
      capabilityProfile: {
        ...CAPABILITY_PROFILE,
        runtimeRoot: {
          source: 'host',
          checkedAt: '2026-10-10T00:00:00.000Z',
          status: 'checked',
          hasHardError: false,
          warningCodes: [],
          micromamba: { status: 'outdated', version: '2.8.0' },
          checks: {
            pathResolution: 'ok',
            creation: 'ok',
            ownership: 'ok',
            permissions: 'ok',
            filesystem: 'ok',
            space: 'ok',
            executable: 'ok',
            sharedFilesystem: 'ok'
          }
        }
      },
      runtimeRoot: '/data/lab runtime',
      state: { phase: 'idle' },
      onInstall: () => undefined
    })

    assert.match(markup, />micromamba</)
    assert.match(markup, /版本过期（2\.8\.0）/)
    assert.match(markup, /17\.4 MiB/)
    assert.match(markup, /\/data\/lab runtime\/bin\/micromamba-2\.9\.0-0\/micromamba/)
    assert.match(markup, /安装\/更新 micromamba/)
  })

  it('shows determinate transfer progress while the explicit operation is running', () => {
    const markup = render({
      capabilityProfile: CAPABILITY_PROFILE,
      runtimeRoot: '~/.phi/runtime',
      state: {
        phase: 'running',
        progress: {
          requestId: 'request-1',
          stage: 'download',
          transferredBytes: 9_146_404,
          totalBytes: 18_292_808,
          message: '正在下载 micromamba…'
        }
      },
      onInstall: () => undefined
    })

    assert.match(markup, /正在下载 micromamba/)
    assert.match(markup, /50%/)
    assert.match(markup, /progressbar/)
  })

  it('shows Chinese validation for an unsafe mirror prefix without exposing credentials', () => {
    const markup = render({
      capabilityProfile: CAPABILITY_PROFILE,
      runtimeRoot: '~/.phi/runtime',
      downloadMirrorPrefix: 'https://researcher:secret@mirror.example/path/',
      state: { phase: 'idle' },
      onInstall: () => undefined
    })

    assert.match(markup, /下载镜像前缀不能包含用户名或密码/)
    assert.match(markup, /下载镜像前缀（可选）/)
  })

  it('shows the newly installed status even before a capability profile exists', () => {
    const markup = render({
      runtimeRoot: '~/.phi/runtime',
      state: {
        phase: 'done',
        result: {
          status: 'installed',
          version: '2.9.0-0',
          platform: 'linux-arm64',
          durationMs: 20,
          installPath: '/srv/runtime/bin/micromamba-2.9.0-0/micromamba',
          warningCodes: [],
          message: '远端 micromamba 安装并验证成功。'
        }
      },
      onInstall: () => undefined
    })

    assert.match(markup, />micromamba</)
    assert.match(markup, /已安装（2\.9\.0-0）/)
  })

  it('shows a friendly failure reason and suggestion', () => {
    const markup = render({
      capabilityProfile: CAPABILITY_PROFILE,
      runtimeRoot: '~/.phi/runtime',
      state: {
        phase: 'done',
        result: {
          status: 'failed',
          version: '2.9.0-0',
          platform: 'linux-x64',
          durationMs: 42,
          warningCodes: [],
          errorCode: 'remote-hash-mismatch',
          message: '服务器端文件校验失败。请检查剩余空间后重试。'
        }
      },
      onInstall: () => undefined
    })

    assert.match(markup, /服务器端文件校验失败/)
    assert.match(markup, /检查剩余空间后重试/)
  })

  it('shows run activation verification failures as unusable', () => {
    const markup = render({
      runtimeRoot: '~/.phi/runtime',
      state: {
        phase: 'done',
        result: {
          status: 'failed',
          version: '2.9.0-0',
          platform: 'linux-x64',
          durationMs: 42,
          warningCodes: [],
          errorCode: 'run-verification-failed',
          message: 'micromamba run 激活验证失败。'
        }
      },
      onInstall: () => undefined
    })

    assert.match(markup, /不可运行（2\.9\.0-0）/)
    assert.match(markup, /micromamba run 激活验证失败/)
  })

  it('uses the existing warning confirmation wording before retrying writes', () => {
    const calls: Array<readonly string[]> = []
    const props: React.ComponentProps<typeof RemoteMicromambaControl> = {
      capabilityProfile: CAPABILITY_PROFILE,
      runtimeRoot: '~/.phi/runtime',
      state: {
        phase: 'done',
        result: {
          status: 'needs-confirmation',
          version: '2.9.0-0',
          platform: 'linux-x64',
          durationMs: 12,
          warningCodes: ['noexec'],
          message: '该位置不可执行，micromamba 安装后可能无法运行。'
        }
      },
      onInstall: (warnings) => {
        calls.push(warnings ?? [])
      }
    }
    const control = RemoteMicromambaControl(props)
    const button = (control.props as { children: React.ReactElement[] }).children[2]
    ;(button.props as { onClick: () => void }).onClick()
    const markup = render(props)

    assert.match(markup, /该位置不可执行/)
    assert.match(markup, />仍然使用</)
    assert.deepEqual(calls, [['noexec']])
  })

  it('places the operation beside each host runtime-root setting', () => {
    const markup = renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(RemoteHostProfilesPanel, {
          hosts: [{ ...HOST, runtimeRoot: '/data/runtime' }],
          openSshHosts: [],
          configLoading: false,
          configError: null,
          dialogOpen: false,
          draft: {
            id: '',
            label: '',
            hostAlias: '',
            hostname: '',
            user: '',
            port: '',
            identityFile: '',
            source: 'ssh-config'
          },
          busy: false,
          error: null,
          hostDoctorStates: {
            [HOST.id]: {
              phase: 'done',
              key: remoteDoctorTargetKey(
                remoteHostDoctorTarget(HOST.id, HOST.hostAlias, '/data/runtime')
              ),
              report: {
                hostProfileId: HOST.id,
                checkedAt: '2026-10-10T00:00:00.000Z',
                ok: true,
                checks: [],
                capabilityProfile: CAPABILITY_PROFILE
              }
            }
          },
          micromambaStates: { [HOST.id]: { phase: 'idle' } },
          onDraftChange: () => undefined,
          onOpenAdd: () => undefined,
          onOpenEdit: () => undefined,
          onCloseDialog: () => undefined,
          onReloadConfig: () => undefined,
          onSave: () => undefined,
          onDelete: () => undefined,
          onTest: () => undefined,
          onRuntimeRootSave: () => undefined,
          onRuntimeRootCheck: () => undefined,
          onMicromambaInstall: () => undefined,
          initialSelectedHostAlias: HOST.hostAlias
        })
      )
    )

    assert.match(markup, /安装\/更新 micromamba/)
    assert.match(markup, /\/data\/runtime\/bin\/micromamba-2\.9\.0-0\/micromamba/)
  })
})
