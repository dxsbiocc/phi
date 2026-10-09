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
            checks: [{ id: 'ssh', status: 'ok', message: 'SSH 非交互连接成功' }]
          }
        }
      })
    )
  )

  assert.match(markup, /运行时根目录：未检查/)
  assert.doesNotMatch(markup, />检查通过</)
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
        onRuntimeRootSave: () => undefined,
        onRuntimeRootCheck: () => undefined
      })
    )
  )

  assert.match(markup, /正在测试 GPU/)
  assert.match(markup, /<button[^>]*disabled[^>]*>保存<\/button>/)
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
            checks: [{ id: 'ssh', status: 'ok', message: 'SSH 非交互连接成功' }],
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

  assert.match(markup, /检查完成，存在提醒/)
  assert.match(markup, /运行时根目录：来自主机 · 检测超时/)
  assert.doesNotMatch(markup, />检查通过</)
})
