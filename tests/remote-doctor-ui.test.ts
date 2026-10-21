import { captureWrapperUi } from './helpers/captureWrapperUi'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import type { RemoteDoctorReport } from '../src/shared/remoteDoctorTypes'
import { RemoteDoctorPanel } from '../src/renderer/src/features/wrapper/components/RemoteDoctorPanel'
import { RemoteHostProfilesPanel } from '../src/renderer/src/features/wrapper/components/RemoteHostProfilesPanel'
import { RemoteHostDialog } from '../src/renderer/src/features/wrapper/components/RemoteHostDialog'
import {
  createRemoteDoctorUiController,
  createRemoteHostDoctorUiController,
  remoteHostCheckPresentation,
  remoteHostIdFromDoctorKey,
  withHostDoctorState,
  remoteConnectionDoctorTarget,
  remoteDoctorTargetKey,
  remoteHostDoctorTarget,
  type RemoteDoctorUiState
} from '../src/renderer/src/features/wrapper/lib/remoteDoctorUi'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const report: RemoteDoctorReport = {
  hostProfileId: 'host-1',
  checkedAt: '2026-09-24T00:00:00.000Z',
  ok: true,
  checks: [
    { id: 'ssh', status: 'ok', message: 'Non-interactive SSH connection succeeded' },
    {
      id: 'runtime',
      status: 'warning',
      message: 'Runtime not found on the login node',
      suggestion: 'Check the compute nodes.'
    }
  ]
}

const capabilityProfile = {
  platform: { os: 'linux', arch: 'x86_64' },
  probedAt: '2026-10-09T02:00:00.000Z',
  fs: { state: 'available' },
  exec: { state: 'available' },
  background: { state: 'available' },
  pty: { state: 'unavailable', reason: 'Helper not installed' },
  watch: { state: 'unavailable', reason: 'Helper not installed' },
  forwardPort: { state: 'unavailable', reason: 'Helper not installed' },
  probe: { state: 'available' },
  prerequisites: {
    perl: { state: 'unavailable', reason: 'Perl not found' },
    python3: { state: 'available', version: '3.11.9' },
    tar: { state: 'available' },
    sha256sum: { state: 'available' }
  },
  storage: {
    homeWritable: { state: 'available' },
    homeExecutable: { state: 'unavailable', reason: 'Execution is disabled in the home directory' },
    availableSpaceKiB: 10 * 1024 * 1024,
    sharedFileSystem: {
      state: 'degraded',
      reason: 'Could not determine whether this is a shared filesystem'
    }
  },
  toolchain: {
    git: { state: 'available', version: '2.43.0' },
    nextflow: { state: 'unavailable', reason: 'Nextflow not found' },
    java: { state: 'available', version: '17.0.12' },
    conda: { state: 'unavailable', reason: 'Conda not found' },
    sbatch: { state: 'available', version: '23.11' },
    containerRuntime: { state: 'available', version: 'Apptainer 1.3.4' },
    module: { state: 'available', version: 'Modules 5.4.0' }
  }
} satisfies NonNullable<RemoteDoctorReport['capabilityProfile']>

const hostTarget = remoteHostDoctorTarget('host-1', 'lab-hpc')

test('host test requests SSH connectivity only', () => {
  assert.deepEqual(hostTarget.options, { scope: 'connection' })
})

test('testing and retesting a saved host coalesces duplicate clicks', async () => {
  const first = deferred<RemoteDoctorReport>()
  let calls = 0
  const states: RemoteDoctorUiState[] = []
  const controller = createRemoteDoctorUiController(
    async () => {
      calls += 1
      return calls === 1 ? first.promise : report
    },
    (state) => states.push(state)
  )
  const pending = controller.check(hostTarget)
  const duplicate = controller.check(hostTarget)
  assert.equal(calls, 0)
  assert.equal(controller.getState().phase, 'running')
  first.resolve(report)
  await Promise.all([pending, duplicate])
  assert.equal(calls, 1)
  assert.equal(controller.getState().phase, 'done')
  await controller.check(hostTarget)
  assert.equal(calls, 2)
  assert.deepEqual(
    states.map((state) => state.phase),
    ['running', 'done', 'running', 'done']
  )
})

