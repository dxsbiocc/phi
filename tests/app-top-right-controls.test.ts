import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { TopRightControls } from '../src/renderer/src/App'
import { workspaceSidebarModeIsExpanded } from '../src/renderer/src/lib/workspaceSidebar'
import { workspaceScopeLabelForCwd } from '../src/renderer/src/lib/workspaceScope'

function renderControls(
  options: {
    showInspectorFullscreen?: boolean
    inspectorFullscreen?: boolean
    showInspectorToggle?: boolean
    inspectorCollapsed?: boolean
  } = {}
): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(TopRightControls, {
        showInspectorFullscreen: options.showInspectorFullscreen ?? true,
        inspectorFullscreen: options.inspectorFullscreen ?? false,
        inspectorCollapsed: options.inspectorCollapsed ?? false,
        showInspectorToggle: options.showInspectorToggle ?? true,
        onToggleInspectorFullscreen: () => undefined,
        onToggleInspector: () => undefined,
        onMinimize: () => undefined
      })
    )
  )
}

test('analysis top-right controls render in the expected chrome order', () => {
  const markup = renderControls()
  const fullscreenIndex = markup.indexOf('aria-label="右侧内容全屏"')
  const minimizeIndex = markup.indexOf('aria-label="最小化"')
  const inspectorIndex = markup.indexOf('aria-label="关闭右侧栏"')

  assert.ok(fullscreenIndex >= 0)
  assert.ok(minimizeIndex > fullscreenIndex)
  assert.ok(inspectorIndex > minimizeIndex)
  assert.match(markup, /data-phi-top-right-controls="analysis"/)
  assert.match(markup, /data-phi-inspector-fullscreen-button="collapsed"/)
  assert.match(markup, /data-phi-inspector-toggle-button="expanded"/)
  assert.match(markup, /data-phi-inspector-toggle-position="titlebar-flow"/)
  assert.match(markup, /data-phi-inspector-toggle-anchor="analysis-chrome"/)
})

test('analysis top-right controls keep the inspector action in place when collapsed', () => {
  const markup = renderControls({ inspectorCollapsed: true })

  assert.match(markup, /aria-label="展开右侧栏"/)
  assert.match(markup, /data-phi-inspector-toggle-button="collapsed"/)
  assert.match(markup, /data-phi-inspector-toggle-position="titlebar-flow"/)
})

test('analysis top-right controls hide the inspector fullscreen action when the inspector is hidden', () => {
  const markup = renderControls({ showInspectorFullscreen: false })

  assert.doesNotMatch(markup, /aria-label="右侧内容全屏"/)
  assert.doesNotMatch(markup, /data-phi-inspector-fullscreen-button/)
  assert.match(markup, /aria-label="最小化"/)
  assert.match(markup, /aria-label="关闭右侧栏"/)
})

test('analysis top-right controls can show the exit action for inspector fullscreen', () => {
  const markup = renderControls({ inspectorFullscreen: true, showInspectorToggle: false })

  assert.match(markup, /aria-label="退出右侧内容全屏"/)
  assert.match(markup, /data-phi-inspector-fullscreen-button="expanded"/)
  assert.doesNotMatch(markup, /data-phi-inspector-toggle-button/)
})

test('analysis top-right controls stay hidden when not requested', () => {
  assert.equal(renderControls({ showInspectorFullscreen: false, showInspectorToggle: false }), '')
})

test('analysis workspace skips the blank outer titlebar', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

  assert.match(appSource, /const isAnalysisWorkspaceView = activeView === 'analysis'/)
  assert.match(appSource, /const showWorkspaceTitlebar = !isAnalysisWorkspaceView/)
  assert.doesNotMatch(appSource, /activeView !== 'analysis' \|\| Boolean\(filePreview\)/)
  assert.match(appSource, /\{showWorkspaceTitlebar \? \(/)
  assert.match(appSource, /data-phi-workspace-file-header="true"/)
  assert.match(appSource, /data-phi-workspace-file-tabs="true"/)
  assert.match(appSource, /borderRadius: '999px'/)
  assert.match(appSource, /layout="workspace"/)
  assert.match(appSource, /workspaceFileTabs=\{workspaceFileTabs\}/)
})

test('analysis session scope label follows the active session cwd, not the open sidebar mode', () => {
  const projects = [
    { name: '单细胞项目', workingDirectory: '/work/scrna' },
    { name: '质谱项目', workingDirectory: '/work/proteomics' }
  ]

  assert.equal(workspaceScopeLabelForCwd('/work/scrna', projects), '单细胞项目')
  assert.equal(workspaceScopeLabelForCwd('/ordinary/workspace', projects), '普通')
})

test('workspace nav content hover is used whenever the target sidebar mode is collapsed', () => {
  assert.equal(
    workspaceSidebarModeIsExpanded({
      activeView: 'chat',
      isSidebarOpen: true,
      workspaceSidebarMode: 'conversations',
      mode: 'conversations'
    }),
    true
  )
  assert.equal(
    workspaceSidebarModeIsExpanded({
      activeView: 'chat',
      isSidebarOpen: true,
      workspaceSidebarMode: 'conversations',
      mode: 'projects'
    }),
    false
  )
  assert.equal(
    workspaceSidebarModeIsExpanded({
      activeView: 'projects',
      isSidebarOpen: false,
      workspaceSidebarMode: 'projects',
      mode: 'projects'
    }),
    false
  )
  assert.equal(
    workspaceSidebarModeIsExpanded({
      activeView: 'runtime',
      isSidebarOpen: true,
      workspaceSidebarMode: 'projects',
      mode: 'projects'
    }),
    false
  )
})

test('workspace nav content hover renders as a compact flyout', () => {
  const activityBarSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/AppActivityBar.tsx'),
    'utf8'
  )
  const hoverPreviewStart = activityBarSource.indexOf('data-phi-workspace-sidebar-hover-preview=')
  const hoverPreviewEnd = activityBarSource.indexOf('<SessionSidebar')

  assert.notEqual(hoverPreviewStart, -1)
  assert.notEqual(hoverPreviewEnd, -1)

  const hoverPreviewSource = activityBarSource.slice(hoverPreviewStart, hoverPreviewEnd)

  assert.match(hoverPreviewSource, /width: workspaceSidebarPreviewWidth/)
  assert.match(hoverPreviewSource, /maxHeight: 'min\(420px, calc\(100vh - 96px\)\)'/)
  assert.doesNotMatch(hoverPreviewSource, /height: `calc\(100vh/)

  const sessionSidebarSource = activityBarSource.slice(hoverPreviewEnd)
  assert.match(sessionSidebarSource, /compactHoverPreview/)
})
