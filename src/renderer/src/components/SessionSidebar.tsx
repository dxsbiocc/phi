import { useEffect, useState } from 'react'
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Box, Button, List, Stack } from '@mui/material'
import { PhiIcons } from '../icons'
import { resolveProjectExpandedIds } from '../lib/projectSidebar'
import { ProjectRow } from './session-sidebar/ProjectRow'
import { SessionDeleteDialogs } from './session-sidebar/SessionDeleteDialogs'
import { SortableSessionRow } from './session-sidebar/SessionRow'
import { ROW_LABEL_FONT_SIZE, sessionTitle, useSessionOrder } from '../lib/sessionSidebarShared'
import type { Project, SessionRuntimeState, SessionSummary } from '../types'

const AddIcon = PhiIcons.action.add
const AddCommentIcon = PhiIcons.action.addSession
const CONTENT_TOP_GAP = 1
const HOVER_PREVIEW_MAX_HEIGHT = 'min(420px, calc(100vh - 96px))'
const HOVER_PREVIEW_LIST_MAX_HEIGHT = 'min(320px, calc(100vh - 176px))'
const CONVERSATION_SESSION_ORDER_SCOPE = 'conversation'

// macOS's traffic-light window controls float over the top-left of the window
// (see the frameless BrowserWindow setup in main/index.ts) — reserve room so
// nothing sits under them, and make this strip draggable.
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'

type SessionSidebarProps = {
  mode: 'conversations' | 'projects'
  hideWindowDragSpacer?: boolean
  compactHoverPreview?: boolean
  onPreviewInteractionChange?: (active: boolean) => void
  sessions: SessionSummary[]
  activeSessionPath: string | null
  activeCwd: string
  activeProjectId?: string | null
  projects: Project[]
  projectSessionRefreshKey: number
  onNewChat: () => void
  onNewProject: () => void
  onSelectSession: (path: string) => void
  onRenameSession: (path: string, name: string) => void
  onDeleteSession: (path: string) => void
  onStartProjectChat: (project: Project) => void
  onDeleteProject: (project: Project) => void
  onFetchProjectSessions: (
    workingDirectory: string,
    projectId?: string
  ) => Promise<SessionSummary[]>
  getSessionRuntimeState?: (
    path: string,
    cwd: string,
    phiSessionId?: string | null
  ) => SessionRuntimeState | null
}