test('different SSH hosts test concurrently without replacing each other', async () => {
  const first = deferred<RemoteDoctorReport>()
  const second = deferred<RemoteDoctorReport>()
  const calls: string[] = []
  const states: Record<string, RemoteDoctorUiState> = {}
  const controller = createRemoteHostDoctorUiController(
    async (hostId) => {
      calls.push(hostId)
      return hostId === 'host-1' ? first.promise : second.promise
    },
    (hostId, state) => {
      if (state.phase === 'idle') delete states[hostId]
      else states[hostId] = state
    }
  )
  const otherTarget = remoteHostDoctorTarget('host-2', 'gpu')
  const firstCheck = controller.check(hostTarget)
  const duplicate = controller.check(hostTarget)
  const secondCheck = controller.check(otherTarget)
  await Promise.resolve()
  assert.deepEqual(calls, ['host-1', 'host-2'])
  assert.equal(controller.getState('host-1').phase, 'running')
  assert.equal(controller.getState('host-2').phase, 'running')

  second.resolve({ ...report, hostProfileId: 'host-2' })
  await secondCheck
  assert.equal(states['host-2']?.phase, 'done')
  assert.equal(states['host-1']?.phase, 'running')
  first.resolve(report)
  await Promise.all([firstCheck, duplicate])
  assert.equal(states['host-1']?.phase, 'done')
  assert.equal(calls.length, 2)
  controller.dispose()
})

test('invalidating one host leaves another host check running', async () => {
  const first = deferred<RemoteDoctorReport>()
  const second = deferred<RemoteDoctorReport>()
  const controller = createRemoteHostDoctorUiController(
    (hostId) => (hostId === 'host-1' ? first.promise : second.promise),
    () => undefined
  )
  const firstCheck = controller.check(hostTarget)
  const secondCheck = controller.check(remoteHostDoctorTarget('host-2', 'gpu'))
  controller.invalidate('host-1')
  second.resolve({ ...report, hostProfileId: 'host-2' })
  await secondCheck
  first.resolve(report)
  await firstCheck
  assert.equal(controller.getState('host-1').phase, 'idle')
  assert.equal(controller.getState('host-2').phase, 'done')
  controller.dispose()
})

test('failed and timed-out checks show safe messages and can be retried', async () => {
  let calls = 0
  const controller = createRemoteDoctorUiController(
    async () => {
      calls += 1
      if (calls === 1) throw new Error('IdentityFile /secret/key; password hunter2')
      if (calls === 2) return new Promise<RemoteDoctorReport>(() => undefined)
      return report
    },
    () => undefined,
    10
  )
  await controller.check(hostTarget)
  assert.equal(controller.getState().phase, 'failed')
  assert.doesNotMatch(JSON.stringify(controller.getState()), /secret|hunter2/)
  await controller.check(hostTarget)
  assert.match(JSON.stringify(controller.getState()), /connection test timed out/)
  await controller.check(hostTarget)
  assert.equal(controller.getState().phase, 'done')
  assert.equal(calls, 3)
})

