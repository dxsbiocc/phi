import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import type { RemoteDoctorReport } from '../src/shared/remoteDoctorTypes'
import { RemoteDoctorPanel } from '../src/renderer/src/features/wrapper/components/RemoteDoctorPanel'
import { RemoteHostProfilesPanel } from '../src/renderer/src/features/wrapper/components/RemoteHostProfilesPanel'
import { RemoteHostDialog } from '../src/renderer/src/features/wrapper/components/RemoteHostDialog'
import { RemoteProjectConnectionRow } from '../src/renderer/src/features/wrapper/components/RemoteProjectConnectionRow'
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
    { id: 'ssh', status: 'ok', message: 'SSH 非交互连接成功' },
    {
      id: 'runtime',
      status: 'warning',
      message: '登录节点未找到运行时',
      suggestion: '请检查计算节点。'
    }
  ]
}

const capabilityProfile = {
  platform: { os: 'linux', arch: 'x86_64' },
  probedAt: '2026-10-09T02:00:00.000Z',
  fs: { state: 'available' },
  exec: { state: 'available' },
  background: { state: 'available' },
  pty: { state: 'unavailable', reason: 'helper 未安装' },
  watch: { state: 'unavailable', reason: 'helper 未安装' },
  forwardPort: { state: 'unavailable', reason: 'helper 未安装' },
  probe: { state: 'available' },
  prerequisites: {
    perl: { state: 'unavailable', reason: '未发现 Perl' },
    python3: { state: 'available', version: '3.11.9' },
    tar: { state: 'available' },
    sha256sum: { state: 'available' }
  },
  storage: {
    homeWritable: { state: 'available' },
    homeExecutable: { state: 'unavailable', reason: '家目录禁止执行文件' },
    availableSpaceKiB: 10 * 1024 * 1024,
    sharedFileSystem: { state: 'degraded', reason: '无法判断是否为共享文件系统' }
  },
  toolchain: {
    git: { state: 'available', version: '2.43.0' },
    nextflow: { state: 'unavailable', reason: '未发现 Nextflow' },
    java: { state: 'available', version: '17.0.12' },
    conda: { state: 'unavailable', reason: '未发现 Conda' },
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
  assert.match(JSON.stringify(controller.getState()), /测试超时/)
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
      checks: [{ id: 'ssh', status: 'error', message: 'SSH 认证失败', suggestion: '检查密钥' }]
    }
  }
  assert.deepEqual(remoteHostCheckPresentation(failed, key), {
    tone: 'error',
    message: 'SSH 认证失败 — 检查密钥'
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
            { id: 'ssh', status: 'ok', message: 'SSH 非交互连接成功' },
            { id: 'nextflow', status: 'error', message: '未找到 Nextflow' }
          ]
        }
      },
      key
    ),
    { tone: 'success', message: 'SSH 连接成功。点击可重新测试。' }
  )
  assert.equal(remoteHostCheckPresentation(failed, 'another-host').tone, 'idle')
  assert.equal(
    remoteHostCheckPresentation({ phase: 'failed', key, message: '测试超时' }, key).message,
    '测试超时'
  )
  const anotherKey = remoteDoctorTargetKey(remoteHostDoctorTarget('ssh-config:other', 'other'))
  const first = withHostDoctorState({}, { phase: 'failed', key, message: '认证失败' })
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
    'aria-label="刷新服务器"',
    'aria-label="添加服务器"',
    'lab-hpc',
    'gpu.example.test'
  ]) {
    assert.match(markup, new RegExp(label))
  }
  assert.doesNotMatch(markup, />添加<\/button>/)
  assert.doesNotMatch(markup, /~\/\.phi\/runtime/)
  assert.doesNotMatch(markup, />测试连接<\/button>/)
  assert.match(markup, /aria-label="配置 gpu"/)
  assert.doesNotMatch(markup, /服务器地址|私钥路径/)
  const gpuKey = remoteDoctorTargetKey(remoteHostDoctorTarget('ssh-config:gpu', 'gpu'))
  const failedMarkup = render(
    createElement(RemoteHostProfilesPanel, {
      ...props,
      hostDoctorStates: { 'ssh-config:gpu': { phase: 'failed', key: gpuKey, message: '测试超时' } }
    })
  )
  assert.match(failedMarkup, /连接失败/)
  const labKey = remoteDoctorTargetKey(remoteHostDoctorTarget('host-1', 'lab-hpc'))
  const runningMarkup = render(
    createElement(RemoteHostProfilesPanel, {
      ...props,
      hostDoctorStates: { 'host-1': { phase: 'running', key: labKey } }
    })
  )
  assert.match(runningMarkup, /检测中/)
  const dialogMarkup = render(
    createElement(RemoteHostDialog, {
      ...props,
      open: true,
      onClose: () => undefined,
      onPasswordBootstrap: () => undefined
    })
  )
  for (const label of ['SSH 别名', '服务器地址', '用户名', '端口', '认证方式']) {
    assert.match(dialogMarkup, new RegExp(label))
  }
  assert.doesNotMatch(dialogMarkup, /私钥路径/)
  assert.doesNotMatch(dialogMarkup, /从 ~\/.ssh\/config 选择/)
  assert.doesNotMatch(markup, /type="password"|口令输入/)
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
  for (const label of ['添加服务器', '配置 gpu', '配置 Lab', '刷新服务器']) {
    assert.match(markup, new RegExp(`aria-label="${label}"`))
  }
  assert.doesNotMatch(markup, /aria-label="测试 Lab"/)
  const detailMarkup = render(
    createElement(RemoteHostProfilesPanel, { ...props, initialSelectedHostAlias: 'lab-hpc' })
  )
  for (const label of ['编辑 Lab', '删除 Lab', '测试 Lab']) {
    assert.match(detailMarkup, new RegExp(`aria-label="${label}"`))
  }
  assert.match(detailMarkup, /返回服务器列表/)
  for (const label of ['环境配置', '默认运行环境', 'Nextflow', 'Jupyter', 'micromamba', 'Docker']) {
    assert.match(detailMarkup, new RegExp(label))
  }
  assert.match(detailMarkup, /留空时由 Phi 管理/)
  assert.doesNotMatch(detailMarkup, /安装\/更新 micromamba|高级下载设置|服务器能力档案/)
  const discoveredDetailMarkup = render(
    createElement(RemoteHostProfilesPanel, { ...props, initialSelectedHostAlias: 'gpu' })
  )
  assert.match(discoveredDetailMarkup, /aria-label="编辑 gpu"/)
  assert.match(discoveredDetailMarkup, /aria-label="测试 gpu"/)
  assert.doesNotMatch(discoveredDetailMarkup, /aria-label="删除 gpu"/)
  const dialog = RemoteHostDialog({
    open: true,
    draft: props.draft,
    busy: false,
    error: null,
    onDraftChange: props.onDraftChange,
    onClose: props.onCloseDialog,
    onSave: props.onSave
  })
  findAction(dialog, '取消')()
  findAction(dialog, '添加服务器')()
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
  assert.match(markup, /连接正常/)
  assert.doesNotMatch(markup, /服务器能力档案|Linux · x86_64|检查时间/)
})

