import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { TopRightControls } from '../src/renderer/src/App'
import type { WorkspaceSidePanelMode } from '../src/renderer/src/lib/workspaceSidePanelMode'
import { workspaceSidebarModeIsExpanded } from '../src/renderer/src/lib/workspaceSidebar'
import { workspaceScopeLabelForCwd } from '../src/renderer/src/lib/workspaceScope'

function renderControls(
  options: {
    showSidePanelRefresh?: boolean
    sidePanelRefreshDisabled?: boolean
    showSidePanelButtons?: boolean
    activePanels?: WorkspaceSidePanelMode[]
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
        activePanels: options.activePanels ?? [],
        showSidePanelButtons: options.showSidePanelButtons ?? true,
        onRefreshSidePanel: () => undefined,
        onTogglePanel: () => undefined
      })
    )
  )
}

test('workspace top-right controls place jobs, terminal, and browser side by side', () => {
  const markup = renderControls()
  const refreshIndex = markup.indexOf('aria-label="刷新文件树"')
  const jobsIndex = markup.indexOf('aria-label="后台任务"')
  const terminalIndex = markup.indexOf('aria-label="终端"')
  const browserIndex = markup.indexOf('aria-label="浏览器"')

  assert.ok(refreshIndex >= 0)
  assert.ok(jobsIndex > refreshIndex)
  assert.ok(terminalIndex > jobsIndex)
  assert.ok(browserIndex > terminalIndex)
  assert.match(markup, /data-phi-background-jobs-toggle-button="true"/)
  assert.match(markup, /data-phi-terminal-toggle-button="true"/)
  assert.match(markup, /data-phi-browser-toggle-button="true"/)
  assert.doesNotMatch(markup, /aria-label="最小化"/)
  assert.doesNotMatch(markup, /aria-label="右侧面板全屏"/)
  assert.doesNotMatch(markup, /aria-label="展开右侧栏"/)
  assert.match(markup, /data-phi-top-right-controls="workspace"/)
  assert.match(markup, /data-phi-workspace-side-panel-refresh-button="true"/)
})

test('right-side buttons use Go icons and the left navigation color treatment', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const controlsSource = appSource.slice(
    appSource.indexOf('export function TopRightControls'),
    appSource.indexOf('function WorkspaceFileTabs')
  )

  assert.match(
    appSource,
    /import \{ GoGlobe, GoStack, GoSync, GoTerminal \} from 'react-icons\/go'/
  )
  assert.match(controlsSource, /<GoStack aria-hidden focusable="false" size=\{20\}/)
  assert.match(controlsSource, /<GoTerminal aria-hidden focusable="false" size=\{20\}/)
  assert.match(controlsSource, /<GoGlobe aria-hidden focusable="false" size=\{20\}/)
  assert.match(controlsSource, /color: active \? 'primary\.main' : 'text\.secondary'/)
  assert.match(controlsSource, /bgcolor: 'action\.hover'/)
  assert.doesNotMatch(controlsSource, /bgcolor: activePanel ===/)
})

test('workspace top-right controls mark every open slot as pressed', () => {
  const markup = renderControls({
    activePanels: ['jobs', 'browser'],
    showSidePanelRefresh: false
  })

  assert.match(markup, /aria-label="后台任务"/)
  assert.match(markup, /aria-label="终端"/)
  assert.match(markup, /aria-label="浏览器"/)
  assert.doesNotMatch(markup, /aria-label="刷新文件树"/)
  assert.match(markup, /aria-label="后台任务" aria-pressed="true"/)
  assert.match(markup, /aria-label="终端" aria-pressed="false"/)
  assert.match(markup, /aria-label="浏览器" aria-pressed="true"/)
})

test('workspace top-right controls can disable refresh without moving panel buttons', () => {
  const markup = renderControls({ sidePanelRefreshDisabled: true })

  assert.match(markup, /aria-label="刷新文件树"/)
  assert.match(markup, /disabled=""/)
  assert.match(markup, /aria-label="后台任务"/)
  assert.match(markup, /aria-label="终端"/)
  assert.match(markup, /aria-label="浏览器"/)
})

test('workspace top-right controls hide refresh when the side panel is hidden', () => {
  const markup = renderControls({ showSidePanelRefresh: false })

  assert.doesNotMatch(markup, /aria-label="刷新文件树"/)
  assert.match(markup, /aria-label="后台任务"/)
  assert.match(markup, /aria-label="终端"/)
  assert.match(markup, /aria-label="浏览器"/)
})