test('changing project, host alias, directory or runtime never shows an old check on the new target', async () => {
  const first = deferred<RemoteDoctorReport>()
  const second = deferred<RemoteDoctorReport>()
  let calls = 0
  const controller = createRemoteDoctorUiController(
    async () => {
      calls += 1
      return calls === 1 ? first.promise : second.promise
    },
    () => undefined
  )
  const connection = {
    id: 'conn-1',
    label: 'Lab',
    hostProfileId: 'host-1',
    hpc: { scheduler: 'slurm' as const, runtime: 'singularity' as const }
  }
  const oldTarget = remoteConnectionDoctorTarget('project-1', connection, 'lab-hpc', '/cluster/a')
  const newTarget = remoteConnectionDoctorTarget('project-2', connection, 'lab-hpc', '/cluster/a')
  assert.notEqual(remoteDoctorTargetKey(oldTarget), remoteDoctorTargetKey(newTarget))
  assert.notEqual(
    remoteDoctorTargetKey(oldTarget),
    remoteDoctorTargetKey(
      remoteConnectionDoctorTarget('project-1', connection, 'lab-hpc', '/cluster/b')
    )
  )
  assert.notEqual(
    remoteDoctorTargetKey(oldTarget),
    remoteDoctorTargetKey(
      remoteConnectionDoctorTarget('project-1', connection, 'new-alias', '/cluster/a')
    )
  )
  assert.notEqual(
    remoteDoctorTargetKey(oldTarget),
    remoteDoctorTargetKey(
      remoteConnectionDoctorTarget(
        'project-1',
        {
          ...connection,
          hpc: { scheduler: 'slurm', runtime: 'docker' }
        },
        'lab-hpc',
        '/cluster/a'
      )
    )
  )
  const oldRequest = controller.check(oldTarget)
  controller.invalidate()
  const newRequest = controller.check(newTarget)
  second.resolve({ ...report, hostProfileId: 'host-1' })
  await newRequest
  first.resolve(report)
  await oldRequest
  assert.equal(calls, 2)
  const state = controller.getState()
  assert.equal(state.phase, 'done')
  assert.equal(state.phase === 'done' ? state.key : '', remoteDoctorTargetKey(newTarget))
})

test('host failures keep a scoped warning message for the icon tooltip', () => {
  const key = remoteDoctorTargetKey(remoteHostDoctorTarget('ssh-config:gpu', 'gpu'))
  assert.equal(remoteHostIdFromDoctorKey(key), 'ssh-config:gpu')
  assert.equal(
    remoteHostIdFromDoctorKey(
      remoteDoctorTargetKey(
        remoteConnectionDoctorTarget(
          'project',
          { id: 'connection', label: 'Lab', hostProfileId: 'ssh-config:gpu' },
          'gpu',
          '/work'
        )
      )
    ),
    null
  )
  const failed: RemoteDoctorUiState = {
    phase: 'done',
    key,
    report: {
      hostProfileId: 'ssh-config:gpu',
      checkedAt: '2026-09-27T00:00:00.000Z',
      ok: false,
      checks: [
        {
          id: 'ssh',
          status: 'error',
          message: 'SSH authentication failed',
          suggestion: 'Check the key'
        }
      ]
    }
  }
  assert.deepEqual(remoteHostCheckPresentation(failed, key), {
    tone: 'error',
    message: 'SSH authentication failed — Check the key'
  })
  assert.deepEqual(
    remoteHostCheckPresentation(
      {
        phase: 'done',
        key,
        report: {
          ...report,
          ok: false,
          checks: [
            { id: 'ssh', status: 'ok', message: 'Non-interactive SSH connection succeeded' },
            { id: 'nextflow', status: 'error', message: 'Nextflow not found' }
          ]
        }
      },
      key
    ),
    { tone: 'success', message: 'SSH connection succeeded. Select to retest.' }
  )
  assert.equal(remoteHostCheckPresentation(failed, 'another-host').tone, 'idle')
  assert.equal(
    remoteHostCheckPresentation({ phase: 'failed', key, message: 'Connection test timed out' }, key)
      .message,
    'Connection test timed out'
  )
  const anotherKey = remoteDoctorTargetKey(remoteHostDoctorTarget('ssh-config:other', 'other'))
  const first = withHostDoctorState({}, { phase: 'failed', key, message: 'Authentication failed' })
  const second = withHostDoctorState(first, { phase: 'running', key: anotherKey })
  assert.equal(second['ssh-config:gpu']?.phase, 'failed')
  assert.equal(second['ssh-config:other']?.phase, 'running')
})

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

function findAction(root: ReactNode, label: string): () => void {
  const pending: ReactNode[] = [root]
  while (pending.length > 0) {
    const node = pending.pop()
    if (Array.isArray(node)) {
      pending.push(...node)
      continue
    }
    if (!isValidElement(node)) continue
    const props = node.props as {
      children?: ReactNode
      'aria-label'?: string
      onClick?: () => void
    }
    if (props['aria-label'] === label || props.children === label) {
      assert.ok(props.onClick, `${label} has no click handler`)
      return props.onClick
    }
    pending.push(props.children)
  }
  throw new Error(`Missing ${label} action`)
}

