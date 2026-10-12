import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'

import type { FeaturedMcpConnector } from '../src/shared/mcpConnectorCatalog'
import type { GithubLocalConnectorDraft, GithubProjectHint } from '../src/shared/githubSourceTypes'
import { McpFeaturedConnectorCard } from '../src/renderer/src/features/mcp/components/McpFeaturedConnectorCard'
import { McpGithubImportActions } from '../src/renderer/src/features/mcp/components/McpGithubImportDialog'
import { McpImportedInstallDialog } from '../src/renderer/src/features/mcp/components/McpImportedInstallDialog'
import { McpProjectHintPanel } from '../src/renderer/src/features/mcp/components/McpProjectHintPanel'
import { githubImportUrlError } from '../src/renderer/src/features/mcp/lib/githubImportDraft'

const importedStdio: FeaturedMcpConnector = {
  id: 'alpha',
  version: '1.0.0',
  name: 'Alpha',
  description: 'Alpha connector',
  publisher: 'Acme',
  category: '科研数据',
  signIn: '本地服务',
  transport: 'stdio',
  environment: './environment.yml',
  command: './server.sh',
  args: ['--stdio', 'value with spaces'],
  registryDir: '/tmp/registry',
  added: false,
  source: {
    kind: 'github',
    label: 'GitHub · acme/connectors@abcdef0',
    trust: 'imported',
    sourceId: 'a'.repeat(16),
    sha: 'abcdef0'.padEnd(40, '0')
  }
}

test('renderer pre-validation mirrors the strict GitHub URL policy', () => {
  assert.equal(githubImportUrlError('https://github.com/acme/connectors'), null)
  assert.equal(githubImportUrlError('https://github.com/acme/connectors/tree/feature/import'), null)
  for (const url of [
    'http://github.com/acme/connectors',
    'https://github.com.evil.com/acme/connectors',
    'https://user@github.com/acme/connectors',
    'https://github.com:443/acme/connectors',
    'https://github.com/acme/connectors/issues',
    'https://github.com/acme/%2e%2e'
  ]) {
    assert.match(githubImportUrlError(url) ?? '', /GitHub|仓库|地址|分支/)
  }
})

test('GitHub catalog cards show the pinned source and unsigned trust', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpFeaturedConnectorCard, {
        connector: importedStdio,
        installed: false,
        authStatus: 'authenticated',
        busy: false,
        onOpen: () => undefined,
        onAdd: () => undefined,
        onAuthorize: () => undefined
      })
    )
  )
  assert.match(markup, /GitHub · acme\/connectors@abcdef0/)
  assert.match(markup, /未签名/)
})

test('imported install confirmation exposes exact local launch data and HTTP URL', () => {
  const stdio = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpImportedInstallDialog, {
        connector: importedStdio,
        open: true,
        onCancel: () => undefined,
        onConfirm: () => undefined
      })
    )
  )
  assert.match(stdio, /将在这台机器上运行/)
  assert.match(stdio, /\.\/server\.sh/)
  assert.match(stdio, /--stdio/)
  assert.match(stdio, /value with spaces/)
  assert.match(stdio, /\.\/environment\.yml/)

  const http = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpImportedInstallDialog, {
        connector: {
          ...importedStdio,
          transport: 'http',
          signIn: '无需登录',
          url: 'https://connector.example/mcp',
          command: undefined,
          args: undefined,
          environment: undefined
        },
        open: true,
        onCancel: () => undefined,
        onConfirm: () => undefined
      })
    )
  )
  assert.match(http, /https:\/\/connector\.example\/mcp/)
})

test('catalog wiring exposes import, preview warnings, update diff, and safe removal copy', () => {
  const catalog = readFileSync(
    'src/renderer/src/features/mcp/components/McpConnectorCatalogDialog.tsx',
    'utf8'
  )
  const importer = readFileSync(
    'src/renderer/src/features/mcp/components/McpGithubImportDialog.tsx',
    'utf8'
  )
  const sources = readFileSync(
    'src/renderer/src/features/mcp/components/McpSourcesPanel.tsx',
    'utf8'
  )
  const addMenu = readFileSync(
    'src/renderer/src/features/mcp/components/McpCatalogAddMenu.tsx',
    'utf8'
  )
  assert.match(addMenu, /从 GitHub 导入…/)
  assert.match(addMenu, /添加自定义连接器…/)
  assert.match(catalog, /McpImportedInstallDialog/)
  assert.match(importer, /导入软件源/)
  assert.match(importer, /仓库地址/)
  assert.match(importer, /未签名·用户导入。安装连接器时才会运行其中的命令。/)
  assert.match(importer, /skipped/)
  assert.match(importer, /warnings/)
  assert.match(importer, /McpProjectHintPanel/)
  assert.match(importer, /preview\.packages\.length === 0/)
  assert.match(importer, /onUseLocalDraft/)
  assert.match(catalog, /initialDraft/)
  assert.match(catalog, /onUseLocalDraft/)
  assert.match(sources, /更新/)
  assert.match(sources, /diff/)
  assert.match(sources, /已安装的连接器会保留/)
})

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

