import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { AppResizeSeparator } from '../src/renderer/src/components/app-shell/AppResizeSeparator'
import {
  WorkspaceFileHeader,
  WorkspaceResourceHeader,
  titlebarTrailingToggleChromeReserve
} from '../src/renderer/src/components/app-shell/WorkspaceTitlebar'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import type { WorkspaceFileTab } from '../src/renderer/src/useWorkspaceFileTabs'
import type { WorkspaceTab } from '../src/renderer/src/lib/workspaceResourceTabs'

test.beforeEach(() => setUiLanguage('zh-CN'))
test.afterEach(() => setUiLanguage('en'))

const theme = createTheme()

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme }, element))
}

function fileTab(overrides: Partial<WorkspaceFileTab> = {}): WorkspaceFileTab {
  return {
    id: 'file-1',
    path: 'src/index.ts',
    name: 'index.ts',
    status: 'ready',
    kind: 'file',
    pathKind: 'file',
    absolutePath: '/workspace/src/index.ts',
    ...overrides
  }
}

function resourceTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    key: 'resource:runtime',
    kind: 'runtime',
    itemId: 'runtime',
    title: '运行时',
    ...overrides
  } as WorkspaceTab
}

test('workspace file header keeps its tab strip and trailing chrome reserve', () => {
  const markup = render(
    createElement(WorkspaceFileHeader, {
      tabs: [
        fileTab(),
        fileTab({ id: 'file-2', path: 'src/main.ts', name: 'main.ts', dirty: true })
      ],
      activePath: 'src/main.ts',
      onSelect: () => undefined,
      onClose: () => undefined,
      leadingChromeInset: 50,
      reserveTrailingChromeSpace: true
    })
  )

  assert.match(markup, /data-phi-workspace-file-header="true"/)
  assert.match(markup, /data-phi-workspace-file-tabs="true"/)
  assert.match(markup, /data-phi-workspace-file-tab="active"/)
  assert.match(markup, /data-phi-workspace-file-tab="inactive"/)
  assert.match(markup, /data-phi-workspace-file-kind="file"/)
  assert.match(markup, /title="\/workspace\/src\/index.ts"/)
  // The dirty tab is the active one, so it keeps its close affordance and dot.
  assert.match(markup, /aria-label="关闭 main.ts"/)
  assert.match(markup, /border-radius:999px/)
  assert.match(markup, /padding-left:50px/)
  assert.match(markup, new RegExp(`padding-right:${titlebarTrailingToggleChromeReserve}`))
})

test('workspace file header collapses to a plain content inset without window chrome', () => {
  const markup = render(
    createElement(WorkspaceFileHeader, {
      tabs: [fileTab()],
      activePath: 'src/index.ts',
      onSelect: () => undefined,
      onClose: () => undefined
    })
  )

  assert.match(markup, /padding-left:12px/)
  assert.match(markup, /padding-right:12px/)
  assert.doesNotMatch(markup, new RegExp(`padding-right:${titlebarTrailingToggleChromeReserve}`))
})

test('workspace resource header renders resource tabs plus its trailing actions', () => {
  const markup = render(
    createElement(WorkspaceResourceHeader, {
      tabs: [
        resourceTab(),
        resourceTab({ key: 'resource:plugins', kind: 'plugins', itemId: 'plugins', title: '插件' })
      ],
      activeKey: 'resource:plugins',
      onSelect: () => undefined,
      onClose: () => undefined,
      actions: createElement('span', { 'data-testid': 'header-actions' }, 'actions')
    })
  )

  assert.match(markup, /data-phi-workspace-resource-header="true"/)
  assert.match(markup, /data-phi-workspace-resource-tabs="true"/)
  assert.match(markup, /data-testid="header-actions"/)
  // Session docking is optional: no dock affordance without the callback.
  assert.doesNotMatch(markup, /data-phi-workspace-resource-tab-dock/)
})

test('resize separator exposes a vertical separator that reports its drag start', () => {
  let started = 0
  const markup = render(
    createElement(AppResizeSeparator, {
      label: '调整侧栏宽度',
      onMouseDown: () => {
        started += 1
      }
    })
  )

  assert.match(markup, /role="separator"/)
  assert.match(markup, /aria-orientation="vertical"/)
  assert.match(markup, /aria-label="调整侧栏宽度"/)
  assert.match(markup, /cursor:col-resize/)
  assert.equal(started, 0)
})
