import { componentTree } from './helpers/renderComponentTree'
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
    origin: 'Custom · Local',
    status: 'Enabled',
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
    origin: 'Custom · Local',
    status: 'Setup required',
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
  assert.match(markup, /Custom · Local/)
  assert.match(markup, /Enabled/)
  assert.match(markup, /aria-label="Added Literature MCP"/)
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
  const detail = componentTree(() => McpCustomConnectorDetail(props))
  const markup = render(detail)

  assert.match(markup, /Literature MCP/)
  assert.match(markup, /Custom · Local/)
  assert.match(markup, /uvx literature-mcp/)
  assert.match(markup, /NCBI_API_KEY/)
  assert.match(markup, /Enabled/)
  assert.doesNotMatch(markup, /secret-value/i)

  const disable = findElement(
    detail,
    (element) => (element.props as { children?: ReactNode }).children === 'Disable'
  )
  assert.ok(disable)
  ;(disable.props as { onClick: () => void }).onClick()
  assert.deepEqual(enabledChanges, [false])

  const remove = findElement(
    detail,
    (element) => (element.props as { children?: ReactNode }).children === 'Remove'
  )
  assert.ok(remove)
  ;(remove.props as { onClick: () => void }).onClick()
  assert.equal(removeRequested, 1)

  assert.match(
    render(componentTree(() => McpCustomConnectorDetail({ ...props, confirmingRemove: true }))),
    /Remove this local stdio Connector?[\s\S]*Cancel[\s\S]*Confirm removal/
  )
})

test('job cards wire View progress to the matching setup job', () => {
  const requested: string[] = []
  const card = componentTree(() =>
    McpCustomConnectorCard({
      entry: jobEntry(),
      busy: false,
      onOpen: noop,
      onViewJob: (jobId) => requested.push(jobId)
    })
  )
  const action = findElement(
    card,
    (element) => (element.props as { children?: ReactNode }).children === 'View progress'
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
  assert.match(render(card), /Setup required/)
  assert.doesNotMatch(render(card), /data-phi-connector-state="added"/)
})

test('the custom group empty state explains how to add a connector', () => {
  assert.match(
    render(createElement(McpCustomConnectorEmptyState)),
    /No custom Connectors yet. Use \+ in the upper right to add a local or remote Connector./
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
  assert.match(noMatch, /No matching Connectors/)
  assert.doesNotMatch(noMatch, /No custom Connectors/)
})

test('remote custom detail shows its URL, disabled state, and remote removal confirmation', () => {
  const remote = serverEntry({
    name: 'Remote MCP',
    subtitle: 'https://custom.example/mcp',
    origin: 'Custom · Remote',
    status: 'Disabled',
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

  assert.match(markup, /Custom · Remote/)
  assert.match(markup, /https:\/\/custom\.example\/mcp/)
  assert.match(markup, />Enable</)
  assert.match(markup, /Remove this remote HTTPS Connector?/)
})

test('server cards are keyboard accessible and disabled servers do not show the added check', () => {
  let opened = 0
  const card = componentTree(() =>
    McpCustomConnectorCard({
      entry: serverEntry({ status: 'Disabled', enabled: false }),
      busy: false,
      onOpen: () => {
        opened += 1
      },
      onViewJob: noop
    })
  )
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
  assert.match(markup, /Disabled/)
  assert.doesNotMatch(markup, /data-phi-connector-state="added"/)
})

test('custom group forwards search changes and server-card opens, and renders its own empty state', () => {
  const queries: string[] = []
  const opened: string[] = []
  const group = componentTree(() =>
    McpCustomConnectorGroup({
      entries: [serverEntry()],
      query: '',
      busy: false,
      onQueryChange: (value) => queries.push(value),
      onOpen: (entry) => opened.push(entry.server.id),
      onViewJob: noop
    })
  )
  const search = findElement(
    group,
    (element) => (element.props as { placeholder?: string }).placeholder === 'Search Connectors'
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
    /No custom Connectors/
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
  assert.match(markup, /No command configured/)
  assert.match(markup, /保存失败/)
  assert.doesNotMatch(markup, /Environment variable names/)
})
