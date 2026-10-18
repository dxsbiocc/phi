import { navigationCopy } from '../../lib/navigationCopy'
import { useUiLanguage } from '../../lib/i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Dialog,
  Divider,
  InputAdornment,
  List,
  ListItemButton,
  TextField,
  Typography
} from '@mui/material'
import { GoSearch } from 'react-icons/go'
import type { Project, SessionSummary } from '../../types'
import { sessionTitle } from '../../lib/sessionSidebarShared'
import { loadProjectSessionsForSearch } from './lib/projectSessionSearch'
import { buildSessionSearchResults } from './lib/sessionSearchResults'

const MAX_RECENT_RESULTS = 12
const MAX_SEARCH_RESULTS = 50

type ProjectSessionSnapshot = {
  sessionsByProjectId: Record<string, SessionSummary[]>
  pending: number
  failed: number
}

type SessionSearchPanelProps = {
  onClose: () => void
  sessions: SessionSummary[]
  projects: Project[]
  onFetchProjectSessions: (
    workingDirectory: string,
    projectId?: string
  ) => Promise<SessionSummary[]>
  onSelectSession: (path: string) => Promise<void>
}

export function SessionSearchPanel({
  onClose,
  sessions,
  projects,
  onFetchProjectSessions,
  onSelectSession
}: SessionSearchPanelProps): React.JSX.Element {
  useUiLanguage()
  const [query, setQuery] = useState('')
  // No default selection: nothing is highlighted until the user arrows into
  // the list or hovers an entry. Enter only opens an explicit selection.
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [snapshot, setSnapshot] = useState<ProjectSessionSnapshot>({
    sessionsByProjectId: {},
    pending: projects.length,
    failed: 0
  })
  const [openingSession, setOpeningSession] = useState(false)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const resultListRef = useRef<HTMLUListElement | null>(null)

  useEffect(() => {
    let active = true
    void loadProjectSessionsForSearch(
      projects,
      onFetchProjectSessions,
      (projectId, result) => {
        setSnapshot((previous) => ({
          sessionsByProjectId:
            'sessions' in result
              ? { ...previous.sessionsByProjectId, [projectId]: result.sessions }
              : previous.sessionsByProjectId,
          pending: Math.max(0, previous.pending - 1),
          failed: previous.failed + ('failed' in result ? 1 : 0)
        }))
      },
      () => active
    )
    return () => {
      active = false
    }
  }, [projects, onFetchProjectSessions])

  const results = useMemo(
    () =>
      buildSessionSearchResults(
        sessions,
        projects,
        snapshot.sessionsByProjectId,
        query,
        query.trim() ? MAX_SEARCH_RESULTS : MAX_RECENT_RESULTS
      ),
    [sessions, projects, snapshot.sessionsByProjectId, query]
  )

  useEffect(() => {
    resultListRef.current
      ?.querySelector('[data-phi-search-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, results])

  const selectSession = async (path: string): Promise<void> => {
    if (openingSession) return
    setOpeningSession(true)
    setSelectionError(null)
    try {
      await onSelectSession(path)
      onClose()
    } catch (error) {
      setSelectionError(
        error instanceof Error ? error.message : navigationCopy.unableToOpenConversation
      )
    } finally {
      setOpeningSession(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      aria-label={navigationCopy.findConversations}
      fullWidth
      maxWidth="sm"
      data-phi-session-search-dialog="true"
      sx={{
        '& .MuiDialog-container': { alignItems: 'flex-start' },
        '& .MuiDialog-paper': {
          mt: 'min(10vh, 90px)',
          mx: 2,
          borderRadius: 3,
          overflow: 'hidden'
        }
      }}
    >
      <Box sx={{ px: 2.25, pt: 2, pb: 1.5 }}>
        <TextField
          autoFocus
          fullWidth
          variant="standard"
          placeholder={navigationCopy.searchConversations}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelectedIndex(-1)
            setSelectionError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setSelectedIndex((index) => {
                if (results.length === 0) return -1
                if (index < 0) return event.key === 'ArrowDown' ? 0 : results.length - 1
                return (
                  (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length
                )
              })
            } else if (
              event.key === 'Enter' &&
              selectedIndex >= 0 &&
              selectedIndex < results.length
            ) {
              event.preventDefault()
              void selectSession(results[selectedIndex].session.path)
            }
          }}
          slotProps={{
            htmlInput: { 'aria-label': navigationCopy.searchConversations },
            input: {
              disableUnderline: true,
              startAdornment: (
                <InputAdornment position="start">
                  <GoSearch size={20} />
                </InputAdornment>
              ),
              sx: { fontSize: '1.05rem' }
            }
          }}
        />
      </Box>
      <Divider />
      <Box sx={{ px: 1, py: 1, maxHeight: 'min(60vh, 520px)', overflowY: 'auto' }}>
        <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, fontWeight: 700 }}>
          {query.trim() ? navigationCopy.conversation : navigationCopy.recentConversations}
        </Typography>
        <List ref={resultListRef} dense disablePadding sx={{ mt: 0.5 }}>
          {results.map(({ session, projectName }, index) => (
            <ListItemButton
              key={session.path}
              selected={index === selectedIndex}
              data-phi-search-selected={index === selectedIndex ? 'true' : undefined}
              disabled={openingSession}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => void selectSession(session.path)}
              sx={{ borderRadius: 1.5, mx: 0.5, minHeight: 44, gap: 2 }}
            >
              <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: '0.9rem' }}>
                {sessionTitle(session)}
              </Typography>
              <Typography noWrap variant="caption" color="text.secondary" sx={{ maxWidth: 130 }}>
                {projectName ?? navigationCopy.ordinaryConversation}
              </Typography>
            </ListItemButton>
          ))}
        </List>
        {results.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 2 }}>
            {snapshot.pending > 0
              ? navigationCopy.findingProjectConversations
              : navigationCopy.noMatchingConversations}
          </Typography>
        )}
        {snapshot.pending > 0 && results.length > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, py: 1 }}>
            {navigationCopy.searchingOtherProjects}
          </Typography>
        )}
        {snapshot.failed > 0 && (
          <Typography variant="caption" color="warning.main" sx={{ px: 1.5, py: 1 }}>
            {navigationCopy.someProjectsAreTemporarilyUnavailable}
          </Typography>
        )}
        {selectionError && (
          <Typography variant="body2" color="error.main" sx={{ px: 1.5, py: 1 }}>
            {selectionError}
          </Typography>
        )}
      </Box>
    </Dialog>
  )
}
