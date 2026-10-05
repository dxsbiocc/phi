import { memo, useCallback, useEffect, useRef, useState, type FocusEvent } from 'react'
import { Box, Fade, IconButton, Paper, Popper, Tooltip, useMediaQuery } from '@mui/material'
import type { SxProps, Theme } from '@mui/material/styles'
import type { IconType } from 'react-icons'
import {
  GoBook,
  GoComment,
  GoContainer,
  GoFileDirectory,
  GoGear,
  GoPackage,
  GoProject,
  GoWorkflow
} from 'react-icons/go'
import AppWorkspaceSidebar, { type WorkspaceSidebarDataProps } from './AppWorkspaceSidebar'
import { PhiIcons } from './icons'
import type { WorkspaceSidebarMode } from './lib/workspaceSidebar'

const activityBarWidth = 48
const macTitlebarHeight = 44
const macContentTopGap = 8
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
type PhiIconComponent = typeof PhiIcons.nav.settings
type ActivityBarIconFontSize = 'inherit' | 'small' | 'medium' | 'large'
type ActivityBarIconProps = {
  fontSize?: ActivityBarIconFontSize
  size?: number | string
}
type ActivityBarIconComponent = (props: ActivityBarIconProps) => React.JSX.Element
const activityBarIconBoxSize = 24
const activityBarPhiIconGlyphSize = 24
const activityBarReactIconGlyphSize = 20

function activityBarIconSize(
  fontSize?: ActivityBarIconFontSize,
  size?: number | string,
  defaultSize: number | string = activityBarPhiIconGlyphSize
): number | string {
  if (size !== undefined) return size
  if (fontSize === 'inherit') return '1em'
  if (fontSize === 'small') return defaultSize
  if (fontSize === 'large') return '2.1875rem'
  return defaultSize
}

function ActivityBarIconBox({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Box
      component="span"
      sx={{
        alignItems: 'center',
        display: 'inline-flex',
        flexShrink: 0,
        height: activityBarIconBoxSize,
        justifyContent: 'center',
        lineHeight: 0,
        width: activityBarIconBoxSize
      }}
    >
      {children}
    </Box>
  )
}

function createActivityBarPhiIcon(Icon: PhiIconComponent): ActivityBarIconComponent {
  return function ActivityBarPhiIcon({ fontSize, size }: ActivityBarIconProps): React.JSX.Element {
    return (
      <ActivityBarIconBox>
        <Icon size={activityBarIconSize(fontSize, size, activityBarPhiIconGlyphSize)} />
      </ActivityBarIconBox>
    )
  }
}

function createActivityBarReactIcon(Icon: IconType): ActivityBarIconComponent {
  return function ActivityBarReactIcon({
    fontSize,
    size
  }: ActivityBarIconProps): React.JSX.Element {
    return (
      <ActivityBarIconBox>
        <Icon
          aria-hidden
          focusable="false"
          size={activityBarIconSize(fontSize, size, activityBarReactIconGlyphSize)}
          style={{ display: 'block' }}
        />
      </ActivityBarIconBox>
    )
  }
}

function activityBarButtonSx(active: boolean): SxProps<Theme> {
  return {
    WebkitAppRegion: 'no-drag',
    color: active ? 'primary.main' : 'text.secondary',
    '&:hover': {
      color: active ? 'primary.main' : 'text.primary',
      bgcolor: 'action.hover'
    },
    '& svg': {
      color: 'inherit'
    }
  } as const
}

const NavChatIcon = createActivityBarReactIcon(GoComment)
const NavProjectsIcon = createActivityBarReactIcon(GoProject)
const NavFilesIcon = createActivityBarReactIcon(GoFileDirectory)
const NavRuntimeIcon = createActivityBarPhiIcon(PhiIcons.nav.runtime)
const NavPluginsIcon = createActivityBarReactIcon(GoPackage)
const NavSkillsIcon = createActivityBarReactIcon(GoBook)
const NavMcpIcon = createActivityBarReactIcon(GoWorkflow)
const NavWrappersIcon = createActivityBarReactIcon(GoContainer)
const NavSettingsIcon = createActivityBarReactIcon(GoGear)