function SessionSidebar({
  mode,
  hideWindowDragSpacer = false,
  compactHoverPreview = false,
  onPreviewInteractionChange,
  sessions,
  activeSessionPath,
  activeCwd,
  activeProjectId = null,
  projects,
  projectSessionRefreshKey,
  onNewChat,
  onNewProject,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onStartProjectChat,
  onDeleteProject,
  onFetchProjectSessions,
  getSessionRuntimeState
}: SessionSidebarProps): React.JSX.Element {
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null)
  const [projectExpansionOverrides, setProjectExpansionOverrides] = useState<
    Record<string, boolean | undefined>
  >({})
  const expandedProjectIds = resolveProjectExpandedIds(
    projectExpansionOverrides,
    mode,
    projects,
    activeCwd,
    activeProjectId
  )
  const [nowMs, setNowMs] = useState(() => Date.now())
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const { orderedSessions, handleDragEnd } = useSessionOrder(
    CONVERSATION_SESSION_ORDER_SCOPE,
    sessions
  )
  const previewDialogOpen =
    compactHoverPreview && (deleteTarget !== null || deleteProjectTarget !== null)

  useEffect(() => {
    if (!previewDialogOpen) return undefined
    onPreviewInteractionChange?.(true)
    return () => onPreviewInteractionChange?.(false)
  }, [onPreviewInteractionChange, previewDialogOpen])

  // Only covers the top-level `sessions` list (conversations mode) — project
  // sessions live in each ProjectRow's own fetched state and tick their own
  // clock independently (see ProjectRowImpl), so this no longer needs to
  // (and shouldn't) special-case 'projects' mode: doing so used to force a
  // 1s re-render of the whole sidebar the entire time the Projects tab was
  // open, regardless of whether anything was actually running.
  const hasActiveAttention = sessions.some((session) => {
    const runtimeState = getSessionRuntimeState?.(session.path, activeCwd) ?? null
    const status = runtimeState?.status ?? session.status
    return status === 'running' || status === 'needs_approval' || status === 'needs_input'
  })

  useEffect(() => {
    if (!hasActiveAttention) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasActiveAttention])

  const toggleProjectExpanded = (id: string): void => {
    const isExpanded = expandedProjectIds.has(id)
    setProjectExpansionOverrides((prev) => ({ ...prev, [id]: !isExpanded }))
  }

  const isProjectsMode = mode === 'projects'
  const isConversationsMode = mode === 'conversations'

  return (
    <Box
      className="app-sidebar-surface"
      data-phi-session-sidebar-variant={compactHoverPreview ? 'hover-preview' : 'sidebar'}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        minWidth: 0,
        height: compactHoverPreview ? 'auto' : '100%',
        maxHeight: compactHoverPreview ? HOVER_PREVIEW_MAX_HEIGHT : undefined,
        backgroundColor: 'background.default'
      }}
    >
      {!hideWindowDragSpacer ? (
        // No label here by design — this strip exists only so macOS's traffic
        // lights have room, and so the window has something to drag by.
        <Box
          sx={{
            flexShrink: 0,
            minHeight: 44,
            pl: isMac ? '80px' : '16px',
            WebkitAppRegion: 'drag'
          }}
        />
      ) : null}

      <Stack
        spacing={1}
        sx={{
          px: compactHoverPreview ? 1 : 1.5,
          pt: compactHoverPreview ? 1 : CONTENT_TOP_GAP,
          pb: compactHoverPreview ? 0.75 : 1,
          flexShrink: 0,
          backgroundColor: 'transparent !important',
          WebkitAppRegion: compactHoverPreview ? 'no-drag' : 'drag'
        }}
      >
        {isProjectsMode ? (
          <Button
            fullWidth
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={onNewProject}
            sx={{
              minHeight: compactHoverPreview ? 38 : 44,
              justifyContent: 'flex-start',
              fontSize: ROW_LABEL_FONT_SIZE,
              WebkitAppRegion: 'no-drag'
            }}
          >
            新建项目
          </Button>
        ) : (
          <Button
            fullWidth
            variant="outlined"
            startIcon={<AddCommentIcon />}
            onClick={onNewChat}
            sx={{
              minHeight: compactHoverPreview ? 38 : 44,
              justifyContent: 'flex-start',
              fontSize: ROW_LABEL_FONT_SIZE,
              WebkitAppRegion: 'no-drag'
            }}
          >
            新对话
          </Button>
        )}
      </Stack>

      <List
        sx={{
          flex: compactHoverPreview ? '0 1 auto' : 1,
          minHeight: 0,
          maxHeight: compactHoverPreview ? HOVER_PREVIEW_LIST_MAX_HEIGHT : undefined,
          overflowY: 'auto',
          px: 0.5,
          pb: compactHoverPreview ? 0.5 : undefined,
          backgroundColor: 'transparent !important'
        }}
        disablePadding
      >
        {isProjectsMode &&
          projects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              expanded={expandedProjectIds.has(project.id)}
              refreshKey={projectSessionRefreshKey}
              onToggleExpanded={() => toggleProjectExpanded(project.id)}
              activeSessionPath={activeSessionPath}
              onStartChat={() => onStartProjectChat(project)}
              onSelectSession={onSelectSession}
              onRenameSession={onRenameSession}
              onDeleteSession={onDeleteSession}
              onDeleteProject={() => setDeleteProjectTarget(project)}
              onFetchSessions={onFetchProjectSessions}
              getSessionRuntimeState={getSessionRuntimeState}
              compactHoverPreview={compactHoverPreview}
              onPreviewInteractionChange={onPreviewInteractionChange}
            />
          ))}

        {isConversationsMode && sessions.length > 0 && (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={orderedSessions.map((session) => session.path)}
              strategy={verticalListSortingStrategy}
            >
              {orderedSessions.map((session) => (
                <SortableSessionRow
                  key={session.path}
                  session={session}
                  runtimeState={getSessionRuntimeState?.(session.path, activeCwd) ?? null}
                  isActive={session.path === activeSessionPath}
                  nowMs={nowMs}
                  onSelect={() => onSelectSession(session.path)}
                  onRename={(name) => onRenameSession(session.path, name)}
                  onDelete={() => setDeleteTarget(session)}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </List>

      <SessionDeleteDialogs
        deleteSessionOpen={deleteTarget !== null}
        deleteSessionTitle={deleteTarget ? sessionTitle(deleteTarget) : ''}
        deleteProjectOpen={deleteProjectTarget !== null}
        deleteProjectName={deleteProjectTarget?.name ?? ''}
        compactHoverPreview={compactHoverPreview}
        onCancelSessionDelete={() => setDeleteTarget(null)}
        onConfirmSessionDelete={() => {
          if (deleteTarget) onDeleteSession(deleteTarget.path)
          setDeleteTarget(null)
        }}
        onCancelProjectDelete={() => setDeleteProjectTarget(null)}
        onConfirmProjectDelete={() => {
          if (deleteProjectTarget) onDeleteProject(deleteProjectTarget)
          setDeleteProjectTarget(null)
        }}
      />
    </Box>
  )
}

export default SessionSidebar
