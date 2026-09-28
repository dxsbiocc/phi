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
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
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
      setSelectionError(error instanceof Error ? error.message : '无法打开会话')
    } finally {
      setOpeningSession(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      aria-label="查找会话"
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
          placeholder="搜索会话"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelectedIndex(0)
            setSelectionError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setSelectedIndex((index) =>
                results.length === 0
                  ? 0
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length
              )
            } else if (event.key === 'Enter' && results.length > 0) {
              event.preventDefault()
              void selectSession(results[Math.min(selectedIndex, results.length - 1)].session.path)
            }
          }}
          slotProps={{
            htmlInput: { 'aria-label': '搜索会话' },
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
          {query.trim() ? '会话' : '最近会话'}
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
                {projectName ?? '普通会话'}
              </Typography>
            </ListItemButton>
          ))}
        </List>
        {results.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 2 }}>
            {snapshot.pending > 0 ? '正在查找项目会话…' : '没有匹配的会话'}
          </Typography>
        )}
        {snapshot.pending > 0 && results.length > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, py: 1 }}>
            正在查找其他项目…
          </Typography>
        )}
        {snapshot.failed > 0 && (
          <Typography variant="caption" color="warning.main" sx={{ px: 1.5, py: 1 }}>
            部分项目暂时无法读取
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