function WorkspaceSidebarNavButton({
  mode,
  label,
  icon: Icon,
  active,
  useContentPreview,
  onPreviewOpen,
  onPreviewClose,
  onClick,
  previewOpen,
  onFocusPreview
}: {
  mode: WorkspaceSidebarMode
  label: string
  icon: typeof NavChatIcon
  active: boolean
  useContentPreview: boolean
  onPreviewOpen: (mode: WorkspaceSidebarMode, anchorEl: HTMLElement) => void
  onPreviewClose: () => void
  onClick: () => void
  previewOpen: boolean
  onFocusPreview: () => void
}): React.JSX.Element {
  const button = (
    <IconButton
      size="small"
      aria-label={label}
      aria-expanded={useContentPreview ? previewOpen : undefined}
      aria-controls={previewOpen ? 'workspace-sidebar-preview' : undefined}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowRight' || !useContentPreview) return
        event.preventDefault()
        onPreviewOpen(mode, event.currentTarget)
        onFocusPreview()
      }}
      color={active ? 'primary' : 'default'}
      sx={activityBarButtonSx(active)}
      onMouseEnter={(event) => {
        if (useContentPreview) onPreviewOpen(mode, event.currentTarget)
      }}
      onMouseLeave={useContentPreview ? onPreviewClose : undefined}
      onFocus={(event) => {
        if (useContentPreview) onPreviewOpen(mode, event.currentTarget)
      }}
      onBlur={useContentPreview ? onPreviewClose : undefined}
      onClick={onClick}
    >
      <Icon fontSize="small" />
    </IconButton>
  )

  return useContentPreview ? (
    button
  ) : (
    <Tooltip title={label} placement="right">
      {button}
    </Tooltip>
  )
}

export type AppActivityBarProps = {
  isWorkspaceSidebarModeExpanded: (mode: WorkspaceSidebarMode) => boolean
  shouldUseWorkspaceSidebarPreview: (mode: WorkspaceSidebarMode) => boolean
  openWorkspaceSidebarPreview: (mode: WorkspaceSidebarMode, anchorEl: HTMLElement) => void
  scheduleWorkspaceSidebarPreviewClose: () => void
  onSelectWorkspaceView: (view: 'chat' | 'projects') => void
  onSelectWorkspaceSidebarMode: (mode: WorkspaceSidebarMode) => void
  refreshAnalysisJupyterRuntimeStatus: () => Promise<void>
  refreshPhiPlugins: () => Promise<void>
  refreshSkills: () => Promise<void>
  refreshMcpServers: () => Promise<void>
  setIsSettingsOpen: (open: boolean) => void

  isWorkspaceSidebarPreviewOpen: boolean
  visibleWorkspaceSidebarPreview: {
    mode: WorkspaceSidebarMode
    anchorEl: HTMLElement
  } | null
  workspaceSidebarPreviewMode: WorkspaceSidebarMode
  workspaceSidebarPreviewWidth: number
  clearWorkspaceSidebarPreviewCloseTimer: () => void
  closeWorkspaceSidebarPreview: () => void

  sidebarProps: WorkspaceSidebarDataProps
  onPreviewNavigate: () => void
}

