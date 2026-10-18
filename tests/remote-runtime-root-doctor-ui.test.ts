import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import test from 'node:test'

import { ThemeProvider, createTheme } from '@mui/material/styles'

import { RemoteDoctorPanel } from '../src/renderer/src/features/wrapper/components/RemoteDoctorPanel'
import { RemoteHostProfilesPanel } from '../src/renderer/src/features/wrapper/components/RemoteHostProfilesPanel'
import { CAPABILITY_PROFILE } from './helpers/remoteRuntimeRootUiFixtures'

test('a fresh connection doctor reports the runtime root as unchecked instead of passing', () => {
  const key = 'fresh-host'
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(RemoteDoctorPanel, {
        targetKey: key,
        state: {
          phase: 'done',
          key,
          report: {
            hostProfileId: 'host-1',
            checkedAt: '2026-10-09T00:00:00.000Z',
            ok: true,
            checks: [
              { id: 'ssh', status: 'ok', message: 'Non-interactive SSH connection succeeded' }
            ]
          }
        }
      })
    )
  )

  assert.match(markup, /Runtime root: not checked/)
  assert.doesNotMatch(markup, />Check passed</)
})

test('a runtime-root check marks its host row busy even though it uses a candidate-specific key', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(RemoteHostProfilesPanel, {
        hosts: [{ id: 'host-1', label: 'GPU', hostAlias: 'gpu' }],
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
          'host-1': { phase: 'running', key: 'candidate-specific-runtime-root-key' }
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
        initialSelectedHostAlias: 'gpu'
      })
    )
  )

  assert.match(markup, /Testing GPU/)
  assert.match(markup, /<button[^>]*disabled[^>]*>Saving…<\/button>/)
})

test('a cached runtime-root timeout prevents an overall passing doctor summary', () => {
  const key = 'cached-runtime-root'
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(RemoteDoctorPanel, {
        targetKey: key,
        state: {
          phase: 'done',
          key,
          report: {
            hostProfileId: 'host-1',
            checkedAt: '2026-10-09T00:00:00.000Z',
            ok: true,
            checks: [
              { id: 'ssh', status: 'ok', message: 'Non-interactive SSH connection succeeded' }
            ],
            capabilityProfile: {
              ...CAPABILITY_PROFILE,
              runtimeRoot: {
                source: 'host',
                checkedAt: '2026-10-09T00:00:00.000Z',
                status: 'timed-out',
                hasHardError: false,
                warningCodes: [],
                checks: {
                  pathResolution: 'unknown',
                  creation: 'unknown',
                  ownership: 'unknown',
                  permissions: 'unknown',
                  filesystem: 'unknown',
                  space: 'unknown',
                  executable: 'unknown',
                  sharedFilesystem: 'unknown'
                }
              }
            }
          }
        }
      })
    )
  )

  assert.match(markup, /Check completed with warnings/)
  assert.match(markup, /Runtime root source: Host · Check timed out/)
  assert.doesNotMatch(markup, />Check passed</)
})
