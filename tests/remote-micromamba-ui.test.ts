import { captureWrapperUi } from './helpers/captureWrapperUi'
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
    assert.match(markup, /Outdated \(2\.8\.0\)/)
    assert.match(markup, /17\.4 MiB/)
    assert.match(markup, /\/data\/lab runtime\/bin\/micromamba-2\.9\.0-0\/micromamba/)
    assert.match(markup, /Install \/ update micromamba/)
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
          message: 'Downloading micromamba…'
        }
      },
      onInstall: () => undefined
    })

    assert.match(markup, /Downloading micromamba/)
    assert.match(markup, /50%/)
    assert.match(markup, /progressbar/)
  })

  it('shows English validation for an unsafe mirror prefix without exposing credentials', () => {
    const markup = render({
      capabilityProfile: CAPABILITY_PROFILE,
      runtimeRoot: '~/.phi/runtime',
      downloadMirrorPrefix: 'https://researcher:secret@mirror.example/path/',
      state: { phase: 'idle' },
      onInstall: () => undefined
    })

    assert.match(markup, /Download mirror prefix must not contain a username or password/)
    assert.match(markup, /Download mirror prefix \(optional\)/)
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
          message: 'Remote micromamba installed and verified.'
        }
      },
      onInstall: () => undefined
    })

    assert.match(markup, />micromamba</)
    assert.match(markup, /Installed \(2\.9\.0-0\)/)
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
          message: 'Server file verification failed. Check available space and retry.'
        }
      },
      onInstall: () => undefined
    })

    assert.match(markup, /Server file verification failed/)
    assert.match(markup, /Check available space and retry/)
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
          message: 'micromamba run activation verification failed.'
        }
      },
      onInstall: () => undefined
    })

    assert.match(markup, /Unusable \(2\.9\.0-0\)/)
    assert.match(markup, /micromamba run activation verification failed/)
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
          message: 'This location is not executable; micromamba may not run after installation.'
        }
      },
      onInstall: (warnings) => {
        calls.push(warnings ?? [])
      }
    }
    const control = captureWrapperUi(() => RemoteMicromambaControl(props))
    const button = (control.props as { children: React.ReactElement[] }).children[2]
    ;(button.props as { onClick: () => void }).onClick()
    const markup = render(props)

    assert.match(markup, /This location is not executable/)
    assert.match(markup, />Use anyway</)
    assert.deepEqual(calls, [['noexec']])
  })

  it('keeps installation controls out of the simplified host environment editor', () => {
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
          onDraftChange: () => undefined,
          onOpenAdd: () => undefined,
          onOpenEdit: () => undefined,
          onCloseDialog: () => undefined,
          onReloadConfig: () => undefined,
          onSave: () => undefined,
          onDelete: () => undefined,
          onTest: () => undefined,
          onEnvironmentSave: () => undefined,
          initialSelectedHostAlias: HOST.hostAlias
        })
      )
    )

    assert.match(markup, /micromamba path/)
    assert.match(markup, /Installed by Phi in the runtime directory/)
    assert.doesNotMatch(markup, /Install \/ update micromamba|Advanced Download Settings/)
  })
})
