import { Box, Button, Chip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'

import { PhiIcons } from '../../icons'
import { sessionDisplayTitle } from '../../lib/sessionTitles'
import type { SessionStatus, SessionSummary } from '../../types'
import { HomeActivityHeatmap } from './components/HomeActivityHeatmap'
import { HomePeriodSummary } from './components/HomePeriodSummary'
import { useHomeActivity } from './hooks/useHomeActivity'
import { formatSessionActivity } from './lib/homeActivity'

interface HomeViewProps {
  sessions: SessionSummary[]
  lastClosedSessionPath: string | null
  onNewChat: () => void
  onShowProjects: () => void
  onOpenSession: (path: string) => void
}

const statusPresentation: Record<
  SessionStatus,
  { label: string; color: 'default' | 'success' | 'warning' | 'error' | 'info' }
> = {
  idle: { label: '可继续', color: 'default' },
  running: { label: '进行中', color: 'info' },
  needs_approval: { label: '等待批准', color: 'warning' },
  needs_input: { label: '等待回复', color: 'warning' },
  failed: { label: '需处理', color: 'error' },
  completed_unread: { label: '已完成', color: 'success' }
}

function recentSessionStatus(session: SessionSummary): {
  label: string
  color: 'default' | 'success' | 'warning' | 'error' | 'info'
} {
  if (session.status === 'idle' && session.lastRunOutcome === 'completed') {
    return { label: '已完成', color: 'success' }
  }
  return statusPresentation[session.status]
}

export function HomeView({
  sessions,
  lastClosedSessionPath,
  onNewChat,
  onShowProjects,
  onOpenSession
}: HomeViewProps): React.JSX.Element {
  const refreshKey = sessions
    .map(
      (session) =>
        `${session.phiSessionId ?? session.path}:${session.lastActivityAt ?? session.modified}`
    )
    .join('|')
  const activity = useHomeActivity(refreshKey)
  const recentSessions = sessions
    .filter((session) => session.messageCount > 0)
    .sort((a, b) => {
      if (a.path === lastClosedSessionPath) return -1
      if (b.path === lastClosedSessionPath) return 1
      return (b.lastActivityAt ?? b.modified).localeCompare(a.lastActivityAt ?? a.modified)
    })
    .slice(0, 4)
  const runningCount = sessions.filter((session) => session.status === 'running').length
  const attentionCount = sessions.filter(
    (session) =>
      session.status === 'needs_approval' ||
      session.status === 'needs_input' ||
      session.status === 'failed'
  ).length

  return (
    <Box
      component="section"
      aria-labelledby="home-heading"
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflowY: 'auto',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark'
            ? alpha(theme.palette.background.default, 0.96)
            : alpha(theme.palette.primary.main, 0.018),
        px: { xs: 2, sm: 3, lg: 4 },
        py: { xs: 2.5, sm: 3.5 }
      }}
    >
      <Box sx={{ width: '100%', maxWidth: 1180, mx: 'auto' }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: { xs: 'stretch', sm: 'flex-end' },
            justifyContent: 'space-between',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 2.5,
            mb: 3
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography
              variant="overline"
              color="primary.main"
              sx={{ display: 'block', mb: 0.5, letterSpacing: '0.12em' }}
            >
              工作总览
            </Typography>
            <Typography id="home-heading" variant="h4" sx={{ letterSpacing: '-0.025em' }}>
              把每一次完成，连成可见的进展
            </Typography>
            <Box sx={{ mt: 0.75, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
              <Typography variant="body2" color="text.secondary">
                回顾节奏，继续最近的任务。
              </Typography>
              {runningCount > 0 ? (
                <Chip size="small" color="info" variant="soft" label={`${runningCount} 项运行中`} />
              ) : null}
              {attentionCount > 0 ? (
                <Chip
                  size="small"
                  color="warning"
                  variant="soft"
                  label={`${attentionCount} 项需要关注`}
                />
              ) : null}
            </Box>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Button
              variant="outlined"
              color="inherit"
              onClick={onShowProjects}
              startIcon={<PhiIcons.nav.projects sx={{ fontSize: 18 }} />}
              sx={{ minHeight: 44 }}
            >
              选择项目
            </Button>
            <Button
              variant="contained"
              color="primary"
              onClick={onNewChat}
              startIcon={<PhiIcons.action.addSession sx={{ fontSize: 18 }} />}
              sx={{ minHeight: 44 }}
            >
              新建对话
            </Button>
          </Box>
        </Box>

        {activity.error ? (
          <Box
            role="alert"
            sx={{
              mb: 2,
              px: 1.5,
              py: 1,
              borderRadius: 2,
              bgcolor: (theme) => alpha(theme.palette.warning.main, 0.1),
              color: 'warning.dark'
            }}
          >
            <Typography variant="body2">活动数据暂时不可用：{activity.error}</Typography>
          </Box>
        ) : null}

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.75fr) minmax(290px, 0.85fr)' },
            gap: 2
          }}
        >
          <HomeActivityHeatmap activity={activity.data} loading={activity.loading} />
          <HomePeriodSummary activity={activity.data} loading={activity.loading} />
        </Box>

        <Box
          sx={{
            mt: 2,
            border: 1,
            borderColor: 'divider',
            borderRadius: 3,
            bgcolor: 'background.paper',
            overflow: 'hidden'
          }}
        >
          <Box
            sx={{
              px: { xs: 2, md: 2.5 },
              py: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 2,
              borderBottom: recentSessions.length > 0 ? 1 : 0,
              borderColor: 'divider'
            }}
          >
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                继续最近的任务
              </Typography>
              <Typography variant="body2" color="text.secondary">
                保留上下文，从上次停下的位置继续。
              </Typography>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
              最近 {recentSessions.length} 项
            </Typography>
          </Box>

          {recentSessions.length > 0 ? (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }
              }}
            >
              {recentSessions.map((session, index) => {
                const status = recentSessionStatus(session)
                const isOddFinal =
                  recentSessions.length % 2 === 1 && index === recentSessions.length - 1
                const hasFollowingDesktopRow =
                  index < recentSessions.length - (recentSessions.length % 2 === 0 ? 2 : 1)
                return (
                  <Button
                    key={session.path}
                    onClick={() => onOpenSession(session.path)}
                    sx={{
                      minWidth: 0,
                      minHeight: 88,
                      px: { xs: 2, md: 2.5 },
                      py: 1.75,
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'flex-start',
                      gap: 1.5,
                      gridColumn: { md: isOddFinal ? '1 / -1' : 'auto' },
                      borderRadius: 0,
                      borderBottom: {
                        xs: index < recentSessions.length - 1 ? 1 : 0,
                        md: hasFollowingDesktopRow ? 1 : 0
                      },
                      borderRight: { md: index % 2 === 0 && !isOddFinal ? '1px solid' : 0 },
                      borderRightColor: {
                        md: index % 2 === 0 && !isOddFinal ? 'divider' : 'transparent'
                      },
                      borderColor: 'divider',
                      color: 'text.primary',
                      textAlign: 'left',
                      textTransform: 'none',
                      '&:hover, &.Mui-focusVisible': {
                        bgcolor: (theme) => alpha(theme.palette.primary.main, 0.055),
                        '& .home-session-arrow': {
                          transform: 'translateX(2px)',
                          color: 'primary.main'
                        }
                      }
                    }}
                  >
                    <Box
                      sx={{
                        width: 36,
                        height: 36,
                        flexShrink: 0,
                        display: 'grid',
                        placeItems: 'center',
                        borderRadius: 2,
                        bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1),
                        color: 'primary.main'
                      }}
                    >
                      <PhiIcons.nav.chat sx={{ fontSize: 18 }} />
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography noWrap sx={{ minWidth: 0, flex: 1, fontWeight: 700 }}>
                          {sessionDisplayTitle(session)}
                        </Typography>
                        <Chip
                          size="small"
                          color={status.color}
                          variant="soft"
                          label={status.label}
                        />
                      </Box>
                      <Typography variant="caption" color="text.secondary">
                        {formatSessionActivity(session)} · {session.messageCount} 条消息
                      </Typography>
                    </Box>
                    <PhiIcons.action.back
                      className="home-session-arrow"
                      sx={{
                        mt: 1,
                        fontSize: 17,
                        color: 'text.secondary',
                        transition: (theme) =>
                          theme.transitions.create(['transform', 'color'], {
                            duration: theme.transitions.duration.shorter
                          }),
                        '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
                      }}
                    />
                  </Button>
                )
              })}
            </Box>
          ) : (
            <Box sx={{ px: 2.5, py: 4, textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                完成第一项任务后，这里会开始记录你的工作节奏。
              </Typography>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  )
}
