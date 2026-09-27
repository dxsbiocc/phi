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

const hostTarget = remoteHostDoctorTarget('host-1', 'lab-hpc')

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
  assert.equal(controller.getState().phase, 'done')
  assert.equal(
    'key' in controller.getState() ? controller.getState().key : '',
    remoteDoctorTargetKey(newTarget)
  )
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

function tooltipTexts(root: ReactNode): string[] {
  const pending: ReactNode[] = [root]
  const texts: string[] = []
  while (pending.length > 0) {
    const node = pending.pop()
    if (Array.isArray(node)) {
      pending.push(...node)
      continue
    }
    if (!isValidElement(node)) continue
    const props = node.props as { children?: ReactNode; title?: ReactNode }
    if (typeof props.title === 'string') texts.push(props.title)
    if (isValidElement(props.title)) {
      const title = props.title.props as { children?: ReactNode }
      if (typeof title.children === 'string') texts.push(title.children)
    }
    pending.push(props.children)
  }
  return texts
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
    doctorState: { phase: 'idle' as const },
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
  assert.doesNotMatch(markup, /服务器地址|私钥路径/)
  const gpuKey = remoteDoctorTargetKey(remoteHostDoctorTarget('ssh-config:gpu', 'gpu'))
  const failedMarkup = render(
    createElement(RemoteHostProfilesPanel, {
      ...props,
      hostDoctorStates: { 'ssh-config:gpu': { phase: 'failed', key: gpuKey, message: '测试超时' } }
    })
  )
  assert.match(failedMarkup, /aria-label="连接失败，重新测试 gpu"/)
  assert.match(failedMarkup, /MuiIconButton-colorError/)
  const failedCard = RemoteHostProfilesPanel({
    ...props,
    hostDoctorStates: {
      'ssh-config:gpu': { phase: 'failed', key: gpuKey, message: '测试超时' }
    }
  })
  assert.ok(tooltipTexts(failedCard).includes('测试超时'))
  const dialogMarkup = render(
    createElement(RemoteHostDialog, { ...props, open: true, onClose: () => undefined })
  )
  for (const label of ['SSH 别名', '服务器地址', '用户名', '端口', '私钥路径']) {
    assert.match(dialogMarkup, new RegExp(label))
  }
  assert.doesNotMatch(dialogMarkup, /从 ~\/.ssh\/config 选择/)
  assert.doesNotMatch(markup, /type="password"|口令输入/)
})

test('server card routes add, edit, delete and test clicks to their own actions', () => {
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
    doctorState: { phase: 'idle' as const },
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
    }
  }
  const card = RemoteHostProfilesPanel(props)
  findAction(card, '添加服务器')()
  findAction(card, '编辑 gpu')()
  findAction(card, '编辑 Lab')()
  findAction(card, '删除 Lab')()
  assert.throws(() => findAction(card, '删除 gpu'), /Missing/)
  findAction(card, '测试 gpu')()
  findAction(card, '测试 Lab')()
  findAction(card, '刷新服务器')()
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
  assert.deepEqual(calls, [
    'add',
    'edit:ssh-config:gpu',
    'edit:host-1',
    'delete:host-1',
    'test:ssh-config:gpu',
    'test:host-1',
    'reload',
    'close',
    'save'
  ])
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
        nextflowBin: '/opt/nf'
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
