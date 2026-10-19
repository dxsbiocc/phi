import { Box, Typography } from '@mui/material'
import type { ReactNode } from 'react'

import {
  WorkspaceFileHeader,
  WorkspaceResourceHeader
} from '../../components/app-shell/WorkspaceTitlebar'
import { WINDOW_TITLEBAR_HEIGHT, type WindowChromeLayout } from '../../lib/windowChromeLayout'
import type { WorkspaceSessionTab, WorkspaceTab } from '../../lib/workspaceResourceTabs'
import type { WorkspaceFileTab } from '../../useWorkspaceFileTabs'

/**
 * The workspace surface: the main column beside the navigation sidebar.
 *
 * It owns *where* things go — the blank titlebar strip, the tab strip above
 * the content, and which of the content slots fills the column — and nothing
 * about *what* those things are. Every piece of content is passed in already
 * built, so this module never reaches into session, file or notebook state.
 *
 * It also owns the empty `<main>` fallback used outside any workspace view,
 * because that is layout, not content.
 */

/** Which content slot fills the column. Decided by the caller, rendered here. */
export type WorkspaceViewMode = 'tabs' | 'file-preview' | 'analysis' | 'chat-empty' | 'chat'

export type WorkspaceResourceStrip = {
  tabs: WorkspaceTab[]
  activeKey: string | null
  onSelect: (tab: WorkspaceTab) => void
  onClose: (tab: WorkspaceTab) => void
  onDockSessionTab?: (tab: WorkspaceSessionTab) => void
}

export type WorkspaceFileStrip = {
  tabs: WorkspaceFileTab[]
  activePath: string | null
  onSelect: (tab: WorkspaceFileTab) => void
  onClose: (tab: WorkspaceFileTab) => void
}

export type WorkspaceViewContent = {
  /** Content of the selected workspace tab (chat, notebook, file or resource). */
  tabs: ReactNode
  /** Rendered file preview panel for the analysis file layout. */
  filePreview: ReactNode
  /** Rendered analysis view (notebook canvas). */
  analysis: ReactNode
  /** Conversation view. */
  chat: ReactNode
  /** Placement screen shown when no conversation is selected. */
  empty: ReactNode
}

function WorkspaceTitlebarStrip({
  chromeLayout,
  workspaceTitle,
  hideTitle,
  titlebarTrailing
}: {
  chromeLayout: WindowChromeLayout
  workspaceTitle: string
  hideTitle: boolean
  titlebarTrailing: ReactNode
}): React.JSX.Element {
  return (
    <Box
      data-phi-workspace-titlebar="true"
      sx={{
        height: WINDOW_TITLEBAR_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        backgroundColor: (muiTheme) =>
          muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
        WebkitAppRegion: 'drag',
        zIndex: 7,
        pl: `${chromeLayout.mainColumnTitlebarInset}px`
      }}
    >
      <Box
        sx={{
          flex: titlebarTrailing ? '1 1 320px' : 1,
          minWidth: 0,
          height: '100%',
          display: 'flex',
          alignItems: 'center'
        }}
      >
        <Box sx={{ width: '100%', maxWidth: 860, mx: 'auto', px: 3, minWidth: 0 }}>
          {hideTitle ? null : (
            <Typography
              variant="subtitle2"
              title={workspaceTitle}
              sx={{
                maxWidth: { xs: 220, sm: 360, md: 520 },
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: 600
              }}
            >
              {workspaceTitle}
            </Typography>
          )}
        </Box>
      </Box>
      {titlebarTrailing}
    </Box>
  )
}

function WorkspaceColumnBody({
  mode,
  chromeLayout,
  sidePanelCollapsed,
  resourceStrip,
  fileStrip,
  content
}: {
  mode: WorkspaceViewMode
  chromeLayout: WindowChromeLayout
  sidePanelCollapsed: boolean
  resourceStrip: WorkspaceResourceStrip
  fileStrip: WorkspaceFileStrip
  content: WorkspaceViewContent
}): React.JSX.Element {
  if (mode === 'analysis') return <>{content.analysis}</>
  if (mode === 'chat-empty') return <>{content.empty}</>
  if (mode === 'chat') return <>{content.chat}</>
  return mode === 'tabs' ? (
    <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <WorkspaceResourceHeader
        tabs={resourceStrip.tabs}
        activeKey={resourceStrip.activeKey}
        onSelect={resourceStrip.onSelect}
        onClose={resourceStrip.onClose}
        onDockSessionTab={resourceStrip.onDockSessionTab}
        leadingChromeInset={chromeLayout.mainColumnTitlebarInset}
        reserveTrailingChromeSpace={sidePanelCollapsed}
      />
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
      >
        {content.tabs}
      </Box>
    </Box>
  ) : (
    <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <WorkspaceFileHeader
        tabs={fileStrip.tabs}
        activePath={fileStrip.activePath}
        onSelect={fileStrip.onSelect}
        onClose={fileStrip.onClose}
        leadingChromeInset={chromeLayout.mainColumnTitlebarInset}
        reserveTrailingChromeSpace={sidePanelCollapsed}
      />
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>{content.filePreview}</Box>
    </Box>
  )
}

export function WorkspaceView({
  active,
  chromeLayout,
  mode,
  workspaceTitle,
  showTitlebar,
  hideTitle,
  titlebarTrailing,
  sidePanelCollapsed,
  resourceStrip,
  fileStrip,
  content
}: {
  /** False outside any workspace view, where the column is an empty placeholder. */
  active: boolean
  chromeLayout: WindowChromeLayout
  mode: WorkspaceViewMode
  workspaceTitle: string
  showTitlebar: boolean
  /** Hide the title while the home/placement surface owns the column. */
  hideTitle: boolean
  /** Optional trailing titlebar content, e.g. the open file's title tab. */
  titlebarTrailing: ReactNode
  /** When the side panel is closed the tabs must keep clear of the chrome toggles. */
  sidePanelCollapsed: boolean
  resourceStrip: WorkspaceResourceStrip
  fileStrip: WorkspaceFileStrip
  content: WorkspaceViewContent
}): React.JSX.Element {
  if (!active) return <Box component="main" sx={{ flex: 1, minWidth: 0, height: '100vh' }} />

  return (
    <Box
      component="main"
      sx={{
        flex: 1,
        minWidth: 0,
        height: '100vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {showTitlebar ? (
        <WorkspaceTitlebarStrip
          chromeLayout={chromeLayout}
          workspaceTitle={workspaceTitle}
          hideTitle={hideTitle}
          titlebarTrailing={titlebarTrailing}
        />
      ) : null}
      <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', overflow: 'hidden' }}>
        <WorkspaceColumnBody
          mode={mode}
          chromeLayout={chromeLayout}
          sidePanelCollapsed={sidePanelCollapsed}
          resourceStrip={resourceStrip}
          fileStrip={fileStrip}
          content={content}
        />
      </Box>
    </Box>
  )
}