test('server card lists discovered aliases and keeps configuration fields in the dialog', () => {
  const props = {
    hosts: [{ id: 'host-1', label: 'Lab', hostAlias: 'lab-hpc' }],
    openSshHosts: [
      {
        alias: 'gpu',
        hostname: 'gpu.example.test',
        user: 'scientist',
        port: 22022,
        identityFiles: ['/tmp/test-key']
      }
    ],
    configLoading: false,
    configError: null,
    dialogOpen: false,
    draft: {
      id: '',
      label: 'gpu',
      hostAlias: 'gpu',
      hostname: 'gpu.example.test',
      user: '',
      port: '',
      identityFile: '',
      source: 'ssh-config' as const
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
    onTest: () => undefined
  }
  const markup = render(
    createElement(RemoteHostProfilesPanel, {
      ...props
    })
  )
  for (const label of [
    'aria-label="Refresh servers"',
    'aria-label="Add server"',
    'lab-hpc',
    'gpu.example.test'
  ]) {
    assert.match(markup, new RegExp(label))
  }
  assert.doesNotMatch(markup, />Add<\/button>/)
  assert.doesNotMatch(markup, /~\/\.phi\/runtime/)
  assert.doesNotMatch(markup, />Test connection<\/button>/)
  assert.match(markup, /aria-label="Configure gpu"/)
  assert.doesNotMatch(markup, /Server address|Private key path/)
  const gpuKey = remoteDoctorTargetKey(remoteHostDoctorTarget('ssh-config:gpu', 'gpu'))
  const failedMarkup = render(
    createElement(RemoteHostProfilesPanel, {
      ...props,
      hostDoctorStates: {
        'ssh-config:gpu': { phase: 'failed', key: gpuKey, message: 'Connection test timed out' }
      }
    })
  )
  assert.match(failedMarkup, /Connection failed/)
  const labKey = remoteDoctorTargetKey(remoteHostDoctorTarget('host-1', 'lab-hpc'))
  const runningMarkup = render(
    createElement(RemoteHostProfilesPanel, {
      ...props,
      hostDoctorStates: { 'host-1': { phase: 'running', key: labKey } }
    })
  )
  assert.match(runningMarkup, /Checking/)
  const savedMarkup = render(
    createElement(RemoteHostProfilesPanel, {
      ...props,
      savedAvailability: { 'ssh-config:gpu': 'available', 'host-1': 'unavailable' }
    })
  )
  assert.match(savedMarkup, /Connected/)
  assert.match(savedMarkup, /Connection failed/)
  assert.doesNotMatch(savedMarkup, /Not checked/)
  const dialogMarkup = render(
    createElement(RemoteHostDialog, {
      ...props,
      open: true,
      onClose: () => undefined,
      onPasswordBootstrap: () => undefined
    })
  )
  for (const label of ['SSH alias', 'Server address', 'Username', 'Port', 'Authentication']) {
    assert.match(dialogMarkup, new RegExp(label))
  }
  assert.doesNotMatch(dialogMarkup, /Private key path/)
  assert.doesNotMatch(dialogMarkup, /Select from ~\/.ssh\/config/)
  assert.doesNotMatch(markup, /type="password"|Passphrase input/)
})

test('server list navigates to a detail view with scoped actions', () => {
  const calls: string[] = []
  const host = { id: 'host-1', label: 'Lab', hostAlias: 'lab-hpc' }
  const props = {
    hosts: [host],
    openSshHosts: [{ alias: 'gpu', identityFiles: [] }],
    configLoading: false,
    configError: null,
    dialogOpen: false,
    draft: {
      id: '',
      label: 'New',
      hostAlias: 'new-hpc',
      hostname: 'new.example.test',
      user: '',
      port: '',
      identityFile: '',
      source: 'ssh-config' as const
    },
    busy: false,
    error: null,
    hostDoctorStates: {},
    onDraftChange: () => undefined,
    onOpenAdd: () => {
      calls.push('add')
    },
    onOpenEdit: (item: { id: string }) => {
      calls.push(`edit:${item.id}`)
    },
    onCloseDialog: () => {
      calls.push('close')
    },
    onReloadConfig: () => {
      calls.push('reload')
    },
    onSave: () => {
      calls.push('save')
    },
    onDelete: (id: string) => {
      calls.push(`delete:${id}`)
    },
    onTest: (item: { id: string }) => {
      calls.push(`test:${item.id}`)
    },
    onEnvironmentSave: () => undefined
  }
  const markup = render(createElement(RemoteHostProfilesPanel, props))
  for (const label of ['Add server', 'Configure gpu', 'Configure Lab', 'Refresh servers']) {
    assert.match(markup, new RegExp(`aria-label="${label}"`))
  }
  assert.doesNotMatch(markup, /aria-label="Test Lab"/)
  const detailMarkup = render(
    createElement(RemoteHostProfilesPanel, { ...props, initialSelectedHostAlias: 'lab-hpc' })
  )
  for (const label of ['Edit Lab', 'Delete Lab', 'Test Lab']) {
    assert.match(detailMarkup, new RegExp(`aria-label="${label}"`))
  }
  assert.match(detailMarkup, /Back to servers/)
  for (const label of [
    'Environment Settings',
    'Default runtime environment',
    'Nextflow',
    'Jupyter',
    'micromamba',
    'Docker'
  ]) {
    assert.match(detailMarkup, new RegExp(label))
  }
  assert.match(detailMarkup, /Leave blank for Phi management/)
  assert.doesNotMatch(
    detailMarkup,
    /Install \/ update micromamba|Advanced Download Settings|Server Capability Profile/
  )
  const discoveredDetailMarkup = render(
    createElement(RemoteHostProfilesPanel, { ...props, initialSelectedHostAlias: 'gpu' })
  )
  assert.match(discoveredDetailMarkup, /aria-label="Edit gpu"/)
  assert.match(discoveredDetailMarkup, /aria-label="Test gpu"/)
  assert.doesNotMatch(discoveredDetailMarkup, /aria-label="Delete gpu"/)
  const dialog = captureWrapperUi(() =>
    RemoteHostDialog({
      open: true,
      draft: props.draft,
      busy: false,
      error: null,
      onDraftChange: props.onDraftChange,
      onClose: props.onCloseDialog,
      onSave: props.onSave
    })
  )
  findAction(dialog, 'Cancel')()
  findAction(dialog, 'Add server')()
  assert.deepEqual(calls, ['close', 'save'])
})

test('server detail keeps the connection status without exposing capability diagnostics', () => {
  const host = { id: 'host-1', label: 'Lab', hostAlias: 'lab-hpc' }
  const key = remoteDoctorTargetKey(remoteHostDoctorTarget(host.id, host.hostAlias))
  const markup = render(
    createElement(RemoteHostProfilesPanel, {
      hosts: [host],
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
        [host.id]: {
          phase: 'done',
          key,
          report: { ...report, capabilityProfile }
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
      initialSelectedHostAlias: host.hostAlias
    })
  )
  assert.match(markup, /Connected/)
  assert.doesNotMatch(markup, /Server Capability Profile|Linux · x86_64|Checked at/)
})

test('result panel identifies each failed setting and shows a checked time and retry guidance', () => {
  const key = remoteDoctorTargetKey(hostTarget)
  const markup = render(
    createElement(RemoteDoctorPanel, {
      state: { phase: 'done', key, report },
      targetKey: key
    })
  )
  assert.match(markup, /Check completed with warnings/)
  assert.match(markup, /SSH connection/)
  assert.match(markup, /Container or Conda runtime/)
  assert.match(markup, /Check the compute nodes/)
  assert.match(markup, /Checked at/)
  assert.equal(
    render(
      createElement(RemoteDoctorPanel, {
        state: { phase: 'done', key, report },
        targetKey: 'another-target'
      })
    ),
    ''
  )
})

test('doctor authentication and cooldown failures link back to remote settings', () => {
  const key = remoteDoctorTargetKey(hostTarget)
  const failedMarkup = render(
    createElement(RemoteDoctorPanel, {
      state: {
        phase: 'failed',
        key,
        message:
          'SSH authentication failed and is cooling down; select Test connection in settings to retry immediately.'
      },
      targetKey: key,
      onOpenRemoteSettings: () => undefined
    })
  )
  const reportMarkup = render(
    createElement(RemoteDoctorPanel, {
      state: {
        phase: 'done',
        key,
        report: {
          ...report,
          ok: false,
          checks: [
            { id: 'ssh', status: 'error', message: 'Non-interactive SSH authentication failed' }
          ]
        }
      },
      targetKey: key,
      onOpenRemoteSettings: () => undefined
    })
  )

  assert.match(failedMarkup, /Settings → Remote/)
  assert.match(failedMarkup, /Test connection in settings to retry immediately/)
  assert.match(reportMarkup, /Settings → Remote/)
})

test('result panel summarizes the safe server capability profile without rendering unknown fields', () => {
  const key = remoteDoctorTargetKey(hostTarget)
  const capabilityReport = {
    ...report,
    capabilityProfile: {
      ...capabilityProfile,
      platform: { os: 'darwin', arch: 'arm64' },
      helperCompatibility: {
        state: 'unavailable',
        reason: 'The helper is not supported on remote macOS hosts yet'
      },
      hostname: 'private.example.test',
      homePath: '/home/private-user'
    }
  } as RemoteDoctorReport
  const markup = render(
    createElement(RemoteDoctorPanel, {
      state: { phase: 'done', key, report: capabilityReport },
      targetKey: key
    })
  )
  assert.match(markup, /Server Capability Profile/)
  assert.match(markup, /macOS · arm64/)
  assert.match(markup, /The helper is not supported on remote macOS hosts yet/)
  assert.match(markup, /Git 2\.43\.0/)
  assert.match(markup, /Nextflow: Nextflow not found/)
  assert.match(markup, /Perl: Perl not found/)
  assert.match(markup, /Execution is disabled in the home directory/)
  assert.match(markup, /Available space: 10 GiB/)
  assert.match(markup, /Helper not installed/)
  assert.doesNotMatch(markup, /private\.example\.test|\/home\/private-user/)
})

test('result panel separates directory, Nextflow and Slurm failures', () => {
  const key = remoteDoctorTargetKey(hostTarget)
  const failed: RemoteDoctorReport = {
    ...report,
    ok: false,
    checks: [
      { id: 'ssh', status: 'ok', message: 'Non-interactive SSH connection succeeded' },
      {
        id: 'path_write',
        status: 'error',
        message: 'Candidate directory is not writable',
        suggestion: 'Choose a writable working directory.'
      },
      {
        id: 'nextflow',
        status: 'error',
        message: 'Nextflow not found',
        suggestion: 'Check the Nextflow path.'
      },
      {
        id: 'slurm_submit',
        status: 'error',
        message: 'Slurm submission command not found',
        suggestion: 'Check the cluster environment.'
      }
    ]
  }
  const markup = render(
    createElement(RemoteDoctorPanel, {
      state: { phase: 'done', key, report: failed },
      targetKey: key
    })
  )
  for (const label of [
    'SSH connected; some checks need attention',
    'Directory write access',
    'Nextflow',
    'Slurm submission',
    'Choose a writable working directory'
  ]) {
    assert.match(markup, new RegExp(label))
  }
  const identityMarkup = render(
    createElement(RemoteDoctorPanel, {
      state: {
        phase: 'done',
        key,
        report: {
          ...report,
          ok: false,
          checks: [
            {
              id: 'ssh',
              status: 'error',
              message: 'SSH host key mismatch',
              suggestion: 'Verify the server fingerprint first.'
            }
          ]
        }
      },
      targetKey: key
    })
  )
  assert.match(identityMarkup, /Could not establish an SSH connection/)
  assert.match(identityMarkup, /Verify the server fingerprint first/)
})
