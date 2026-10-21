import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dialog = readFileSync(
  'src/renderer/src/features/mcp/components/McpConnectorCatalogDialog.tsx',
  'utf8'
)
const customGroup = readFileSync(
  'src/renderer/src/features/mcp/components/McpCustomConnectorGroup.tsx',
  'utf8'
)
const progressHook = readFileSync(
  'src/renderer/src/features/mcp/hooks/useConnectorSetupProgress.ts',
  'utf8'
)
const customHook = readFileSync(
  'src/renderer/src/features/mcp/hooks/useCustomConnectorCatalogEntries.ts',
  'utf8'
)
const view = readFileSync('src/renderer/src/features/mcp/McpView.tsx', 'utf8')
const sidebar = readFileSync('src/renderer/src/AppWorkspaceSidebar.tsx', 'utf8')
const app = readFileSync('src/renderer/src/App.tsx', 'utf8')

test('catalog dialog appends a counted 自建 group with custom-only search and detail rendering', () => {
  assert.match(dialog, /type CatalogGroup = [^\n]*\| typeof CUSTOM_CONNECTOR_GROUP/)
  assert.match(customHook, /customConnectorEntries\(servers, jobs\)/)
  assert.ok(
    dialog.indexOf('mcpConnectorCategories') < dialog.indexOf('id: CUSTOM_CONNECTOR_GROUP'),
    'the custom group should render after catalog categories'
  )
  assert.match(dialog, /count: customEntries\.length/)
  assert.match(dialog, /group === CUSTOM_CONNECTOR_GROUP \? \([\s\S]*?McpCustomConnectorGroup/)
  assert.match(dialog, /McpCustomConnectorDetail/)
  assert.match(customGroup, /McpCustomConnectorCard/)
  assert.match(customGroup, /McpCustomConnectorEmptyState/)
})

test('catalog dialog loads revision-ordered jobs and switches once for a ready list-page event', () => {
  assert.match(progressHook, /listLocalConnectorJobs/)
  assert.match(progressHook, /mergeCustomConnectorJobs/)
  assert.match(customHook, /customConnectorReadySwitchKey/)
  assert.match(
    customHook,
    /readySwitchKeysRef\.current\.has\(switchKey\)[\s\S]*?readySwitchKeysRef\.current\.add\(switchKey\)[\s\S]*?onReady\(\)/
  )
  assert.match(
    dialog,
    /showReadyCustomGroup[\s\S]*?setGroup\(CUSTOM_CONNECTOR_GROUP\)[\s\S]*?onReady: showReadyCustomGroup/
  )
})

test('查看进度 threads the existing dialog-close and requested-job path from App', () => {
  assert.match(view, /onOpenConnectorJob/)
  assert.match(view, /<McpConnectorCatalogDialog[\s\S]*?onOpenConnectorJob=\{onOpenConnectorJob\}/)
  assert.match(sidebar, /onOpenConnectorJob=\{onOpenLocalConnectorJobs\}/)
  assert.match(app, /onOpenConnectorJob:\s*onOpenLocalConnectorJobs/)
  assert.match(
    app,
    /onOpenLocalConnectorJobs[\s\S]*?mcpConnectorDialogCloserRef\.current\?\.\(\)[\s\S]*?requestConnectorJob\(jobId\)[\s\S]*?onOpenBackgroundJobs\(\)/
  )
})

test('custom detail reuses connector enablement and removes local or remote servers before returning', () => {
  assert.match(dialog, /setConnectorEnabled\(selectedCustom\.server, enabled\)/)
  assert.match(
    dialog,
    /server\.userStdio[\s\S]*?removeLocalMcpConnector\(server\.name\)[\s\S]*?server\.url[\s\S]*?removeRemoteMcpConnector\(server\.name, server\.url\)[\s\S]*?await onRefresh\(\)[\s\S]*?setPage\('list'\)/
  )
})