const projectHint: GithubProjectHint = {
  kind: 'node',
  summary: 'Node.js 项目 qq-email-mcp 0.1.1',
  entry: 'dist/index.js',
  entryCommitted: false,
  needsBuild: true,
  nodeEngine: '>=20.19',
  npm: {
    name: 'qq-email-mcp',
    version: '0.1.1',
    repositoryMatches: true
  },
  readmeUrl: 'https://github.com/xieningqing/qq-email-mcp/blob/abc/README.md',
  notices: ['入口 dist/index.js 未随源码提交，需要先构建；Phi 不会自动构建源码']
}

const localDraft: GithubLocalConnectorDraft = {
  suggestedName: 'qq-email-mcp',
  command: 'x',
  args: ['--bun', 'qq-email-mcp@0.1.1'],
  runtimeHint: 'bun'
}

test('project hint panel explains the repo and keeps actions out of the info panel', () => {
  const panel = McpProjectHintPanel({
    hint: projectHint
  })
  const markup = renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, panel))
  assert.match(markup, /Node\.js 项目 qq-email-mcp 0\.1\.1/)
  assert.match(markup, /入口 dist\/index\.js/)
  assert.match(markup, /Node &gt;=20\.19/)
  assert.match(markup, /需要构建/)
  assert.match(markup, /已发布到 npm/)
  assert.match(markup, /README/)
  assert.match(markup, /target="_blank"/)
  // The npm repository field is self-declared, so let the user check who actually published it.
  assert.match(markup, /href="https:\/\/www\.npmjs\.com\/package\/qq-email-mcp"/)
  assert.match(markup, /核对发布者/)
  assert.doesNotMatch(markup, /MuiAlert-root/)

  assert.equal(
    findElement(
      panel,
      (element) => (element.props as { children?: ReactNode }).children === '按本地 stdio 添加…'
    ),
    undefined
  )
})

test('project hint panel renders explanation without a local action when no draft exists', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpProjectHintPanel, {
        hint: {
          kind: 'python',
          summary: 'Python 项目 mail-mcp 0.4.0',
          notices: ['Python 项目暂不支持自动安装；可在终端自行安装后，用 本地 (stdio) 添加']
        }
      })
    )
  )
  assert.match(markup, /Python 项目暂不支持自动安装/)
  assert.doesNotMatch(markup, /按本地 stdio 添加/)
  assert.doesNotMatch(markup, /npmjs\.com/)
})

const emptyPreview = {
  repo: 'xieningqing/qq-email-mcp',
  sha: 'a'.repeat(40),
  packages: [],
  skipped: [],
  warnings: [],
  projectHint,
  localDraft
}

test('GitHub import footer uses the local stdio action for a non-Phi repository', () => {
  let received: GithubLocalConnectorDraft | undefined
  const actions = McpGithubImportActions({
    preview: emptyPreview,
    url: 'https://github.com/xieningqing/qq-email-mcp',
    busy: null,
    onClose: () => undefined,
    onPreview: () => undefined,
    onImport: () => undefined,
    onUseLocalDraft: (draft) => {
      received = draft
    }
  })
  const actionMarkup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, actions)
  )
  assert.match(actionMarkup, /取消/)
  assert.match(actionMarkup, /按本地 stdio 添加…/)
  assert.doesNotMatch(actionMarkup, />导入</)
  const localButton = findElement(
    actions,
    (element) => (element.props as { children?: ReactNode }).children === '按本地 stdio 添加…'
  )
  assert.ok(localButton)
  ;(localButton.props as { onClick: () => void }).onClick()
  assert.deepEqual(received, localDraft)

  const noDraftMarkup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      McpGithubImportActions({
        preview: { ...emptyPreview, localDraft: undefined },
        url: 'https://github.com/x/y',
        busy: null,
        onClose: () => undefined,
        onPreview: () => undefined,
        onImport: () => undefined,
        onUseLocalDraft: () => undefined
      })
    )
  )
  assert.match(noDraftMarkup, /取消/)
  assert.doesNotMatch(noDraftMarkup, /按本地 stdio 添加|>导入</)
})

test('GitHub import footer keeps import for Phi packages and explains catalog behavior', () => {
  const actions = McpGithubImportActions({
    preview: { ...emptyPreview, packages: [importedStdio] },
    url: 'https://github.com/acme/connectors',
    busy: null,
    onClose: () => undefined,
    onPreview: () => undefined,
    onImport: () => undefined,
    onUseLocalDraft: () => undefined
  })
  const actionMarkup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, actions)
  )
  assert.match(actionMarkup, /取消/)
  assert.match(actionMarkup, />导入</)
  assert.doesNotMatch(actionMarkup, /按本地 stdio 添加/)
  const importButton = findElement(
    actions,
    (element) => (element.props as { children?: ReactNode }).children === '导入'
  )
  assert.equal((importButton?.props as { disabled?: boolean }).disabled, false)
  const source = readFileSync(
    'src/renderer/src/features/mcp/components/McpGithubImportDialog.tsx',
    'utf8'
  )
  assert.match(source, /导入后，仓库里的连接器会出现在目录中，安装时仍需确认。/)
})
