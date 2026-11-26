import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material/styles'

import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { McpRemoveConfirmDialog } from '../src/renderer/src/features/mcp/components/McpRemoveConfirmDialog'
import { WrapperRemovalDialog } from '../src/renderer/src/features/wrapper/components/WrapperRemovalDialog'
import { WrapperSuiteRemovalDialog } from '../src/renderer/src/features/wrapper/components/WrapperSuiteRemovalDialog'

afterEach(() => setUiLanguage('en'))

function themed(element: React.ReactElement): string {
  const theme = createTheme({
    components: {
      MuiModal: {
        defaultProps: {
          disablePortal: true
        }
      }
    }
  })
  return renderToStaticMarkup(createElement(ThemeProvider, { theme }, element))
}

test('McpRemoveConfirmDialog renders explicit tool, credential, environment, and background cleanup hints', () => {
  setUiLanguage('zh-CN')
  const markup = themed(
    createElement(McpRemoveConfirmDialog, {
      target: {
        id: 'biomcp',
        name: 'BioMCP',
        clearsAuth: true,
        clearsEnvironment: true,
        location: 'python server.py'
      },
      onCancel: () => undefined,
      onConfirm: () => undefined
    })
  )
  assert.match(markup, /移除连接器「BioMCP」？/)
  assert.match(markup, /清除该连接器的配置及其提供的服务工具/)
  assert.match(markup, /API 密钥或登录授权状态也会一并清除/)
  assert.match(markup, /不再被其他组件引用的受管运行环境也会自动清除/)
  assert.match(markup, /确认后将在“后台任务”中执行移除与清理，不会阻塞当前界面/)
  assert.match(markup, /确认移除/)
})

test('WrapperRemovalDialog and WrapperSuiteRemovalDialog display background execution hint alongside file and dependent warnings', () => {
  setUiLanguage('zh-CN')
  const singleMarkup = themed(
    createElement(WrapperRemovalDialog, {
      target: {
        id: 'module-nf-core-samtools-sort',
        name: 'samtools-sort',
        dependents: [{ id: 'subworkflow-bam-sort', name: 'bam-sort' }]
      },
      removing: false,
      onClose: () => undefined,
      onConfirm: () => undefined
    })
  )
  assert.match(singleMarkup, /移除 Wrapper 包「samtools-sort」？/)
  assert.match(singleMarkup, /bam-sort/)
  assert.match(singleMarkup, /确认后将在“后台任务”中执行移除，不会阻塞当前界面/)

  const suiteMarkup = themed(
    createElement(WrapperSuiteRemovalDialog, {
      suite: 'samtools',
      targets: [
        {
          id: 'module-nf-core-samtools-sort',
          name: 'samtools-sort',
          dependents: []
        }
      ],
      removing: false,
      onClose: () => undefined,
      onConfirm: () => undefined
    })
  )
  assert.match(suiteMarkup, /移除 samtools 的全部工具？/)
  assert.match(suiteMarkup, /确认后将在“后台任务”中执行移除，不会阻塞当前界面/)
})

test('all four resource modules gate uninstall behind ConfirmationDialog and dispatch to background jobs without blocking modal close', () => {
  const skillCatalogSource = readFileSync(
    'src/renderer/src/features/skill/components/SkillCatalogDialog.tsx',
    'utf8'
  )
  const mcpCatalogSource = readFileSync(
    'src/renderer/src/features/mcp/components/McpConnectorCatalogDialog.tsx',
    'utf8'
  )
  const mcpDetailSource = readFileSync(
    'src/renderer/src/features/mcp/components/McpDetailPanel.tsx',
    'utf8'
  )
  const pluginDetailSource = readFileSync(
    'src/renderer/src/features/phi-plugin/components/PhiPluginDetail.tsx',
    'utf8'
  )
  const wrapperRemovalSource = readFileSync(
    'src/renderer/src/features/wrapper/hooks/useWrapperRemoval.ts',
    'utf8'
  )
  const wrapperSuiteSource = readFileSync(
    'src/renderer/src/features/wrapper/hooks/useWrapperSuiteActions.ts',
    'utf8'
  )

  assert.match(skillCatalogSource, /data-phi-skill-uninstall-dialog="true"/)
  assert.match(skillCatalogSource, /runResourceUninstallInBackground/)
  assert.match(mcpCatalogSource, /<McpRemoveConfirmDialog/)
  assert.match(mcpCatalogSource, /runResourceUninstallInBackground/)
  assert.match(mcpDetailSource, /<McpRemoveConfirmDialog/)
  assert.match(mcpDetailSource, /runResourceUninstallInBackground/)
  assert.match(pluginDetailSource, /PluginUninstallImpactSummary/)
  assert.match(pluginDetailSource, /setPendingUninstall\(null\)[\s\S]{0,120}onUninstall/)
  assert.match(
    wrapperRemovalSource,
    /setPending\(null\)[\s\S]{0,120}runResourceUninstallInBackground/
  )
  assert.match(
    wrapperSuiteSource,
    /setPendingRemoval\(null\)[\s\S]{0,180}runResourceUninstallInBackground/
  )
})