function AppActivityBarImpl({
  isWorkspaceSidebarModeExpanded,
  shouldUseWorkspaceSidebarPreview,
  openWorkspaceSidebarPreview,
  scheduleWorkspaceSidebarPreviewClose,
  onSelectWorkspaceView,
  onSelectWorkspaceSidebarMode,
  refreshAnalysisJupyterRuntimeStatus,
  refreshPhiPlugins,
  refreshSkills,
  refreshMcpServers,
  setIsSettingsOpen,
  isWorkspaceSidebarPreviewOpen,
  visibleWorkspaceSidebarPreview,
  workspaceSidebarPreviewMode,
  workspaceSidebarPreviewWidth,
  clearWorkspaceSidebarPreviewCloseTimer,
  closeWorkspaceSidebarPreview,
  sidebarProps,
  onPreviewNavigate
}: AppActivityBarProps): React.JSX.Element {
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [retainedPreview, setRetainedPreview] = useState(visibleWorkspaceSidebarPreview)
  if (
    visibleWorkspaceSidebarPreview &&
    (retainedPreview?.mode !== visibleWorkspaceSidebarPreview.mode ||
      retainedPreview?.anchorEl !== visibleWorkspaceSidebarPreview.anchorEl)
  ) {
    setRetainedPreview(visibleWorkspaceSidebarPreview)
  }
  const displayedPreview = visibleWorkspaceSidebarPreview ?? retainedPreview
  const displayedPreviewMode = displayedPreview?.mode ?? workspaceSidebarPreviewMode
  const previewInteractionLockedRef = useRef(false)
  const [previewInteractionLocked, setPreviewInteractionLocked] = useState(false)
  const previewSurfaceActiveRef = useRef(false)
  const previewPointerInsideRef = useRef(false)
  useEffect(() => {
    if (isWorkspaceSidebarPreviewOpen) return
    previewPointerInsideRef.current = false
    previewSurfaceActiveRef.current = false
  }, [isWorkspaceSidebarPreviewOpen])
  const requestWorkspaceSidebarPreviewClose = useCallback((): void => {
    if (previewInteractionLockedRef.current || previewSurfaceActiveRef.current) {
      clearWorkspaceSidebarPreviewCloseTimer()
      return
    }
    scheduleWorkspaceSidebarPreviewClose()
  }, [clearWorkspaceSidebarPreviewCloseTimer, scheduleWorkspaceSidebarPreviewClose])
  const handleWorkspaceSidebarPreviewInteractionChange = useCallback(
    (active: boolean): void => {
      previewInteractionLockedRef.current = active
      setPreviewInteractionLocked(active)
      if (active) {
        clearWorkspaceSidebarPreviewCloseTimer()
      } else if (!previewSurfaceActiveRef.current) {
        scheduleWorkspaceSidebarPreviewClose()
      }
    },
    [clearWorkspaceSidebarPreviewCloseTimer, scheduleWorkspaceSidebarPreviewClose]
  )
  const handleWorkspaceSidebarPreviewEnter = useCallback((): void => {
    previewPointerInsideRef.current = true
    previewSurfaceActiveRef.current = true
    clearWorkspaceSidebarPreviewCloseTimer()
    if (!isWorkspaceSidebarPreviewOpen && displayedPreview) {
      openWorkspaceSidebarPreview(displayedPreview.mode, displayedPreview.anchorEl)
    }
  }, [
    clearWorkspaceSidebarPreviewCloseTimer,
    displayedPreview,
    isWorkspaceSidebarPreviewOpen,
    openWorkspaceSidebarPreview
  ])
  const handleWorkspaceSidebarPreviewFocus = useCallback((): void => {
    previewSurfaceActiveRef.current = true
    clearWorkspaceSidebarPreviewCloseTimer()
  }, [clearWorkspaceSidebarPreviewCloseTimer])
  const handleWorkspaceSidebarPreviewLeave = useCallback((): void => {
    previewPointerInsideRef.current = false
    previewSurfaceActiveRef.current = false
    requestWorkspaceSidebarPreviewClose()
  }, [requestWorkspaceSidebarPreviewClose])
  const handleWorkspaceSidebarPreviewBlur = useCallback(
    (event: FocusEvent<HTMLElement>): void => {
      const nextFocusedElement = event.relatedTarget
      if (nextFocusedElement instanceof Node && event.currentTarget.contains(nextFocusedElement)) {
        return
      }
      previewSurfaceActiveRef.current = previewPointerInsideRef.current
      if (!previewSurfaceActiveRef.current) requestWorkspaceSidebarPreviewClose()
    },
    [requestWorkspaceSidebarPreviewClose]
  )
  const skipPreviewFocusRef = useRef(false)
  const refreshInFlightRef = useRef(new Set<WorkspaceSidebarMode>())
  const previewRefreshers: Partial<Record<WorkspaceSidebarMode, () => Promise<void>>> = {
    runtime: refreshAnalysisJupyterRuntimeStatus,
    plugins: refreshPhiPlugins,
    skills: refreshSkills,
    mcp: refreshMcpServers
  }
  const refreshForMode = (mode: WorkspaceSidebarMode): (() => Promise<void>) | undefined =>
    previewRefreshers[mode]
  const handlePreviewOpen = (mode: WorkspaceSidebarMode, anchorEl: HTMLElement): void => {
    if (skipPreviewFocusRef.current) return
    openWorkspaceSidebarPreview(mode, anchorEl)
    const refresh = refreshForMode(mode)
    if (!refresh || refreshInFlightRef.current.has(mode)) return
    refreshInFlightRef.current.add(mode)
    void refresh()
      .catch(() => undefined)
      .finally(() => refreshInFlightRef.current.delete(mode))
  }
  const focusPreview = (): void => {
    window.requestAnimationFrame(() => {
      const preview = document.getElementById('workspace-sidebar-preview')
      const first = preview?.querySelector<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), [tabindex="0"]'
      )
      const target = first ?? preview
      target?.focus()
    })
  }
  const navigationItems = [
    { mode: 'conversations', label: '对话', icon: NavChatIcon },
    { mode: 'projects', label: '项目', icon: NavProjectsIcon },
    { mode: 'files', label: '文件', icon: NavFilesIcon },
    { mode: 'runtime', label: '运行时', icon: NavRuntimeIcon },
    { mode: 'plugins', label: '插件', icon: NavPluginsIcon },
    { mode: 'skills', label: '技能', icon: NavSkillsIcon },
    { mode: 'mcp', label: '连接器', icon: NavMcpIcon },
    { mode: 'wrappers', label: 'Wrappers', icon: NavWrappersIcon }
  ] as const

  return (
    <>
      <Box
        className="app-activity-bar"
        sx={{
          width: activityBarWidth,
          height: '100vh',
          flexShrink: 0,
          position: 'relative',
          zIndex: 1,
          pt: isMac ? `${macTitlebarHeight + macContentTopGap}px` : 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 0.5,
          backgroundColor: (muiTheme) =>
            muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
          WebkitAppRegion: 'drag',
          '& > *': {
            position: 'relative',
            zIndex: 8
          }
        }}
      >
        {navigationItems.map(({ mode, label, icon }) => (
          <WorkspaceSidebarNavButton
            key={mode}
            mode={mode}
            label={label}
            icon={icon}
            active={isWorkspaceSidebarModeExpanded(mode)}
            useContentPreview={shouldUseWorkspaceSidebarPreview(mode)}
            previewOpen={isWorkspaceSidebarPreviewOpen && workspaceSidebarPreviewMode === mode}
            onPreviewOpen={handlePreviewOpen}
            onPreviewClose={requestWorkspaceSidebarPreviewClose}
            onFocusPreview={focusPreview}
            onClick={() => {
              closeWorkspaceSidebarPreview()
              if (mode === 'conversations' || mode === 'projects') {
                onSelectWorkspaceView(mode === 'conversations' ? 'chat' : 'projects')
              } else {
                onSelectWorkspaceSidebarMode(mode)
              }
              const refresh = refreshForMode(mode)
              if (refresh) void refresh().catch(() => undefined)
            }}
          />
        ))}
        <Box sx={{ flex: 1 }} />
        <IconButton
          size="small"
          aria-label="设置"
          sx={{ ...activityBarButtonSx(false), mb: 1 }}
          onClick={() => {
            closeWorkspaceSidebarPreview()
            setIsSettingsOpen(true)
          }}
        >
          <NavSettingsIcon fontSize="small" />
        </IconButton>
      </Box>

      <Popper
        open={isWorkspaceSidebarPreviewOpen}
        anchorEl={displayedPreview?.anchorEl ?? null}
        transition
        placement="right-start"
        modifiers={[
          {
            name: 'offset',
            options: { offset: [0, 6] }
          },
          {
            name: 'preventOverflow',
            options: { padding: 8 }
          }
        ]}
        sx={{
          zIndex: (muiTheme) =>
            previewInteractionLocked || !isWorkspaceSidebarPreviewOpen
              ? muiTheme.zIndex.modal - 1
              : muiTheme.zIndex.tooltip
        }}
      >
        {({ TransitionProps }) => (
          <Box
            data-phi-workspace-sidebar-preview-region
            onMouseEnter={handleWorkspaceSidebarPreviewEnter}
            onMouseLeave={handleWorkspaceSidebarPreviewLeave}
            onFocus={handleWorkspaceSidebarPreviewFocus}
            onBlur={handleWorkspaceSidebarPreviewBlur}
            sx={{
              position: 'relative',
              '&::before': {
                content: '""',
                position: 'absolute',
                left: -6,
                width: 6,
                top: 0,
                bottom: 0
              }
            }}
          >
            <Fade
              {...TransitionProps}
              timeout={reduceMotion ? 0 : { enter: 180, exit: 120 }}
              easing={{ enter: 'ease-out', exit: 'ease-in' }}
              onExited={() => {
                TransitionProps?.onExited?.()
                if (!isWorkspaceSidebarPreviewOpen) setRetainedPreview(null)
              }}
            >
              <Paper
                id="workspace-sidebar-preview"
                role="region"
                aria-label="导航内容预览"
                tabIndex={-1}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || !event.currentTarget.contains(event.target as Node))
                    return
                  event.preventDefault()
                  closeWorkspaceSidebarPreview()
                  const anchor = displayedPreview?.anchorEl
                  if (anchor?.isConnected && document.activeElement !== anchor) {
                    skipPreviewFocusRef.current = true
                    anchor.focus({ preventScroll: true })
                    skipPreviewFocusRef.current = false
                  }
                }}
                data-phi-workspace-sidebar-hover-preview={displayedPreviewMode}
                inert={!isWorkspaceSidebarPreviewOpen}
                aria-hidden={!isWorkspaceSidebarPreviewOpen || undefined}
                elevation={8}
                sx={{
                  width: workspaceSidebarPreviewWidth,
                  maxHeight: 'min(420px, calc(100vh - 96px))',
                  mt: isMac ? -0.5 : 0.5,
                  overflow: 'hidden',
                  borderRadius: 2,
                  border: 1,
                  borderColor: 'divider',
                  bgcolor: 'background.default',
                  boxShadow: (muiTheme) =>
                    muiTheme.palette.mode === 'dark'
                      ? '0 18px 46px rgba(0, 0, 0, 0.48)'
                      : '0 18px 46px rgba(12, 26, 32, 0.18)'
                }}
              >
                <AppWorkspaceSidebar
                  key={displayedPreviewMode}
                  {...sidebarProps}
                  isSidebarOpen
                  sidebarWidth={workspaceSidebarPreviewWidth}
                  activeView="chat"
                  activeChatView={null}
                  onStartSidebarResize={() => undefined}
                  workspaceSidebarMode={displayedPreviewMode}
                  compactHoverPreview
                  onPreviewInteractionChange={handleWorkspaceSidebarPreviewInteractionChange}
                  onPreviewNavigate={onPreviewNavigate}
                />
              </Paper>
            </Fade>
          </Box>
        )}
      </Popper>
    </>
  )
}

