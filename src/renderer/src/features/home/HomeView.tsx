import { useEffect, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'

import type { WrapperCompositionCatalogItem } from '../../../../shared/wrapperCompositionManifestTypes'
import type { WrapperRun } from '../../../../shared/wrapperTypes'
import { PhiIcons } from '../../icons'
import type { Project, SessionSummary } from '../../types'
import { HomeActivityHeatmap } from './components/HomeActivityHeatmap'
import { HomeOverviewCards } from './components/HomeOverviewCards'
import { HomePeriodSummary } from './components/HomePeriodSummary'
import { useHomeActivity } from './hooks/useHomeActivity'
import {
  rankHomeWrapperRuns,
  selectHomeRecentWork,
  type HomeRecentWorkItem,
  type HomeResourceCounts
} from './lib/homeOverview'

interface HomeViewProps {
  sessions: SessionSummary[]
  projects: Project[]
  projectSessionRefreshKey: number
  onFetchProjectSessions: (project: Project) => Promise<SessionSummary[]>
  resources: HomeResourceCounts
  wrapperRuns: WrapperRun[]
  wrapperCatalog: WrapperCompositionCatalogItem[]
  lastClosedSessionPath: string | null
  onLoadResources: () => void
  onNewChat: () => void
  onShowProjects: () => void
  onOpenSession: (path: string) => void
}

export function HomeView({
  sessions,
  projects,
  projectSessionRefreshKey,
  onFetchProjectSessions,
  resources,
  wrapperRuns,
  wrapperCatalog,
  lastClosedSessionPath,
  onLoadResources,
  onNewChat,
  onShowProjects,
  onOpenSession
}: HomeViewProps): React.JSX.Element {
  const projectScopeKey = `${projectSessionRefreshKey}|${projects.map((project) => project.id).join('|')}`
  const [projectResult, setProjectResult] = useState<{
    key: string
    work: HomeRecentWorkItem[]
    incomplete: boolean
  } | null>(null)
  const projectResultIsCurrent = projectResult?.key === projectScopeKey
  const projectWork = projectResultIsCurrent ? projectResult.work : []
  const projectConversationsLoading = projects.length > 0 && !projectResultIsCurrent
  const projectConversationsIncomplete = projectResultIsCurrent ? projectResult.incomplete : false

  useEffect(() => onLoadResources(), [onLoadResources])

  useEffect(() => {
    let active = true
    void Promise.allSettled(
      projects.map(async (project): Promise<HomeRecentWorkItem[]> => {
        const projectSessions = await onFetchProjectSessions(project)
        return projectSessions.map((session) => ({ session, project }))
      })
    ).then((results) => {
      if (!active) return
      setProjectResult({
        key: projectScopeKey,
        work: results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
        incomplete: results.some((result) => result.status === 'rejected')
      })
    })
    return () => {
      active = false
    }
  }, [onFetchProjectSessions, projectScopeKey, projects])

  const refreshKey = `${projectSessionRefreshKey}|${sessions
    .map(
      (session) =>
        `${session.phiSessionId ?? session.path}:${session.lastActivityAt ?? session.modified}`
    )
    .join('|')}`
  const activity = useHomeActivity(refreshKey)
  const recentWork = selectHomeRecentWork(sessions, projectWork, lastClosedSessionPath)
  const allSessions = [
    ...new Map(
      [...sessions, ...projectWork.map(({ session }) => session)].map((session) => [
        session.path,
        session
      ])
    ).values()
  ]
  const runningCount = allSessions.filter((session) => session.status === 'running').length
  const attentionCount = allSessions.filter(
    (session) =>
      session.status === 'needs_approval' ||
      session.status === 'needs_input' ||
      session.status === 'failed'
  ).length
  const wrapperRanking = rankHomeWrapperRuns(wrapperRuns, wrapperCatalog)

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
            <Typography id="home-heading" variant="h4" sx={{ letterSpacing: '-0.025em' }}>
              继续你的工作
            </Typography>
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

        <HomeOverviewCards
          projectCount={projects.length}
          ordinaryConversationCount={sessions.length}
          projectConversationCount={projectWork.length}
          projectConversationsLoading={projectConversationsLoading}
          projectConversationsIncomplete={projectConversationsIncomplete}
          runningCount={runningCount}
          attentionCount={attentionCount}
          recentWork={recentWork}
          resources={resources}
          wrapperRanking={wrapperRanking}
          wrapperRunCount={wrapperRuns.length}
          onOpenSession={onOpenSession}
        />
      </Box>
    </Box>
  )
}
