import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'

import { ThemeProvider, createTheme } from '@mui/material/styles'

import { RemoteRuntimeRootControl } from '../src/renderer/src/features/wrapper/components/RemoteRuntimeRootControl'
import { RemoteHostProfilesPanel } from '../src/renderer/src/features/wrapper/components/RemoteHostProfilesPanel'
import { RemoteCapabilityProfileSummary } from '../src/renderer/src/features/wrapper/components/RemoteCapabilityProfileSummary'
import { RemoteDoctorPanel } from '../src/renderer/src/features/wrapper/components/RemoteDoctorPanel'
import { WrapperExecutionTargetDialog } from '../src/renderer/src/features/wrapper/components/WrapperExecutionTargetDialog'
import {
  INITIAL_CONTROLLER_STATE,
  controllerConnectionPatch,
  controllerSaveError,
  createControllerConnection,
  createExecutionTargetDialogModel,
  deriveControllerState,
  executionTargetEnvironmentKey,
  runtimeRootCandidateKey,
  runtimeRootResolutionForController
} from '../src/renderer/src/features/wrapper/lib/wrapperExecutionTargetController'
import {
  CAPABILITY_PROFILE,
  DIALOG_ACTIONS,
  HOST,
  remoteProject,
  runtimeCheck,
  runtimeDoctorState
} from './helpers/remoteRuntimeRootUiFixtures'

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      {
        theme: createTheme({ components: { MuiDialog: { defaultProps: { disablePortal: true } } } })
      },
      element
    )
  )
}

