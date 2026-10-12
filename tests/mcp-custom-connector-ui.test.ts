import assert from 'node:assert/strict'
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'

import type { McpConnectorSetupProgress } from '../src/shared/mcpConnectorCatalog'
import type { McpServerSummary } from '../src/renderer/src/types'
import {
  McpCustomConnectorCard,
  McpCustomConnectorEmptyState
} from '../src/renderer/src/features/mcp/components/McpCustomConnectorCard'
import { McpCustomConnectorDetail } from '../src/renderer/src/features/mcp/components/McpCustomConnectorDetail'
import { McpCustomConnectorGroup } from '../src/renderer/src/features/mcp/components/McpCustomConnectorGroup'
import type {
  CustomConnectorJobEntry,
  CustomConnectorServerEntry
} from '../src/renderer/src/features/mcp/lib/customConnectorGroup'

const noop = (): void => undefined

function render(node: ReactNode): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, node))
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean
): ReactElement | undefined {
  if (!isValidElement(node)) return undefined
  if (predicate(node)) return node
  for (const child of Children.toArray((node.props as { children?: ReactNode }).children)) {
    const found = findElement(child, predicate)
    if (found) return found
  }
  return undefined
}

function localServer(overrides: Partial<McpServerSummary> = {}): McpServerSummary {
  return {
    id: 'literature',
    name: 'Literature MCP',
    command: 'uvx',
    args: ['literature-mcp'],
    envKeys: ['NCBI_API_KEY'],
    userStdio: true,
    enabled: true,
    status: 'configured',
    ...overrides
  }
}

function serverEntry(
  overrides: Partial<CustomConnectorServerEntry> = {}
): CustomConnectorServerEntry {
  const value = localServer()
  return {
    kind: 'server',
    name: value.name,
    subtitle: 'uvx literature-mcp',
    origin: '自建·本地',
    status: '已启用',
    enabled: true,
    server: value,
    ...overrides
  }
}

function jobEntry(): CustomConnectorJobEntry {
  const setup: McpConnectorSetupProgress = {
    id: 'mail',
    kind: 'local-stdio',
    title: 'Mail MCP',
    summary: 'bun run mail.ts',
    phase: 'failed',
    failureKind: 'needs-setup',
    revision: 2,
    updatedAt: '2026-10-12T08:00:00.000Z'
  }
  return {
    kind: 'job',
    name: 'Mail MCP',
    subtitle: 'bun run mail.ts',
    origin: '自建·本地',
    status: '需要先配置',
    job: setup
  }
}

test('custom connector cards show ownership, live status, and the added affordance', () => {
  const markup = render(
    createElement(McpCustomConnectorCard, {
      entry: serverEntry(),
      busy: false,
      onOpen: noop,
      onViewJob: noop
    })
  )

  assert.match(markup, /Literature MCP/)
  assert.match(markup, /uvx literature-mcp/)
  assert.match(markup, /自建·本地/)
  assert.match(markup, /已启用/)
  assert.match(markup, /aria-label="已添加 Literature MCP"/)
  assert.match(markup, /data-phi-connector-state="added"/)
})

test('custom connector detail exposes safe configuration, controls, and removal confirmation', () => {
  const enabledChanges: boolean[] = []
  let removeRequested = 0
  const props = {
    entry: serverEntry(),
    busy: false,
    error: null,
    confirmingRemove: false,
    onEnabledChange: (enabled: boolean) => enabledChanges.push(enabled),
    onRequestRemove: () => {
      removeRequested += 1
    },
    onCancelRemove: noop,
    onConfirmRemove: noop
  }
  const detail = McpCustomConnectorDetail(props)
  const markup = render(detail)

  assert.match(markup, /Literature MCP/)
  assert.match(markup, /自建·本地/)
  assert.match(markup, /uvx literature-mcp/)
  assert.match(markup, /NCBI_API_KEY/)
  assert.match(markup, /已启用/)
  assert.doesNotMatch(markup, /secret-value/i)

  const disable = findElement(
    detail,
    (element) => (element.props as { children?: ReactNode }).children === '停用'
  )
  assert.ok(disable)
  ;(disable.props as { onClick: () => void }).onClick()
  assert.deepEqual(enabledChanges, [false])

  const remove = findElement(
    detail,
    (element) => (element.props as { children?: ReactNode }).children === '移除'
  )
  assert.ok(remove)
  ;(remove.props as { onClick: () => void }).onClick()
  assert.equal(removeRequested, 1)

  assert.match(
    render(McpCustomConnectorDetail({ ...props, confirmingRemove: true })),
    /确认移除这个本地 stdio 连接器？[\s\S]*取消[\s\S]*确认移除/
  )
})

test('job cards wire 查看进度 to the matching setup job', () => {
  const requested: string[] = []
  const card = McpCustomConnectorCard({
    entry: jobEntry(),
    busy: false,
    onOpen: noop,
    onViewJob: (jobId) => requested.push(jobId)
  })
  const action = findElement(
    card,
    (element) => (element.props as { children?: ReactNode }).children === '查看进度'
  )

  assert.ok(action)
  let propagationStopped = false
  ;(action.props as { onClick: (event: { stopPropagation: () => void }) => void }).onClick({
    stopPropagation: () => {
      propagationStopped = true
    }
  })
  assert.equal(propagationStopped, true)
  assert.deepEqual(requested, ['mail'])
  assert.match(render(card), /需要先配置/)
  assert.doesNotMatch(render(card), /data-phi-connector-state="added"/)
})