test('workspace top-right controls stay hidden when not requested', () => {
  assert.equal(renderControls({ showSidePanelRefresh: false, showSidePanelButtons: false }), '')
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
    /const showWorkspaceTabs =\s*visibleWorkspaceTabs\.length > 0 &&\s*\(activeView === 'chat' \|\| activeView === 'analysis' \|\| isResourceWorkspaceView\)/
  )
  assert.match(appSource, /workspaceFileWorkspaceTabs/)
  assert.match(
    appSource,
    /const shouldShowSessionWorkspaceTab = !\(\s*activeView === 'analysis' && workspaceSidebarMode === 'conversations'\s*\)/
  )
  assert.match(appSource, /visibleWorkspaceTabsForState\(\{/)
  assert.match(appSource, /sessionTabWasOpened/)
  assert.match(tabTypesSource, /export function visibleWorkspaceTabsForState/)
  assert.match(appSource, /workspaceFileTabKey\(tab\.path\)/)
  assert.match(appSource, /isWorkspaceFileWorkspaceTab\(tab\)/)
  assert.match(appSource, /tabs=\{visibleWorkspaceTabs\}/)
  assert.match(appSource, /onSelect=\{selectWorkspaceTab\}/)
  assert.match(appSource, /onClose=\{onCloseWorkspaceTab\}/)
  assert.match(
    appSource,
    /activeWorkspaceResourceTab\.kind === 'plugins'[\s\S]{0,500}<PhiPluginsView/
  )
  assert.match(
    appSource,
    /tab\.kind === 'skills' && activeSkillId === tab\.itemId[\s\S]{0,40}setActiveSkillId\(null\)/
  )
  assert.match(
    appSource,
    /tab\.kind === 'mcp' && activeMcpServerId === tab\.itemId[\s\S]{0,40}setActiveMcpServerId\(null\)/
  )
  assert.match(
    appSource,
    /tab\.kind === 'wrappers' && selectedWrapperId === tab\.itemId[\s\S]{0,40}setSelectedWrapperId\(null\)/
  )
  assert.match(appSource, /activeWorkspaceFileTabContent/)
  assert.match(
    appSource,
    /activeWorkspaceTab\?\.kind === 'session'[\s\S]{0,240}\? activeWorkspaceFileTabContent[\s\S]{0,140}: activeWorkspaceResourceContent/
  )
  assert.match(
    tabTypesSource,
    /export type WorkspaceTab = WorkspaceSessionTab \| WorkspaceResourceTab/
  )
  assert.match(tabTypesSource, /WorkspaceFileWorkspaceTab/)
  assert.match(tabSource, /session: PhiIcons\.nav\.chat/)
  assert.match(tabSource, /file: PhiIcons\.file\.document/)
  assert.match(tabSource, /directory: PhiIcons\.file\.directory/)
  assert.match(tabSource, /notebook: PhiIcons\.file\.jupyter/)
})

test('workspace top-right controls are app-level chrome, not notebook-only content', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

  assert.match(
    appSource,
    /import \{ WINDOW_TITLEBAR_HEIGHT, windowChromeLayout \} from '\.\/lib\/windowChromeLayout'/
  )
  assert.match(appSource, /const titlebarChromeHorizontalInset = '14px'/)
  assert.match(appSource, /const titlebarChromeIconButtonSize = 28/)
  assert.match(
    appSource,
    /const titlebarChromeTopOffset = `\$\{\(WINDOW_TITLEBAR_HEIGHT - titlebarChromeIconButtonSize\) \/ 2\}px`/
  )
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
  assert.match(
    appSource,
    /left: `\$\{chromeLayout\.topLeftChromeInset\}px`[\s\S]{0,500}<MacWindowControls/
  )
  assert.match(appSource, /position: 'absolute'[\s\S]{0,800}<TopRightControls/)
  assert.match(appSource, /top: titlebarChromeTopOffset[\s\S]{0,800}<TopRightControls/)
  assert.match(
    appSource,
    /right:\s*workspaceSidePanelSlots\.length === 0[\s\S]{0,160}\? titlebarChromeHorizontalInset[\s\S]{0,220}activeWorkspaceSidePanelWidth/
  )
  assert.match(
    appSource,
    /activeWorkspaceSidePanelWidth[\s\S]{0,120}workspaceSidePanelOverlay \? 0 : 1[\s\S]{0,100}titlebarChromeHorizontalInset/
  )
  assert.match(appSource, /showSidePanelRefresh=\{false\}/)
  assert.match(appSource, /sidePanelRefreshDisabled=\{false\}/)
  assert.match(appSource, /onRefreshSidePanel=\{onRefreshWorkspaceSidePanel\}/)
  assert.match(appSource, /onTogglePanel=\{onToggleWorkspaceSidePanel\}/)
  assert.match(
    appSource,
    /toggleWorkspaceSidePanelModeForLayout\(current, mode, workspaceSidePanelCanSplit\)/
  )
  assert.doesNotMatch(appSource, /showSidePanelFullscreen/)
  assert.doesNotMatch(appSource, /workspaceSidePanelFullscreen/)
  assert.doesNotMatch(appSource, /onToggleWorkspaceSidePanelFullscreen/)
  assert.doesNotMatch(appSource, /FiMaximize2/)
  assert.doesNotMatch(appSource, /FiMinimize2/)
  assert.match(appSource, /GoSync/)
  assert.match(appSource, /const RefreshIcon = GoSync/)
  assert.doesNotMatch(appSource, /GoSidebarCollapse/)
  assert.doesNotMatch(appSource, /GoSidebarExpand/)
  assert.doesNotMatch(appSource, /TbLayoutSidebarRight/)
  assert.doesNotMatch(appSource, /<TopRightControls[\s\S]{0,400}onMinimize=/)
  assert.doesNotMatch(appSource, /FiMinus/)
  assert.doesNotMatch(appSource, /topRightControls=\{\(chromeState\) =>/)
})

test('workspace file previews and chats can show the shared right side panel', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

  assert.match(appSource, /data-phi-workspace-side-panel-shell="true"/)
  assert.match(appSource, /workspaceSidePanelSlots\.length > 0 \? \([\s\S]*?<WorkspaceSidePanel/)
  assert.match(appSource, /slots=\{workspaceSidePanelSlots\}/)
  assert.match(appSource, /if \(mode === 'jobs'\) \{[\s\S]*?<BackgroundJobsPanel/)
  assert.doesNotMatch(appSource, /<WorkspaceSidePanel[\s\S]{0,180}workspaceRootPath=/)
  assert.doesNotMatch(appSource, /<WorkspaceSidePanel[\s\S]{0,180}activeWorkspacePath=/)
  assert.doesNotMatch(
    appSource,
    /activeWorkspaceFileTab\.kind !== 'notebook'[\s\S]{0,900}<WorkspaceSidePanel/
  )
  assert.doesNotMatch(appSource, /activeChatView[\s\S]{0,900}<WorkspaceSidePanel/)
  assert.match(appSource, /label="调整工作区面板宽度"/)
  assert.match(appSource, /browserSidePanelWidthDefault = workspaceSidePanelWidthDefault/)
  assert.match(appSource, /minBrowserSidePanelWidth = minWorkspaceSidePanelWidth/)
  assert.match(appSource, /maxBrowserSidePanelWidth = 820/)
  assert.match(appSource, /setBrowserSidePanelWidth/)
  assert.match(
    appSource,
    /workspaceSidePanelSlots\.includes\('browser'\)[\s\S]{0,180}browserSidePanelEffectiveWidth/
  )
  assert.match(appSource, /const browserMode = workspaceSidePanelSlots\.includes\('browser'\)/)
  assert.match(appSource, /if \(browserMode\) setBrowserSidePanelWidth\(nextWidth\)/)
  assert.match(appSource, /maximized=\{workspaceSidePanelState\.maximized\}/)
  assert.match(appSource, /onCloseSlot=\{onCloseWorkspaceSidePanelSlot\}/)
  assert.match(appSource, /onToggleMaximized=\{onToggleWorkspaceSidePanelMaximized\}/)
  assert.match(
    appSource,
    /workspaceSidePanelCanSplit = appViewportWidth >= 1200 && appViewportSize\.height >= 640/
  )
  assert.doesNotMatch(appSource, /<WorkspaceSidePanel[\s\S]{0,180}treeRevision=/)
  assert.doesNotMatch(appSource, /<WorkspaceSidePanel[\s\S]{0,180}titlebarInsetEnd=/)
  assert.doesNotMatch(appSource, /position: 'fixed'[\s\S]{0,120}inset: 0/)
})

test('terminal panel renders through its workbench slot with the slot header actions', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

  assert.match(
    appSource,
    /<TerminalPanel[\s\S]{0,160}bridge=\{rendererApi\.terminal\}[\s\S]{0,160}headerActions=\{slotContext\.headerActions\}/
  )
  assert.match(
    appSource,
    /useTerminalWorkspaceRestoration\(rendererApi\.terminal, projects, activeProjectId\)/
  )
  // Maximize and close are owned by the workbench, not by terminal-local App state.
  assert.doesNotMatch(appSource, /terminalPanelMaximized/)
})

test('workspace session tabs do not stack stale file previews under chat', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const chatWorkspaceStart = appSource.indexOf('const chatWorkspaceContent = (')
  const activeAnalysisViewStart = appSource.indexOf(
    'const activeAnalysisView =',
    chatWorkspaceStart
  )
  const chatWorkspaceSource = appSource.slice(chatWorkspaceStart, activeAnalysisViewStart)

  assert.ok(chatWorkspaceStart >= 0)
  assert.ok(activeAnalysisViewStart > chatWorkspaceStart)
  assert.doesNotMatch(chatWorkspaceSource, /<FilePreviewPanel/)
  assert.match(appSource, /compactComposerControls=\{activeView === 'analysis'\}/)
  assert.doesNotMatch(
    appSource,
    /compactComposerControls=\{activeView === 'analysis' \|\| filePreview !== null\}/
  )
})

