import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { RemoteConnectionNotice } from '../src/renderer/src/features/project/components/RemoteConnectionNotice'
import { shouldRetryRemoteReads } from '../src/renderer/src/features/project/lib/remoteConnectionUi'
import { applyRemoteProjectConnectionChange } from '../src/renderer/src/useProjects'
import type { Project } from '../src/renderer/src/types'

function markup(
  phase:
    | 'offline'
    | 'identity_failed'
    | 'authentication_failed'
    | 'configuration_failed'
    | 'connecting'
    | 'reachable',
  message = '连接状态消息',
  suggestion = '处理建议',
  compact = false
): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(RemoteConnectionNotice, {
        hostAlias: 'cluster',
        connection: { phase, message, suggestion },
        onRetry: () => undefined,
        onOpenRemoteSettings: () => undefined,
        compact
      })
    )
  )
}

test('remote connection notice gives recovery guidance without hiding saved work', () => {
  assert.match(markup('offline'), /cluster · 连接状态消息/)
  assert.match(markup('offline'), /对话历史和草稿仍可查看/)
  assert.match(markup('offline'), /先在服务器核对/)
  assert.match(markup('identity_failed'), /处理建议/)
  assert.match(markup('identity_failed'), /重新连接/)
  assert.match(markup('identity_failed'), /设置 → 远程/)
  assert.match(markup('authentication_failed'), /设置 → 远程/)
  assert.match(markup('configuration_failed'), /设置 → 远程/)
  assert.match(
    markup(
      'authentication_failed',
      'SSH 认证失败后处于冷却期，剩余约 8 分钟',
      '在设置里点测试连接可立即重试；不要反复连接。',
      true
    ),
    /在设置里点测试连接可立即重试/
  )
  assert.match(markup('connecting'), /disabled/)
  assert.equal(markup('reachable'), '')
})

test('remote connection events update only their SSH project, then retry only reads on recovery', () => {
  const remote = {
    id: 'remote',
    location: { kind: 'ssh', hostProfileId: 'host', remoteRoot: '/work', canonicalRoot: '/work' },
    remoteReachability: 'offline'
  } as Project
  const local = {
    id: 'local',
    location: { kind: 'local', path: '/work', realPath: '/work' }
  } as Project
  const next = applyRemoteProjectConnectionChange([remote, local], {
    projectId: 'remote',
    state: { phase: 'reachable' }
  })
  assert.equal(next[0].remoteConnection?.phase, 'reachable')
  assert.equal(next[0].remoteReachability, 'reachable')
  assert.equal(next[1], local)
  assert.equal(shouldRetryRemoteReads('offline', 'reachable'), true)
  assert.equal(shouldRetryRemoteReads('identity_failed', 'reachable'), true)
  assert.equal(shouldRetryRemoteReads(null, 'reachable'), false)
  assert.equal(shouldRetryRemoteReads('offline', 'connecting'), false)
})