test('the custom group empty state explains how to add a connector', () => {
  assert.match(
    render(createElement(McpCustomConnectorEmptyState)),
    /还没有自建连接器。点击右上角的＋添加本地或远程连接器。/
  )
})

test('custom group search filters by subtitle without applying catalog filters', () => {
  const markup = render(
    createElement(McpCustomConnectorGroup, {
      entries: [serverEntry(), jobEntry()],
      query: 'mail.ts',
      busy: false,
      onQueryChange: noop,
      onOpen: noop,
      onViewJob: noop
    })
  )
  assert.match(markup, /Mail MCP/)
  assert.doesNotMatch(markup, /Literature MCP/)

  const noMatch = render(
    createElement(McpCustomConnectorGroup, {
      entries: [serverEntry()],
      query: 'missing',
      busy: false,
      onQueryChange: noop,
      onOpen: noop,
      onViewJob: noop
    })
  )
  assert.match(noMatch, /没有符合条件的连接器/)
  assert.doesNotMatch(noMatch, /还没有自建连接器/)
})

test('remote custom detail shows its URL, disabled state, and remote removal confirmation', () => {
  const remote = serverEntry({
    name: 'Remote MCP',
    subtitle: 'https://custom.example/mcp',
    origin: '自建·远程',
    status: '已停用',
    enabled: false,
    server: localServer({
      id: 'remote',
      name: 'Remote MCP',
      command: undefined,
      args: undefined,
      envKeys: undefined,
      userStdio: undefined,
      url: 'https://custom.example/mcp',
      enabled: false
    })
  })
  const markup = render(
    createElement(McpCustomConnectorDetail, {
      entry: remote,
      busy: false,
      error: null,
      confirmingRemove: true,
      onEnabledChange: noop,
      onRequestRemove: noop,
      onCancelRemove: noop,
      onConfirmRemove: noop
    })
  )

  assert.match(markup, /自建·远程/)
  assert.match(markup, /https:\/\/custom\.example\/mcp/)
  assert.match(markup, />启用</)
  assert.match(markup, /确认移除这个远程 HTTPS 连接器？/)
})

test('server cards are keyboard accessible and disabled servers do not show the added check', () => {
  let opened = 0
  const card = McpCustomConnectorCard({
    entry: serverEntry({ status: '已停用', enabled: false }),
    busy: false,
    onOpen: () => {
      opened += 1
    },
    onViewJob: noop
  })
  const target = {}
  let prevented = false
  const onKeyDown = (
    card.props as {
      onKeyDown: (event: {
        target: object
        currentTarget: object
        key: string
        preventDefault: () => void
      }) => void
    }
  ).onKeyDown
  onKeyDown({
    target,
    currentTarget: target,
    key: 'Enter',
    preventDefault: () => {
      prevented = true
    }
  })
  onKeyDown({ target, currentTarget: target, key: 'Escape', preventDefault: noop })

  assert.equal(opened, 1)
  assert.equal(prevented, true)
  const markup = render(card)
  assert.match(markup, /已停用/)
  assert.doesNotMatch(markup, /data-phi-connector-state="added"/)
})

test('custom group forwards search changes and server-card opens, and renders its own empty state', () => {
  const queries: string[] = []
  const opened: string[] = []
  const group = McpCustomConnectorGroup({
    entries: [serverEntry()],
    query: '',
    busy: false,
    onQueryChange: (value) => queries.push(value),
    onOpen: (entry) => opened.push(entry.server.id),
    onViewJob: noop
  })
  const search = findElement(
    group,
    (element) => (element.props as { placeholder?: string }).placeholder === '搜索连接器'
  )
  const card = findElement(group, (element) => element.type === McpCustomConnectorCard)
  assert.ok(search)
  assert.ok(card)
  ;(search.props as { onChange: (event: { target: { value: string } }) => void }).onChange({
    target: { value: 'mail' }
  })
  ;(card.props as { onOpen: () => void }).onOpen()
  assert.deepEqual(queries, ['mail'])
  assert.deepEqual(opened, ['literature'])

  assert.match(
    render(
      createElement(McpCustomConnectorGroup, {
        entries: [],
        query: '',
        busy: false,
        onQueryChange: noop,
        onOpen: noop,
        onViewJob: noop
      })
    ),
    /还没有自建连接器/
  )
})

test('custom detail renders fallback command and inline errors without environment chips', () => {
  const entry = serverEntry({
    subtitle: '',
    server: localServer({ command: undefined, args: undefined, envKeys: undefined })
  })
  const markup = render(
    createElement(McpCustomConnectorDetail, {
      entry,
      busy: false,
      error: '保存失败',
      confirmingRemove: false,
      onEnabledChange: noop,
      onRequestRemove: noop,
      onCancelRemove: noop,
      onConfirmRemove: noop
    })
  )
  assert.match(markup, /未配置命令/)
  assert.match(markup, /保存失败/)
  assert.doesNotMatch(markup, /环境变量名称/)
})
