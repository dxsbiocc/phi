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
    showSidePanelRefresh?: boolean
    sidePanelRefreshDisabled?: boolean
    showSidePanelToggle?: boolean
    sidePanelCollapsed?: boolean
  } = {}
): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(TopRightControls, {
        showSidePanelRefresh: options.showSidePanelRefresh ?? true,
        sidePanelRefreshDisabled: options.sidePanelRefreshDisabled ?? false,
        sidePanelCollapsed: options.sidePanelCollapsed ?? false,
        showSidePanelToggle: options.showSidePanelToggle ?? true,
        onRefreshSidePanel: () => undefined,
        onToggleSidePanel: () => undefined
      })
    )
  )
}

test('workspace top-right controls render refresh and side-panel actions in one row', () => {
  const markup = renderControls()
  const refreshIndex = markup.indexOf('aria-label="刷新文件树"')
  const sidePanelIndex = markup.indexOf('aria-label="关闭右侧栏"')

  assert.ok(refreshIndex >= 0)
  assert.ok(sidePanelIndex > refreshIndex)
  assert.doesNotMatch(markup, /aria-label="最小化"/)
  assert.doesNotMatch(markup, /aria-label="右侧面板全屏"/)
  assert.match(markup, /data-phi-top-right-controls="workspace"/)
  assert.match(markup, /data-phi-workspace-side-panel-refresh-button="true"/)
  assert.match(markup, /data-phi-side-panel-toggle-button="expanded"/)
  assert.match(markup, /data-phi-side-panel-toggle-icon="collapse"/)
  assert.match(markup, /data-phi-side-panel-toggle-position="titlebar-flow"/)
  assert.match(markup, /data-phi-side-panel-toggle-anchor="workspace-chrome"/)
})

test('workspace top-right controls keep the side panel action in place when collapsed', () => {
  const markup = renderControls({ sidePanelCollapsed: true, showSidePanelRefresh: false })

  assert.match(markup, /aria-label="展开右侧栏"/)
  assert.doesNotMatch(markup, /aria-label="刷新文件树"/)
  assert.match(markup, /data-phi-side-panel-toggle-button="collapsed"/)
  assert.match(markup, /data-phi-side-panel-toggle-icon="expand"/)
  assert.match(markup, /data-phi-side-panel-toggle-position="titlebar-flow"/)
})

test('workspace top-right controls can disable refresh without moving the side panel action', () => {
  const markup = renderControls({ sidePanelRefreshDisabled: true })

  assert.match(markup, /aria-label="刷新文件树"/)
  assert.match(markup, /disabled=""/)
  assert.match(markup, /aria-label="关闭右侧栏"/)
})

test('workspace top-right controls hide refresh when the side panel is hidden', () => {
  const markup = renderControls({ showSidePanelRefresh: false })

  assert.doesNotMatch(markup, /aria-label="刷新文件树"/)
  assert.match(markup, /aria-label="关闭右侧栏"/)
})

test('workspace top-right controls stay hidden when not requested', () => {
  assert.equal(renderControls({ showSidePanelRefresh: false, showSidePanelToggle: false }), '')
})

test('analysis workspace skips the blank outer titlebar', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

  assert.match(appSource, /const isAnalysisWorkspaceView = activeView === 'analysis'/)
  assert.match(
    appSource,
    /const showWorkspaceTitlebar =\s*!isAnalysisWorkspaceView && !isResourceWorkspaceView && !showWorkspaceTabs/
  )
  assert.doesNotMatch(appSource, /activeView !== 'analysis' \|\| Boolean\(filePreview\)/)
  assert.match(appSource, /\{showWorkspaceTitlebar \? \(/)
  assert.match(appSource, /data-phi-workspace-file-header="true"/)
  assert.match(appSource, /data-phi-workspace-file-tabs="true"/)
  assert.match(appSource, /borderRadius: '999px'/)
  assert.match(appSource, /layout="workspace"/)
  assert.match(appSource, /workspaceFileTabs=\{workspaceFileTabs\}/)
})

test('workspace sessions and resources share the same tab strip', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const tabSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/WorkspaceResourceTabs.tsx'),
    'utf8'
  )
  const tabTypesSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/lib/workspaceResourceTabs.ts'),
    'utf8'
  )

  assert.match(appSource, /const \[workspaceTabs, setWorkspaceTabs\] = useState<WorkspaceTab\[\]>/)
  assert.match(appSource, /workspaceSessionTabKey\(activeSessionPath, activeSessionGeneration\)/)
  assert.match(
    appSource,
    /const showWorkspaceTabs =\s*visibleWorkspaceTabs\.length > 0 && \(activeView === 'chat' \|\| isResourceWorkspaceView\)/
  )
  assert.match(appSource, /tabs=\{visibleWorkspaceTabs\}/)
  assert.match(appSource, /onSelect=\{selectWorkspaceTab\}/)
  assert.match(appSource, /onClose=\{onCloseWorkspaceTab\}/)
  assert.match(
    appSource,
    /activeWorkspaceTab\?\.kind === 'session' \? chatWorkspaceContent : activeWorkspaceResourceContent/
  )
  assert.match(
    tabTypesSource,
    /export type WorkspaceTab = WorkspaceSessionTab \| WorkspaceResourceTab/
  )
  assert.match(tabSource, /session: PhiIcons\.nav\.chat/)
})

