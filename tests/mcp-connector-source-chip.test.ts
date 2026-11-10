import assert from 'node:assert/strict'
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'

import type { FeaturedMcpConnector } from '../src/shared/mcpConnectorCatalog'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { ConnectorCatalogCardFrame } from '../src/renderer/src/features/mcp/components/ConnectorCatalogCardFrame'
import { McpConnectorSourceBadges } from '../src/renderer/src/features/mcp/components/McpConnectorSourceBadges'
import { McpFeaturedConnectorCard } from '../src/renderer/src/features/mcp/components/McpFeaturedConnectorCard'
import { McpFeaturedConnectorDetails } from '../src/renderer/src/features/mcp/components/McpFeaturedConnectorDetails'
import { componentTree } from './helpers/renderComponentTree'

const importedConnector: FeaturedMcpConnector = {
  id: 'alpha',
  version: '1.0.0',
  name: 'A very long imported connector name that must not push the source chip out',
  description: 'Imported connector',
  publisher: 'Acme',
  category: '科研数据',
  signIn: '本地服务',
  transport: 'stdio',
  command: './server.sh',
  added: false,
  source: {
    kind: 'github',
    label: 'GitHub · acme/connectors@abcdef0',
    trust: 'imported',
    sourceId: 'a'.repeat(16),
    sha: 'abcdef0'.padEnd(40, '0')
  }
}

const noop = (): void => undefined

function renderCard(connector: FeaturedMcpConnector): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpFeaturedConnectorCard, {
        connector,
        installed: false,
        busy: false,
        authStatus: 'authenticated',
        onOpen: noop,
        onAdd: noop,
        onAuthorize: noop
      })
    )
  )
}

function renderDetails(connector: FeaturedMcpConnector): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpFeaturedConnectorDetails, {
        connector,
        busy: false,
        authStatus: 'authenticated',
        toolNames: [],
        toolsLoading: false,
        toolsError: null,
        onAdd: noop,
        onRemove: noop,
        onAuthorize: noop,
        onApiKey: noop,
        onRetry: noop
      })
    )
  )
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

function titleRow(node: ReactNode): ReactElement | undefined {
  return findElement(
    node,
    (element) =>
      (element.props as Record<string, unknown>)['data-phi-connector-title-row'] === 'true'
  )
}

test('catalog cards and the connector detail header omit the unsigned badge', () => {
  for (const language of ['en', 'zh-CN'] as const) {
    setUiLanguage(language)
    for (const markup of [renderCard(importedConnector), renderDetails(importedConnector)]) {
      assert.doesNotMatch(markup, /Unsigned|未签名/)
      assert.match(markup, /GitHub · acme\/connectors@abcdef0/)
    }
  }
})

test('the connector detail source chip sits in the title row', () => {
  setUiLanguage('en')
  const tree = componentTree(() =>
    McpFeaturedConnectorDetails({
      connector: importedConnector,
      busy: false,
      authStatus: 'authenticated',
      toolNames: [],
      toolsLoading: false,
      toolsError: null,
      onAdd: noop,
      onRemove: noop,
      onAuthorize: noop,
      onApiKey: noop,
      onRetry: noop
    })
  )
  const row = titleRow(tree)
  assert.ok(row, 'the detail header renders a title row')
  assert.ok(
    findElement(row, (element) => element.type === McpConnectorSourceBadges),
    'the source chip is inside the title row'
  )
  assert.ok(
    findElement(
      row,
      (element) => (element.props as { children?: ReactNode }).children === importedConnector.name
    ),
    'the connector name is inside the title row'
  )
})

test('the catalog card source chip sits in the title row and leaves the auth line alone', () => {
  setUiLanguage('en')
  const tree = componentTree(() =>
    McpFeaturedConnectorCard({
      connector: importedConnector,
      installed: false,
      busy: false,
      authStatus: 'authenticated',
      onOpen: noop,
      onAdd: noop,
      onAuthorize: noop
    })
  )
  const frame = findElement(tree, (element) => element.type === ConnectorCatalogCardFrame)
  assert.ok(frame)
  const accessory = (frame.props as { titleAccessory?: ReactNode }).titleAccessory
  assert.ok(isValidElement(accessory), 'the card passes the source chip to its title line')
  assert.equal(accessory.type, McpConnectorSourceBadges)

  const frameTree = componentTree(() =>
    ConnectorCatalogCardFrame({
      icon: null,
      title: importedConnector.name,
      description: importedConnector.description,
      titleAccessory: createElement(McpConnectorSourceBadges, { connector: importedConnector })
    })
  )
  const row = titleRow(frameTree)
  assert.ok(row, 'the card frame renders a title row')
  assert.ok(findElement(row, (element) => element.type === McpConnectorSourceBadges))
  const title = findElement(
    row,
    (element) => (element.props as { children?: ReactNode }).children === importedConnector.name
  )
  assert.ok(title)
  assert.equal((title.props as { noWrap?: boolean }).noWrap, true)
  assert.equal((title.props as { sx?: { minWidth?: number } }).sx?.minWidth, 0)
})
