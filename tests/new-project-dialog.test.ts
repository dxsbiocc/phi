import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { ProjectLocationFields } from '../src/renderer/src/features/project/components/ProjectLocationFields'
import { RemoteProjectFields } from '../src/renderer/src/features/project/components/RemoteProjectFields'
import {
  canSubmitNewProject,
  submitNewProjectDraft,
  type NewProjectDraft
} from '../src/renderer/src/features/project/lib/projectCreateUi'

const remoteDraft: NewProjectDraft = {
  locationMode: 'ssh',
  name: 'Lab',
  workingDirectory: '',
  hostProfileId: 'host-1',
  remoteRoot: '/cluster/lab',
  permissionMode: 'ask'
}

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

function findProps(
  root: ReactNode,
  match: (props: Record<string, unknown>) => boolean
): Record<string, unknown> {
  const pending: ReactNode[] = [root]
  while (pending.length > 0) {
    const node = pending.pop()
    if (Array.isArray(node)) {
      pending.push(...node)
      continue
    }
    if (!isValidElement(node)) continue
    const props = node.props as Record<string, unknown>
    if (match(props)) return props
    pending.push(props.children as ReactNode)
  }
  throw new Error('Expected control was not rendered')
}

test('local creation still uses the chosen local folder and permission mode', async () => {
  const calls: string[] = []
  const local = { ...remoteDraft, locationMode: 'local' as const, workingDirectory: '/local/work' }
  assert.equal(canSubmitNewProject(local), true)
  await submitNewProjectDraft(local, {
    createLocal: async (name, path, mode) => {
      calls.push(`${name}:${path}:${mode}`)
    },
    createRemote: async () => {
      throw new Error('remote should not run')
    }
  })
  assert.deepEqual(calls, ['Lab:/local/work:ask'])
})

test('remote creation sends host and remote path without calling the local picker', async () => {
  const calls: string[] = []
  await submitNewProjectDraft(
    { ...remoteDraft, remoteRoot: ' /cluster/lab ' },
    {
      createLocal: async () => {
        throw new Error('local should not run')
      },
      createRemote: async (input) => {
        calls.push(JSON.stringify(input))
      }
    }
  )
  assert.deepEqual(calls, [
    JSON.stringify({
      name: 'Lab',
      hostProfileId: 'host-1',
      remoteRoot: '/cluster/lab',
      permissionMode: 'ask'
    })
  ])
  assert.equal(canSubmitNewProject({ ...remoteDraft, remoteRoot: '../relative' }), false)
})

test('network and permission failures leave the remote draft intact for correction', async () => {
  for (const reason of ['网络不可达', '候选目录不可写入']) {
    const draft = { ...remoteDraft }
    await assert.rejects(
      () =>
        submitNewProjectDraft(draft, {
          createLocal: async () => {
            throw new Error('local should not run')
          },
          createRemote: async () => {
            throw new Error(reason)
          }
        }),
      new RegExp(reason)
    )
    assert.deepEqual(draft, remoteDraft)
  }
})

test('project location fields keep the local picker separate from remote paths', () => {
  const actions: string[] = []
  const props = {
    onModeChange: (mode: 'local' | 'ssh') => actions.push(`mode:${mode}`),
    workingDirectory: '/local/work',
    onPickDirectory: () => actions.push('pick-local'),
    hosts: [{ id: 'host-1', label: 'Lab', hostAlias: 'lab-hpc' }],
    hostsLoading: false,
    hostsError: null,
    hostProfileId: 'host-1',
    remoteRoot: '/cluster/work',
    onHostChange: () => undefined,
    onRemoteRootChange: () => undefined,
    onOpenRemoteSettings: () => undefined
  }
  const local = render(createElement(ProjectLocationFields, { ...props, mode: 'local' }))
  assert.match(local, /本机文件夹/)
  assert.match(local, /远程服务器/)
  assert.match(local, /选择文件夹/)
  assert.doesNotMatch(local, /服务器上的项目目录/)
  const localFields = ProjectLocationFields({ ...props, mode: 'local' })
  const localPicker = findProps(localFields, (item) => item.children === '选择文件夹')
  ;(localPicker.onClick as () => void)()
  const modeGroup = findProps(
    localFields,
    (item) => item.value === 'local' && typeof item.onChange === 'function'
  )
  ;(modeGroup.onChange as (_: unknown, mode: 'local' | 'ssh') => void)(null, 'ssh')
  const remote = render(createElement(ProjectLocationFields, { ...props, mode: 'ssh' }))
  assert.match(remote, /服务器上的项目目录/)
  assert.doesNotMatch(remote, /选择文件夹/)
  assert.deepEqual(actions, ['pick-local', 'mode:ssh'])
})

test('remote fields select a discovered OpenSSH host directly and accept a server path', () => {
  const actions: string[] = []
  const fields = RemoteProjectFields({
    hosts: [
      { id: 'ssh-config:lab-hpc', label: 'lab-hpc', hostAlias: 'lab-hpc', source: 'ssh-config' }
    ],
    hostsLoading: false,
    hostsError: null,
    hostProfileId: 'ssh-config:lab-hpc',
    remoteRoot: '/cluster/lab',
    onHostChange: (id) => actions.push(`host:${id}`),
    onRemoteRootChange: (path) => actions.push(`path:${path}`),
    onOpenRemoteSettings: () => actions.push('settings')
  })
  const hostField = findProps(fields, (props) => props.label === 'SSH 服务器')
  const directoryTree = findProps(
    fields,
    (props) => props.hostProfileId === 'ssh-config:lab-hpc' && props.selectedPath === '/cluster/lab'
  )
  const settings = findProps(fields, (props) => props.children === '管理服务器')
  ;(hostField.onChange as (event: { target: { value: string } }) => void)({
    target: { value: 'ssh-config:other' }
  })
  ;(directoryTree.onSelectPath as (path: string) => void)('/new/path')
  ;(settings.onClick as () => void)()
  assert.deepEqual(actions, ['host:ssh-config:other', 'path:/new/path', 'settings'])
  const markup = render(fields)
  assert.match(markup, /lab-hpc/)
  assert.doesNotMatch(markup, /lab-hpc · lab-hpc/)
  assert.match(markup, /可直接选择/)
  assert.match(markup, /\/cluster\/lab/)
  assert.match(markup, /服务器上的项目目录/)
  assert.match(markup, /可直接输入绝对路径，或在下方目录树中选择/)
  assert.match(markup, /筛选文件夹/)
  assert.doesNotMatch(markup, /填写服务器上的绝对路径/)
  assert.doesNotMatch(markup, /创建后可在服务器目录中对话/)
  assert.doesNotMatch(markup, /选择文件夹/)
})