test('project connection test uses its own host, directory and HPC settings', () => {
  const calls: string[] = []
  const connection = {
    id: 'conn-1',
    label: 'Cluster',
    hostProfileId: 'host-1',
    hpc: { scheduler: 'slurm' as const, runtime: 'conda' as const, nextflowBin: '/opt/nf' }
  }
  const row = RemoteProjectConnectionRow({
    projectId: 'project-1',
    connection,
    host: { id: 'host-1', label: 'Lab', hostAlias: 'lab-hpc' },
    remotePath: '/cluster/project',
    isDefault: true,
    busy: false,
    doctorState: { phase: 'idle' },
    onTest: (target) => {
      calls.push(JSON.stringify([target.hostProfileId, target.remotePath, target.options]))
    },
    onEdit: () => {
      calls.push('edit')
    },
    onDelete: () => {
      calls.push('delete')
    }
  })
  findAction(row, '测试连接')()
  findAction(row, '编辑 Cluster')()
  findAction(row, '删除 Cluster')()
  assert.deepEqual(calls, [
    JSON.stringify([
      'host-1',
      '/cluster/project',
      {
        scheduler: 'slurm',
        runtime: 'conda',
        nextflowBin: '/opt/nf',
        refreshCapabilities: true
      }
    ]),
    'edit',
    'delete'
  ])
  const markup = render(row)
  assert.match(markup, /默认/)
  assert.match(markup, /lab-hpc/)
  assert.doesNotMatch(markup, /privateKeyPath|passphrase/)
})

