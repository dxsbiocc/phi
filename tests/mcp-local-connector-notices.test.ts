import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { McpConnectorSetupProgress } from '../src/shared/mcpConnectorCatalog'
import {
  localConnectorNotice,
  localConnectorNoticeKey
} from '../src/renderer/src/features/mcp/lib/localConnectorNotices'
import { createLocalConnectorNoticeListener } from '../src/renderer/src/features/mcp/lib/localConnectorNoticeListener'
import { useLocalConnectorNotices } from '../src/renderer/src/features/mcp/hooks/useLocalConnectorNotices'

function progress(overrides: Partial<McpConnectorSetupProgress> = {}): McpConnectorSetupProgress {
  return {
    id: 'local:literature',
    kind: 'local-stdio',
    title: 'Literature',
    phase: 'starting',
    revision: 1,
    updatedAt: '2026-10-11T10:00:00.000Z',
    ...overrides
  }
}

test('local connector notices map start, ready, cancellation, and failure feedback', () => {
  let opened = 0
  const openJobs = (): void => {
    opened += 1
  }

  const starting = localConnectorNotice(progress(), new Set(), openJobs)
  assert.equal(
    starting?.message,
    '已开始添加 Literature：正在后台启动并验证（首次运行可能需要几分钟）。'
  )
  assert.equal(starting?.severity, 'info')
  assert.equal(starting?.action?.label, '查看后台任务')
  starting?.action?.onClick()
  assert.equal(opened, 1)

  assert.deepEqual(
    localConnectorNotice(
      progress({ phase: 'ready', revision: 2, toolNames: ['search', 'fetch'] }),
      new Set(),
      openJobs
    ),
    {
      message: '连接器 Literature 已添加，发现 2 个工具',
      severity: 'success'
    }
  )
  assert.deepEqual(
    localConnectorNotice(
      progress({ phase: 'ready', revision: 3, toolNames: undefined }),
      new Set(),
      openJobs
    ),
    { message: '连接器 Literature 已添加', severity: 'success' }
  )
  assert.deepEqual(
    localConnectorNotice(
      progress({ phase: 'ready', revision: 31, toolNames: [] }),
      new Set(),
      openJobs
    ),
    { message: '连接器 Literature 已添加，发现 0 个工具', severity: 'success' }
  )
  assert.deepEqual(
    localConnectorNotice(
      progress({ phase: 'failed', revision: 4, error: '已取消' }),
      new Set(),
      openJobs
    ),
    { message: '已取消添加 Literature', severity: 'info' }
  )

  const failed = localConnectorNotice(
    progress({ phase: 'failed', revision: 5, error: 'spawn ENOENT' }),
    new Set(),
    openJobs
  )
  assert.equal(failed?.message, '添加 Literature 失败：spawn ENOENT')
  assert.equal(failed?.severity, 'error')
  assert.equal(failed?.action?.label, '查看后台任务')
  failed?.action?.onClick()
  assert.equal(opened, 2)

  const failedWithDetail = localConnectorNotice(
    progress({
      phase: 'failed',
      revision: 6,
      error: 'MCP subprocess closed stdout before responding',
      detail: 'Config not found'
    }),
    new Set(),
    openJobs
  )
  assert.equal(
    failedWithDetail?.message,
    '添加 Literature 失败：MCP subprocess closed stdout before responding（详情见后台任务）'
  )
  assert.equal(failedWithDetail?.action?.label, '查看后台任务')

  const openedIds: string[] = []
  const needsSetup = localConnectorNotice(
    progress({
      phase: 'failed',
      revision: 7,
      failureKind: 'needs-setup',
      failureReason: 'Configuration file not found'
    }),
    new Set(),
    (id) => openedIds.push(id)
  )
  assert.deepEqual(
    {
      message: needsSetup?.message,
      severity: needsSetup?.severity,
      label: needsSetup?.action?.label
    },
    {
      message: 'Literature 需要先完成配置，点击查看怎么做',
      severity: 'info',
      label: '去处理'
    }
  )
  needsSetup?.action?.onClick()
  assert.deepEqual(openedIds, ['local:literature'])
})

test('local connector notices deduplicate by id and revision', () => {
  const event = progress({ revision: 7 })
  assert.equal(
    localConnectorNotice(event, new Set([localConnectorNoticeKey(event)]), () => undefined),
    null
  )
  assert.notEqual(
    localConnectorNotice({ ...event, revision: 8 }, new Set(), () => undefined),
    null
  )
})

test('local connector notices ignore unrelated and package-install snapshots', () => {
  assert.equal(
    localConnectorNotice(progress({ kind: undefined }), new Set(), () => undefined),
    null
  )
  assert.equal(
    localConnectorNotice(progress({ phase: 'installing' }), new Set(), () => undefined),
    null
  )
})

test('local connector listener refreshes ready state and never re-announces a revision', async () => {
  const notifications: string[] = []
  let refreshes = 0
  let opened = 0
  const refs = {
    current: {
      notify: (message: string): void => {
        notifications.push(message)
      },
      openJobs: (): void => {
        opened += 1
      },
      onReady: (): void => {
        refreshes += 1
      },
      announcedKeys: new Set<string>() as ReadonlySet<string>
    }
  }
  assert.equal(typeof useLocalConnectorNotices, 'function')
  const listener = createLocalConnectorNoticeListener(refs)
  const starting = progress()
  listener(starting)
  listener(starting)
  listener(progress({ phase: 'ready', revision: 2, toolNames: [] }))
  await Promise.resolve()

  assert.equal(notifications.length, 2)
  assert.equal(refreshes, 1)
  const action = localConnectorNotice(starting, new Set(), refs.current.openJobs)?.action
  action?.onClick()
  assert.equal(opened, 1)
})

test('the app closes connector dialogs before opening jobs from a notice action', () => {
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  const view = readFileSync('src/renderer/src/features/mcp/McpView.tsx', 'utf8')
  assert.match(app, /useLocalConnectorNotices\(showSnackbar, onOpenLocalConnectorJobs/)
  assert.match(
    app,
    /onOpenLocalConnectorJobs[\s\S]*?mcpConnectorDialogCloserRef\.current\?\.\(\)[\s\S]*?setRequestedConnectorJobId[\s\S]*?onOpenBackgroundJobs\(\)/
  )
  assert.match(app, /requestedConnectorJobId=\{requestedConnectorJobId\}/)
  assert.doesNotMatch(app, /window\.api\.onMcpConnectorSetupChanged/)
  assert.match(view, /onRegisterConnectorDialogCloser\?\.\(closeCatalog\)/)
  assert.match(view, /onClose=\{closeCatalog\}/)
})