test('workspace top-right controls are app-level chrome, not notebook-only content', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

  assert.match(appSource, /const titlebarChromeTopOffset = '10px'/)
  assert.match(appSource, /const titlebarChromeHorizontalInset = '14px'/)
  assert.match(appSource, /const titlebarChromeIconButtonSize = 28/)
  assert.match(appSource, /width: titlebarChromeIconButtonSize/)
  assert.match(appSource, /height: titlebarChromeIconButtonSize/)
  assert.match(appSource, /pointerEvents: 'auto'[\s\S]{0,120}WebkitAppRegion: 'no-drag'/)
  assert.match(appSource, /data-phi-workspace-top-right-chrome="true"/)
  const topRightChromeIndex = appSource.indexOf('data-phi-workspace-top-right-chrome="true"')
  const workspaceTitlebarIndex = appSource.indexOf(
    "WebkitAppRegion: 'drag'",
    appSource.indexOf('{showWorkspaceTitlebar ? (')
  )
  const workspaceSidePanelIndex = appSource.indexOf('data-phi-workspace-side-panel-shell="true"')
  assert.ok(
    topRightChromeIndex > workspaceTitlebarIndex,
    'top-right controls must render after workspace drag titlebars so clicks are not swallowed'
  )
  assert.ok(
    topRightChromeIndex > workspaceSidePanelIndex,
    'top-right controls must render after the workspace side panel shell so they stay clickable on top'
  )
  assert.doesNotMatch(appSource, /isChatWorkspaceView \? \([\s\S]{0,400}<TopRightControls/)
  assert.match(appSource, /left: titlebarChromeHorizontalInset[\s\S]{0,360}<MacWindowControls/)
  assert.match(appSource, /position: 'absolute'[\s\S]{0,360}<TopRightControls/)
  assert.match(appSource, /top: titlebarChromeTopOffset[\s\S]{0,360}<TopRightControls/)
  assert.match(appSource, /right: titlebarChromeHorizontalInset[\s\S]{0,360}<TopRightControls/)
  assert.match(appSource, /showSidePanelRefresh=\{!workspaceSidePanelCollapsed\}/)
  assert.match(appSource, /sidePanelRefreshDisabled=\{!activeCwd\}/)
  assert.match(appSource, /onRefreshSidePanel=\{onRefreshWorkspaceSidePanel\}/)
  assert.match(appSource, /onToggleSidePanel=\{onToggleWorkspaceSidePanel\}/)
  assert.doesNotMatch(appSource, /showSidePanelFullscreen/)
  assert.doesNotMatch(appSource, /workspaceSidePanelFullscreen/)
  assert.doesNotMatch(appSource, /onToggleWorkspaceSidePanelFullscreen/)
  assert.doesNotMatch(appSource, /FiMaximize2/)
  assert.doesNotMatch(appSource, /FiMinimize2/)
  assert.match(appSource, /GoSync/)
  assert.match(appSource, /const RefreshIcon = GoSync/)
  assert.match(appSource, /GoSidebarCollapse/)
  assert.match(appSource, /GoSidebarExpand/)
  assert.doesNotMatch(appSource, /TbLayoutSidebarRight/)
  assert.doesNotMatch(appSource, /<TopRightControls[\s\S]{0,400}onMinimize=/)
  assert.doesNotMatch(appSource, /FiMinus/)
  assert.doesNotMatch(appSource, /topRightControls=\{\(chromeState\) =>/)
})

test('workspace file previews and chats can show the shared right side panel', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

  assert.match(appSource, /data-phi-workspace-side-panel-shell="true"/)
  assert.match(appSource, /!workspaceSidePanelCollapsed \? \([\s\S]*?<WorkspaceSidePanel/)
  assert.match(appSource, /workspaceRootPath=\{activeCwd\}/)
  assert.match(appSource, /activeWorkspacePath=\{activeWorkspaceSidePanelPath\}/)
  assert.doesNotMatch(
    appSource,
    /activeWorkspaceFileTab\.kind !== 'notebook'[\s\S]{0,900}<WorkspaceSidePanel/
  )
  assert.doesNotMatch(appSource, /activeChatView[\s\S]{0,900}<WorkspaceSidePanel/)
  assert.match(appSource, /label="调整工作区面板宽度"/)
  assert.match(appSource, /treeRevision=\{workspaceSidePanelTreeRevision\}/)
  assert.match(appSource, /titlebarInsetEnd=\{titlebarTrailingSidePanelChromeReserve\}/)
  assert.doesNotMatch(appSource, /position: 'fixed'[\s\S]{0,120}inset: 0/)
})

test('workspace file titlebars reserve trailing app chrome only at the window edge', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

  assert.match(appSource, /FilePreviewTitleTab,/)
  assert.match(appSource, /const titlebarLeadingChromeReserveWidth = 220/)
  assert.match(appSource, /const titlebarTrailingSidePanelChromeReserve = '84px'/)
  assert.match(appSource, /const titlebarTrailingToggleChromeReserve = '56px'/)
  assert.match(
    appSource,
    /const workspaceFileHeaderLeadingChromeInsetWidth =\s*titlebarLeadingChromeReserveWidth - activityBarWidth/
  )
  assert.match(
    appSource,
    /const workspaceFileHeaderLeadingChromeInset = `\$\{workspaceFileHeaderLeadingChromeInsetWidth\}px`/
  )
  assert.match(
    appSource,
    /filePreview && !showProjectSessionPlaceholder \? \([\s\S]{0,220}<FilePreviewTitleTab/
  )
  assert.match(
    appSource,
    /titlebarInsetEnd=\{\s*workspaceSidePanelCollapsed \? titlebarTrailingToggleChromeReserve : 1\.25\s*\}/
  )
  assert.match(appSource, /onClose=\{onCloseCurrentFilePreview\}/)
  assert.match(
    appSource,
    /pl: reserveLeadingChromeSpace \? workspaceFileHeaderLeadingChromeInset : 1\.5/
  )
  assert.match(appSource, /reserveTrailingChromeSpace\?: boolean/)
  assert.match(
    appSource,
    /pr: reserveTrailingChromeSpace \? titlebarTrailingToggleChromeReserve : 1\.5/
  )
  assert.match(appSource, /reserveLeadingChromeSpace=\{isMac && !isSidebarOpen\}/)
  assert.match(appSource, /reserveTrailingChromeSpace=\{workspaceSidePanelCollapsed\}/)
})

test('workspace file tabs reuse cached surfaces when switching', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const analysisSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/AnalysisView.tsx'),
    'utf8'
  )

  assert.match(appSource, /const showCachedOrLoadFilePreview = useCallback/)
  assert.match(appSource, /filePreviewCache\[tab\.path\]/)
  assert.match(appSource, /activateCachedAnalysisNotebook\(tab\.path\)/)
  assert.doesNotMatch(analysisSource, /<NotebookCanvas[\s\S]{0,240}key=\{notebookFile/)
})

test('analysis session scope label follows the active session cwd, not the open sidebar mode', () => {
  const projects = [
    { name: '单细胞项目', workingDirectory: '/work/scrna' },
    { name: '质谱项目', workingDirectory: '/work/proteomics' }
  ]

  assert.equal(workspaceScopeLabelForCwd('/work/scrna', projects), '单细胞项目')
  assert.equal(workspaceScopeLabelForCwd('/ordinary/workspace', projects), '普通')
})

test('analysis sidebar shows a static session title instead of a selector button', () => {
  const sidebarSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/AppWorkspaceSidebar.tsx'),
    'utf8'
  )

  assert.match(sidebarSource, /data-phi-analysis-session-header="true"/)
  assert.match(sidebarSource, /activeWorkspaceTitle/)
  assert.match(sidebarSource, /data-phi-analysis-session-scope-label=/)
  assert.doesNotMatch(sidebarSource, /data-phi-analysis-session-select-button/)
  assert.doesNotMatch(sidebarSource, /data-phi-analysis-session-select-menu/)
  assert.doesNotMatch(sidebarSource, /analysisSessionSelectorAnchor/)
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
    true
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