test('a project connection with no host links directly to remote settings', () => {
  const calls: string[] = []
  const row = RemoteProjectConnectionRow({
    projectId: 'project-1',
    connection: { id: 'conn-1', label: 'Missing', hostProfileId: 'missing-host' },
    host: undefined,
    remotePath: '/cluster/project',
    isDefault: false,
    busy: false,
    doctorState: { phase: 'idle' },
    onTest: () => undefined,
    onEdit: () => undefined,
    onDelete: () => undefined,
    onOpenRemoteSettings: () => calls.push('settings')
  })

  findAction(row, '设置 → 远程')()
  assert.deepEqual(calls, ['settings'])
  assert.match(render(row), /需重新配置 SSH 服务器/)
})

test('result panel identifies each failed setting and shows a checked time and retry guidance', () => {
  const key = remoteDoctorTargetKey(hostTarget)
  const markup = render(
    createElement(RemoteDoctorPanel, {
      state: { phase: 'done', key, report },
      targetKey: key
    })
  )
  assert.match(markup, /检查完成，存在提醒/)
  assert.match(markup, /SSH 连接/)
  assert.match(markup, /容器或 Conda 运行时/)
  assert.match(markup, /请检查计算节点/)
  assert.match(markup, /检查时间/)
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
        message: 'SSH 认证失败后处于冷却期；在设置里点测试连接可立即重试。'
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
          checks: [{ id: 'ssh', status: 'error', message: 'SSH 非交互认证失败' }]
        }
      },
      targetKey: key,
      onOpenRemoteSettings: () => undefined
    })
  )

  assert.match(failedMarkup, /设置 → 远程/)
  assert.match(failedMarkup, /测试连接可立即重试/)
  assert.match(reportMarkup, /设置 → 远程/)
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
        reason: 'macOS 远端暂不支持 helper'
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
  assert.match(markup, /服务器能力档案/)
  assert.match(markup, /macOS · arm64/)
  assert.match(markup, /macOS 远端暂不支持 helper/)
  assert.match(markup, /Git 2\.43\.0/)
  assert.match(markup, /Nextflow：未发现 Nextflow/)
  assert.match(markup, /Perl：未发现 Perl/)
  assert.match(markup, /家目录禁止执行文件/)
  assert.match(markup, /可用空间：10 GiB/)
  assert.match(markup, /helper 未安装/)
  assert.doesNotMatch(markup, /private\.example\.test|\/home\/private-user/)
})

test('result panel separates directory, Nextflow and Slurm failures', () => {
  const key = remoteDoctorTargetKey(hostTarget)
  const failed: RemoteDoctorReport = {
    ...report,
    ok: false,
    checks: [
      { id: 'ssh', status: 'ok', message: 'SSH 非交互连接成功' },
      {
        id: 'path_write',
        status: 'error',
        message: '候选目录不可写入',
        suggestion: '选择有写入权限的工作目录。'
      },
      {
        id: 'nextflow',
        status: 'error',
        message: '未找到 Nextflow',
        suggestion: '检查 Nextflow 路径。'
      },
      {
        id: 'slurm_submit',
        status: 'error',
        message: '未找到 Slurm 提交命令',
        suggestion: '检查集群环境。'
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
    'SSH 已连接，部分检查仍需处理',
    '目录写入权限',
    'Nextflow',
    'Slurm 提交',
    '选择有写入权限的工作目录'
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
              message: 'SSH 主机密钥不一致',
              suggestion: '先核对服务器指纹。'
            }
          ]
        }
      },
      targetKey: key
    })
  )
  assert.match(identityMarkup, /无法建立 SSH 连接/)
  assert.match(identityMarkup, /先核对服务器指纹/)
})
