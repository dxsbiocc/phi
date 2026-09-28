import { Box, Button, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { PhiIcons } from '../../icons'
import { sessionDisplayTitle } from '../../lib/sessionTitles'
import type { SessionSummary } from '../../types'

interface HomeViewProps {
  sessions: SessionSummary[]
  lastClosedSessionPath: string | null
  onNewChat: () => void
  onShowProjects: () => void
  onOpenSession: (path: string) => void
}

export function HomeView({
  sessions,
  lastClosedSessionPath,
  onNewChat,
  onShowProjects,
  onOpenSession
}: HomeViewProps): React.JSX.Element {
  const recentSessions = sessions
    .filter((session) => session.messageCount > 0)
    .sort((a, b) => {
      if (a.path === lastClosedSessionPath) return -1
      if (b.path === lastClosedSessionPath) return 1
      return (b.lastActivityAt ?? b.modified).localeCompare(a.lastActivityAt ?? a.modified)
    })
    .slice(0, 4)

  return (
    <Box
      component="section"
      aria-label="首页"
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflowY: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        px: { xs: 3, md: 6 },
        py: 6
      }}
    >
      <Box sx={{ width: '100%', maxWidth: 760 }}>
        <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: '-0.02em' }}>
          从这里开始
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mt: 1, mb: 4 }}>
          继续最近的对话，或开启一项新任务。
        </Typography>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <Button
            onClick={onNewChat}
            sx={{
              flex: 1,
              minHeight: 112,
              p: 2.5,
              gap: 2,
              justifyContent: 'flex-start',
              textAlign: 'left',
              textTransform: 'none',
              border: 1,
              borderColor: (theme) => alpha(theme.palette.primary.main, 0.28),
              borderRadius: 3,
              bgcolor: (theme) => alpha(theme.palette.primary.main, 0.07),
              '&:hover': { bgcolor: (theme) => alpha(theme.palette.primary.main, 0.12) }
            }}
          >
            <PhiIcons.action.addSession sx={{ fontSize: 26, flexShrink: 0 }} />
            <Box>
              <Typography sx={{ fontWeight: 700, color: 'text.primary' }}>新建对话</Typography>
              <Typography variant="body2" color="text.secondary">
                从一个问题或任务开始
              </Typography>
            </Box>
          </Button>
          <Button
            onClick={onShowProjects}
            sx={{
              flex: 1,
              minHeight: 112,
              p: 2.5,
              gap: 2,
              justifyContent: 'flex-start',
              textAlign: 'left',
              textTransform: 'none',
              border: 1,
              borderColor: 'divider',
              borderRadius: 3,
              color: 'text.primary',
              '&:hover': { bgcolor: 'action.hover' }
            }}
          >
            <PhiIcons.nav.projects sx={{ fontSize: 26, flexShrink: 0 }} />
            <Box>
              <Typography sx={{ fontWeight: 700 }}>选择项目</Typography>
              <Typography variant="body2" color="text.secondary">
                在项目中继续工作
              </Typography>
            </Box>
          </Button>
        </Stack>

        {recentSessions.length > 0 ? (
          <Box sx={{ mt: 5 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1.5 }}>
              继续对话
            </Typography>
            <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 3, overflow: 'hidden' }}>
              {recentSessions.map((session) => (
                <Button
                  key={session.path}
                  onClick={() => onOpenSession(session.path)}
                  sx={{
                    width: '100%',
                    minHeight: 56,
                    px: 2.5,
                    display: 'flex',
                    justifyContent: 'flex-start',
                    gap: 1.5,
                    borderRadius: 0,
                    borderBottom: 1,
                    borderColor: 'divider',
                    color: 'text.primary',
                    textTransform: 'none',
                    '&:last-child': { borderBottom: 0 },
                    '&:hover': { bgcolor: 'action.hover' }
                  }}
                >
                  <PhiIcons.nav.chat
                    sx={{ fontSize: 18, color: 'text.secondary', flexShrink: 0 }}
                  />
                  <Typography noWrap sx={{ minWidth: 0, fontWeight: 500 }}>
                    {sessionDisplayTitle(session)}
                  </Typography>
                </Button>
              ))}
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}
