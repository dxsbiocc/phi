import { homeCopy } from './lib/homeCopy'
import { useUiLanguage } from '../../lib/i18n'
import { useEffect, useState } from 'react'
import { Box, Typography, useMediaQuery } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'

import type { WrapperCompositionCatalogItem } from '../../../../shared/wrapperCompositionManifestTypes'
import type { WrapperRun } from '../../../../shared/wrapperTypes'
import type { ModelOption, Project, SessionSummary, ThinkingLevel } from '../../types'
import { HomeCarouselSection, HomeCompanionRow } from './components/HomeLowerLayout'
import type { HomeOverviewCardsProps } from './components/HomeOverviewCards'
import GlowCursor from './components/GlowCursor'
import { HOME_COLUMN_MAX_WIDTH } from './lib/homeColumn'
import {
  HomePrompt,
  type HomeComposerResources,
  type HomePromptRequest
} from './components/HomePrompt'
import { useHomeActivity } from './hooks/useHomeActivity'
import type { HomeProjectSelection } from './hooks/useHomePrompt'
import {
  rankHomeWrapperRuns,
  selectHomeRecentWork,
  type HomeRecentWorkItem,
  type HomeResourceCounts
} from './lib/homeOverview'

interface HomeViewProps {
  sessions: SessionSummary[]
  sessionsLoading: boolean
  projects: Project[]
  projectSessionRefreshKey: number
  onFetchProjectSessions: (project: Project) => Promise<SessionSummary[]>
  resources: HomeResourceCounts
  wrapperRuns: WrapperRun[]
  wrapperCatalog: WrapperCompositionCatalogItem[]
  lastClosedSessionPath: string | null
  onLoadResources: () => Promise<void>
  models: ModelOption[]
  selectedModel: ModelOption | null
  thinkingLevel: ThinkingLevel
  busy: boolean
  onSelectModel: (model: ModelOption | null) => void
  onSelectThinkingLevel: (level: ThinkingLevel) => void
  projectSelection: HomeProjectSelection | null
  onNewProject: () => void
  onOpenSession: (path: string) => void
  onStartPrompt: (request: HomePromptRequest) => Promise<void>
  composerResources?: HomeComposerResources
}

export function HomeView({
  sessions,
  sessionsLoading,
  projects,
  projectSessionRefreshKey,
  onFetchProjectSessions,
  resources,
  wrapperRuns,
  wrapperCatalog,
  lastClosedSessionPath,
  onLoadResources,
  models,
  selectedModel,
  thinkingLevel,
  busy,
  onSelectModel,
  onSelectThinkingLevel,
  projectSelection,
  onNewProject,
  onOpenSession,
  onStartPrompt,
  composerResources
}: HomeViewProps): React.JSX.Element {
  useUiLanguage()
  const muiTheme = useTheme()
  const darkTheme = muiTheme.palette.mode === 'dark'
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
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

  const [resourcesLoaded, setResourcesLoaded] = useState(false)
  useEffect(() => {
    let active = true
    const finish = (): void => {
      if (active) setResourcesLoaded(true)
    }
    void onLoadResources().then(finish, finish)
    return () => {
      active = false
    }
  }, [onLoadResources])

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
  const homeOverview: HomeOverviewCardsProps = {
    projectCount: projects.length,
    sessionsLoading,
    ordinaryConversationCount: sessions.length,
    projectConversationCount: projectWork.length,
    projectConversationsLoading,
    projectConversationsIncomplete,
    runningCount,
    attentionCount,
    recentWork,
    resources,
    resourcesLoading: !resourcesLoaded,
    wrapperRanking,
    wrapperRunCount: wrapperRuns.length,
    onOpenSession
  }

  return (
    <Box
      component="section"
      aria-labelledby="home-heading"
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
        overflow: 'hidden',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark'
            ? alpha(theme.palette.background.default, 0.96)
            : alpha(theme.palette.primary.main, 0.018)
      }}
    >
      {prefersReducedMotion ? null : (
        <GlowCursor
          data-phi-home-glow="true"
          color={muiTheme.palette.primary.main}
          secondaryColor={muiTheme.palette.primary.light}
          intensity={darkTheme ? 1.1 : 1.05}
          trailWidth={3}
          linger={1.4}
          glow={darkTheme ? 1 : 0.9}
          clickBurst
          theme={muiTheme.palette.mode}
          blendMode={darkTheme ? 'screen' : 'normal'}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 0,
            pointerEvents: 'none',
            opacity: darkTheme ? 0.8 : 1
          }}
        />
      )}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          zIndex: 1,
          overflowY: 'auto',
          scrollbarGutter: 'stable both-edges',
          px: { xs: 2, sm: 3, lg: 4 },
          overflowX: 'clip',
          containerType: 'size'
        }}
      >
        <Box
          sx={{
            boxSizing: 'border-box',
            minHeight: '100cqh',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            width: '100%',
            maxWidth: HOME_COLUMN_MAX_WIDTH,
            mx: 'auto',
            pt: { xs: 8, sm: 10, lg: 12 },
            pb: 1
          }}
        >
          <HomePrompt
            projects={projects}
            models={models}
            selectedModel={selectedModel}
            thinkingLevel={thinkingLevel}
            busy={busy}
            onSelectModel={onSelectModel}
            onSelectThinkingLevel={onSelectThinkingLevel}
            projectSelection={projectSelection}
            onNewProject={onNewProject}
            onStart={onStartPrompt}
            composerResources={composerResources}
          />

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
              <Typography variant="body2">
                {homeCopy.activityDataUnavailable}
                {activity.error}
              </Typography>
            </Box>
          ) : null}

          <HomeCarouselSection
            activity={activity.data}
            activityLoading={activity.loading}
            overview={homeOverview}
          />
        </Box>
        <Box
          sx={{ width: '100%', maxWidth: HOME_COLUMN_MAX_WIDTH, mx: 'auto', pb: { xs: 3, sm: 4 } }}
        >
          <HomeCompanionRow
            activity={activity.data}
            activityLoading={activity.loading}
            overview={homeOverview}
          />
        </Box>
      </Box>
    </Box>
  )
}