test('workspace file opens keep the left sidebar matched to the source surface', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

  assert.match(appSource, /const showActiveConversationInSidebar = useCallback/)
  assert.match(appSource, /setWorkspaceSidebarMode\('conversations'\)/)
  assert.match(appSource, /setIsSidebarOpen\(true\)/)
  assert.match(
    appSource,
    /const previewFilePathInWorkspaceTab = useCallback[\s\S]{0,260}showActiveConversationInSidebar\(\)/
  )
  assert.match(
    appSource,
    /const previewDirectoryPathInWorkspaceTab = useCallback[\s\S]{0,260}showActiveConversationInSidebar\(\)/
  )
  assert.doesNotMatch(
    appSource,
    /const onOpenNotebookWorkspaceFile = useCallback[\s\S]{0,700}showActiveConversationInSidebar\(\)/
  )
  assert.match(appSource, /const onOpenWorkspaceFileFromSidebar = useCallback/)
  assert.match(
    appSource,
    /const onOpenWorkspaceFileFromSidebar = useCallback[\s\S]{0,800}setWorkspaceSidebarMode\('files'\)/
  )
  assert.match(
    appSource,
    /const onOpenWorkspaceFileFromSidebar = useCallback[\s\S]{0,260}openRemoteWorkspacePath\(path, 'file'\)/
  )
  assert.match(
    appSource,
    /isNotebookFilePath\(path\)[\s\S]{0,120}onOpenNotebookWorkspaceFile\(path\)/
  )
  const selectFileTabStart = appSource.indexOf('const onSelectWorkspaceFileTab = useCallback')
  const closeFileTabStart = appSource.indexOf('const onCloseWorkspaceFileTab = useCallback')
  assert.ok(selectFileTabStart >= 0)
  assert.ok(closeFileTabStart > selectFileTabStart)
  assert.doesNotMatch(
    appSource.slice(selectFileTabStart, closeFileTabStart),
    /showActiveConversationInSidebar\(\)/
  )
})