// Same rationale as AppWorkspaceSidebar's comparator: App() re-renders on
// every agent-stream event, but this bar's own visible state only depends on
// these fields and App's memoized shared sidebar data. Stream-only changes
// do not rebuild resource previews; refreshed resource arrays do.
function appActivityBarPropsEqual(prev: AppActivityBarProps, next: AppActivityBarProps): boolean {
  return (
    prev.isWorkspaceSidebarModeExpanded === next.isWorkspaceSidebarModeExpanded &&
    prev.shouldUseWorkspaceSidebarPreview === next.shouldUseWorkspaceSidebarPreview &&
    prev.isWorkspaceSidebarPreviewOpen === next.isWorkspaceSidebarPreviewOpen &&
    prev.visibleWorkspaceSidebarPreview?.mode === next.visibleWorkspaceSidebarPreview?.mode &&
    prev.visibleWorkspaceSidebarPreview?.anchorEl ===
      next.visibleWorkspaceSidebarPreview?.anchorEl &&
    prev.workspaceSidebarPreviewMode === next.workspaceSidebarPreviewMode &&
    prev.workspaceSidebarPreviewWidth === next.workspaceSidebarPreviewWidth &&
    prev.sidebarProps === next.sidebarProps &&
    prev.onPreviewNavigate === next.onPreviewNavigate
  )
}

const AppActivityBar = memo(AppActivityBarImpl, appActivityBarPropsEqual)

export default AppActivityBar