describe('remote runtime root settings UI', () => {
  it('keeps the effective source visible without presenting an unchecked root as passing', () => {
    const markup = render(
      createElement(RemoteRuntimeRootControl, {
        label: 'Project override',
        value: '',
        effective: { source: 'default', configured: '~/.phi/runtime' },
        doctorState: { phase: 'idle' },
        doctorTargetKey: 'default-root',
        busy: false,
        onChange: () => undefined,
        onCheck: () => undefined
      })
    )

    assert.match(markup, /Project override/)
    assert.match(markup, /Effective value: ~\/.phi\/runtime, from Default/)
    assert.match(markup, /Not checked/)
    assert.doesNotMatch(markup, /Check passed/)
  })

  it('shows each checked property and explains soft-warning consequences', () => {
    const targetKey = 'project-root:/data/lab/runtime'
    const markup = render(
      createElement(RemoteRuntimeRootControl, {
        label: 'Project override',
        value: '/data/lab/runtime',
        effective: { source: 'project', configured: '/data/lab/runtime' },
        doctorState: runtimeDoctorState(
          targetKey,
          runtimeCheck({
            configured: '/data/lab/runtime',
            expandedPath: '/data/lab/runtime',
            exists: false,
            nearestExistingAncestor: '/data/lab',
            ownedByCurrentUser: false,
            groupOrOtherWritable: true,
            hasSymlink: true,
            fsType: 'nfs4',
            availableKiB: 17 * 1024 * 1024,
            diskUsePercent: 3,
            executable: false,
            sharedFilesystem: true,
            warnings: [
              {
                code: 'noexec',
                message: 'Programs cannot be executed directly at this location.',
                consequence: 'Executables in the environment may fail to start.'
              },
              {
                code: 'shared-filesystem-info',
                message: 'Shared filesystem detected.',
                consequence: 'Visibility from compute nodes has not been verified.'
              }
            ]
          })
        ),
        doctorTargetKey: targetKey,
        busy: false,
        onChange: () => undefined,
        onCheck: () => undefined,
        onConfirmWarnings: () => undefined
      })
    )

    for (const text of [
      'Resolved path',
      '/data/lab/runtime',
      'Not created yet; can be created under /data/lab',
      'Not owned by the current user',
      'Writable by the group or other users',
      'Filesystem: nfs4',
      'Remaining space: 17 GiB',
      'Not executable',
      'Shared storage; compute node visibility is unknown',
      'Programs cannot be executed directly at this location.',
      'Executables in the environment may fail to start.',
      'Use anyway'
    ]) {
      assert.match(markup, new RegExp(text))
    }
  })

  it('keeps unknown ownership, permissions, links, and executability visibly unknown', () => {
    const targetKey = 'unknown-root'
    const markup = render(
      createElement(RemoteRuntimeRootControl, {
        label: 'Project override',
        value: '/data/runtime',
        effective: { source: 'project', configured: '/data/runtime' },
        doctorState: runtimeDoctorState(
          targetKey,
          runtimeCheck({
            ownedByCurrentUser: null,
            groupOrOtherWritable: null,
            hasSymlink: null,
            executable: null
          })
        ),
        doctorTargetKey: targetKey,
        busy: false,
        onChange: () => undefined,
        onCheck: () => undefined
      })
    )

    for (const text of [
      'Owner: unknown',
      'Group or other user write access: unknown',
      'Symbolic links: unknown',
      'Execution: unknown'
    ]) {
      assert.match(markup, new RegExp(text))
    }
    assert.doesNotMatch(
      markup,
      /Owned by the current user|Not writable by the group or other users|Not executable/
    )
  })

  it('labels a runtime-root timeout as timeout rather than unavailable', () => {
    const targetKey = 'timed-out-root'
    const markup = render(
      createElement(RemoteRuntimeRootControl, {
        label: 'Project override',
        value: '',
        effective: { source: 'default', configured: '~/.phi/runtime' },
        doctorState: runtimeDoctorState(targetKey, runtimeCheck({ status: 'timed-out' })),
        doctorTargetKey: targetKey,
        busy: false,
        onChange: () => undefined,
        onCheck: () => undefined
      })
    )
    assert.match(markup, /Check timed out/)
    assert.doesNotMatch(markup, /Unavailable/)
  })

  it('shows an explicit redacted runtime-root status in capability summaries', () => {
    const unchecked = render(
      createElement(RemoteCapabilityProfileSummary, { profile: CAPABILITY_PROFILE })
    )
    assert.match(unchecked, /Runtime root: not checked/)

    const checked = render(
      createElement(RemoteCapabilityProfileSummary, {
        profile: {
          ...CAPABILITY_PROFILE,
          runtimeRoot: {
            source: 'host',
            checkedAt: '2026-10-09T00:00:00.000Z',
            status: 'checked',
            hasHardError: false,
            warningCodes: ['noexec'],
            checks: {
              pathResolution: 'ok',
              creation: 'ok',
              ownership: 'ok',
              permissions: 'ok',
              filesystem: 'ok',
              space: 'ok',
              executable: 'warning',
              sharedFilesystem: 'ok'
            }
          }
        }
      })
    )
    assert.match(checked, /Runtime root source: Host · Has warnings/)
    assert.match(checked, /Warnings: Not executable/)
    assert.doesNotMatch(checked, /\/data\/|researcher|gpu\.example/)
  })

  it('shows a runtime-root doctor result even when the legacy checks list is empty', () => {
    const targetKey = 'runtime-doctor'
    const markup = render(
      createElement(RemoteDoctorPanel, {
        targetKey,
        state: runtimeDoctorState(targetKey, runtimeCheck())
      })
    )

    assert.match(markup, /Runtime Root Check/)
    assert.match(markup, /Resolved path: \/data\/runtime/)
  })

  it('shows a compact environment editor with the saved host override', () => {
    const markup = render(
      createElement(RemoteHostProfilesPanel, {
        hosts: [{ ...HOST, runtimeRoot: '/data/researcher/phi-runtime' }],
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
        hostDoctorStates: {},
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

    assert.match(markup, /Default runtime environment/)
    assert.match(markup, /placeholder="~\/.phi\/runtime"/)
    assert.match(markup, />Save environment settings</)
    assert.match(markup, />Restore Phi defaults</)
    assert.doesNotMatch(markup, />Clear</)
    assert.doesNotMatch(markup, />Check</)
    assert.match(markup, /value="\/data\/researcher\/phi-runtime"/)
    assert.equal((markup.match(/data-shrink="true"/g) ?? []).length, 5)
  })

  it('loads and saves a project override that wins over the selected host override', () => {
    const project = remoteProject('/project/runtime/')
    const baseState = {
      ...INITIAL_CONTROLLER_STATE,
      hosts: [HOST]
    }
    const derived = deriveControllerState(project, baseState)
    const patched = {
      ...baseState,
      ...controllerConnectionPatch(derived.configured, derived)
    }

    assert.equal(patched.runtimeRootOverride, '/project/runtime/')
    assert.deepEqual(runtimeRootResolutionForController(patched), {
      source: 'project',
      configured: '/project/runtime'
    })
    assert.equal(createControllerConnection(patched, derived).runtimeRoot, '/project/runtime')
  })

  it('renders the project override and its effective source in the execution target dialog', () => {
    const project = remoteProject('/project/runtime')
    const initial = {
      ...INITIAL_CONTROLLER_STATE,
      open: true,
      remoteRoot: '/cluster/project',
      hosts: [HOST]
    }
    const firstDerived = deriveControllerState(project, initial)
    const state = {
      ...initial,
      ...controllerConnectionPatch(firstDerived.configured, firstDerived)
    }
    const derived = deriveControllerState(project, state)
    const model = createExecutionTargetDialogModel(project, state, derived)
    const markup = render(
      createElement(WrapperExecutionTargetDialog, { model, actions: DIALOG_ACTIONS })
    )
    assert.match(markup, /Project override/)
    assert.match(markup, /value="\/project\/runtime"/)
    assert.match(markup, /Effective value: \/project\/runtime, from Project/)
  })

  it('requires an explicit candidate-bound confirmation before saving a warned project root', () => {
    const project = remoteProject()
    const base = {
      ...INITIAL_CONTROLLER_STATE,
      hosts: [{ ...HOST, runtimeRoot: undefined }],
      hostProfileId: 'host-1',
      remoteRoot: '/cluster/project',
      runtimeRootOverride: '/data/runtime',
      hpc: {
        ...INITIAL_CONTROLLER_STATE.hpc,
        scheduler: 'local' as const,
        controller: 'login' as const
      }
    }
    const key = executionTargetEnvironmentKey(base, base.hpc.nextflowBin)
    const warned = {
      ...base,
      environmentState: runtimeDoctorState(
        key,
        runtimeCheck({
          ownedByCurrentUser: false,
          diskUsePercent: 91,
          warnings: [
            {
              code: 'not-owned',
              message: 'Not owned by the current user.',
              consequence: 'May become unavailable if the administrator changes permissions.'
            }
          ]
        })
      )
    }
    const derived = deriveControllerState(project, warned)

    assert.match(controllerSaveError(warned, derived) ?? '', /Use anyway/)
    assert.equal(
      controllerSaveError(
        { ...warned, runtimeRootConfirmedKey: runtimeRootCandidateKey(warned) },
        derived
      ),
      null
    )
    assert.notEqual(
      runtimeRootCandidateKey({ ...warned, runtimeRootOverride: '/data/another-runtime' }),
      runtimeRootCandidateKey(warned)
    )
  })

  it('disables project saving when the checked runtime root has a hard error', () => {
    const project = remoteProject()
    const base = {
      ...INITIAL_CONTROLLER_STATE,
      open: true,
      hosts: [HOST],
      hostProfileId: HOST.id,
      remoteRoot: '/cluster/project',
      runtimeRootOverride: '/data/runtime',
      hpc: { ...INITIAL_CONTROLLER_STATE.hpc, scheduler: 'local' as const }
    }
    const key = executionTargetEnvironmentKey(base, base.hpc.nextflowBin)
    const state = {
      ...base,
      environmentState: runtimeDoctorState(
        key,
        runtimeCheck({
          hardErrors: [
            { code: 'ancestor-not-writable', message: 'Ancestor directory is not writable.' }
          ]
        }),
        false
      )
    }
    const derived = deriveControllerState(project, state)
    const model = createExecutionTargetDialogModel(project, state, derived)
    const markup = render(
      createElement(WrapperExecutionTargetDialog, { model, actions: DIALOG_ACTIONS })
    )
    const saveButton = markup.match(/<button[^>]*>Save execution mode<\/button>/)?.[0]
    assert.ok(saveButton)
    assert.match(saveButton, /disabled/)
    const checkButton = markup.match(/<button[^>]*>Check<\/button>/)?.[0]
    assert.ok(checkButton)
    assert.doesNotMatch(checkButton, /disabled/)
    assert.match(markup, /Ancestor directory is not writable/)
  })
})