test('workspace files are available from the left sidebar activity item', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const activitySource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/AppActivityBar.tsx'),
    'utf8'
  )
  const sidebarSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/AppWorkspaceSidebar.tsx'),
    'utf8'
  )
  const sidebarModeSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/lib/workspaceSidebar.ts'),
    'utf8'
  )

  assert.match(sidebarModeSource, /'files'/)
  assert.match(activitySource, /GoFileDirectory/)
  assert.doesNotMatch(activitySource, /GoTerminal/)
  assert.match(activitySource, /const NavChatIcon = createActivityBarReactIcon\(GoComment\)/)
  assert.match(activitySource, /const NavProjectsIcon = createActivityBarReactIcon\(GoProject\)/)
  assert.match(activitySource, /const NavFilesIcon = createActivityBarReactIcon\(GoFileDirectory\)/)
  assert.match(activitySource, /const NavPluginsIcon = createActivityBarReactIcon\(GoPackage\)/)
  assert.match(activitySource, /const NavSkillsIcon = createActivityBarReactIcon\(GoBook\)/)
  assert.match(activitySource, /const NavMcpIcon = createActivityBarReactIcon\(GoWorkflow\)/)
  assert.match(activitySource, /const NavWrappersIcon = createActivityBarReactIcon\(GoContainer\)/)
  assert.match(
    activitySource,
    /const NavRuntimeIcon = createActivityBarPhiIcon\(PhiIcons\.nav\.runtime\)/
  )
  assert.match(activitySource, /const NavSettingsIcon = createActivityBarReactIcon\(GoGear\)/)
  assert.match(activitySource, /mode: 'files', label: '文件', icon: NavFilesIcon/)
  assert.match(activitySource, /navigationItems\.map\(\(\{ mode, label, icon \}\)/)
  assert.match(activitySource, /onSelectWorkspaceSidebarMode\(mode\)/)
  assert.match(sidebarSource, /workspaceSidebarMode === 'files'/)
  assert.match(sidebarSource, /data-phi-files-sidebar="true"/)
  assert.match(sidebarSource, /<WorkspaceFilesPane/)
  assert.match(appSource, /workspaceRootPath: workspaceFilesRootPath/)
  assert.doesNotMatch(sidebarSource, /远程项目文件浏览暂不可用/)
  assert.doesNotMatch(sidebarSource, /Tooltip title="刷新文件树"/)
  assert.doesNotMatch(sidebarSource, /aria-label="刷新文件树"/)
  assert.match(appSource, /onOpenWorkspaceFile: onOpenWorkspaceFileFromSidebar/)
  assert.doesNotMatch(appSource, /onRefreshWorkspaceFiles=\{onRefreshWorkspaceSidePanel\}/)
})

