import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'

import { ThemeProvider, createTheme } from '@mui/material/styles'

import { RemoteHostProfilesPanel } from '../src/renderer/src/features/wrapper/components/RemoteHostProfilesPanel'
import {
  remoteDoctorTargetKey,
  remoteHostDoctorTarget
} from '../src/renderer/src/features/wrapper/lib/remoteDoctorUi'
import { CAPABILITY_PROFILE, HOST } from './helpers/remoteRuntimeRootUiFixtures'

describe('remote micromamba settings UI', () => {
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