test('workspace file titlebars reserve trailing app chrome only at the window edge', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

  assert.match(appSource, /FilePreviewTitleTab,/)
  assert.match(appSource, /const titlebarTrailingToggleChromeReserve = '120px'/)
  assert.match(
    appSource,
    /filePreview && !showProjectSessionPlaceholder \? \([\s\S]{0,220}<FilePreviewTitleTab/
  )
  assert.match(
    appSource,
    /titlebarInsetEnd=\{\s*workspaceSidePanelCollapsed \? titlebarTrailingToggleChromeReserve : 1\.25\s*\}/
  )
  assert.match(appSource, /onClose=\{onCloseCurrentFilePreview\}/)
  assert.match(appSource, /leadingChromeInset\?: number/)
  assert.match(appSource, /pl: leadingChromeInset > 0 \? `\$\{leadingChromeInset\}px` : 1\.5/)
  assert.match(appSource, /reserveTrailingChromeSpace\?: boolean/)
  assert.match(
    appSource,
    /pr: reserveTrailingChromeSpace \? titlebarTrailingToggleChromeReserve : 1\.5/
  )
  assert.match(appSource, /leadingChromeInset=\{chromeLayout\.mainColumnTitlebarInset\}/)
  assert.match(appSource, /reserveTrailingChromeSpace=\{workspaceSidePanelCollapsed\}/)
})

test('collapsed-sidebar workspace titlebars keep their leading reserve with any workbench layout', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const chromeLayoutSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/lib/windowChromeLayout.ts'),
    'utf8'
  )

  assert.match(chromeLayoutSource, /export const WINDOW_TITLEBAR_HEIGHT = 44/)
  assert.match(
    appSource,
    /import \{ WINDOW_TITLEBAR_HEIGHT, windowChromeLayout \} from '\.\/lib\/windowChromeLayout'/
  )
  assert.match(
    appSource,
    /const chromeLayout = windowChromeLayout\(\{\s*isMac,\s*sidebarOpen: isSidebarOpen,\s*fullscreen: isWindowFullscreen\s*\}\)/
  )
  assert.match(
    appSource,
    /data-phi-workspace-titlebar="true"[\s\S]{0,180}height: WINDOW_TITLEBAR_HEIGHT/
  )
  assert.match(
    appSource,
    /data-phi-workspace-titlebar="true"[\s\S]{0,600}pl: `\$\{chromeLayout\.mainColumnTitlebarInset\}px`/
  )
  assert.equal(
    (appSource.match(/leadingChromeInset=\{chromeLayout\.mainColumnTitlebarInset\}/g) ?? []).length,
    2,
    'file and resource titlebars must use the same workbench-independent leading inset'
  )
  assert.doesNotMatch(appSource, /reserveLeadingChromeSpace=\{isMac && !isSidebarOpen\}/)
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
  const hoverPreviewEnd = activityBarSource.indexOf('<AppWorkspaceSidebar', hoverPreviewStart)

  assert.notEqual(hoverPreviewStart, -1)
  assert.notEqual(hoverPreviewEnd, -1)

  const hoverPreviewSource = activityBarSource.slice(hoverPreviewStart, hoverPreviewEnd)

  assert.match(hoverPreviewSource, /width: workspaceSidebarPreviewWidth/)
  assert.match(hoverPreviewSource, /maxHeight: 'min\(420px, calc\(100vh - 96px\)\)'/)
  assert.doesNotMatch(hoverPreviewSource, /height: `calc\(100vh/)

  const sessionSidebarSource = activityBarSource.slice(hoverPreviewEnd)
  assert.match(sessionSidebarSource, /compactHoverPreview/)
})
