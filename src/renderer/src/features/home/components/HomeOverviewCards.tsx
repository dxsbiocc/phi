import { homeCopy } from '../lib/homeCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Box, Button, Chip, Skeleton, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'

import { ResourceIcon, type ResourceIconProps } from '../../../components/ResourceIcon'
import { PhiIcons } from '../../../icons'
import { sessionDisplayTitle } from '../../../lib/sessionTitles'
import type { SessionStatus, SessionSummary } from '../../../types'
import { formatSessionActivity } from '../lib/homeActivity'
import {
  HOME_RECENT_WORK_LIMIT,
  type HomeRecentWorkItem,
  type HomeResourceCounts,
  type RankedWrapper
} from '../lib/homeOverview'
import { HomeResourceCategoryIcon } from './HomeResourceCategoryIcon'
import { HomeWrapperRanking } from './HomeWrapperRanking'
import { resourceCatalogCopy, resourceUi } from '../../../lib/resourceUi'

interface HomeOverviewCardsProps {
  sessionsLoading?: boolean
  resourcesLoading?: boolean
  projectCount: number
  ordinaryConversationCount: number
  projectConversationCount: number
  projectConversationsLoading: boolean
  projectConversationsIncomplete: boolean
  runningCount: number
  attentionCount: number
  recentWork: HomeRecentWorkItem[]
  resources: HomeResourceCounts
  wrapperRanking: RankedWrapper[]
  wrapperRunCount: number
  onOpenSession: (path: string) => void
}

type HomeResourceKind = Exclude<ResourceIconProps['kind'], 'agent'>

const resourceRows = [
  {
    key: 'skills',
    get label() {
      return resourceUi.skills
    },
    get activeLabel() {
      return resourceUi.enabled
    },
    kind: 'skill'
  },
  {
    key: 'wrappers',
    get label() {
      return resourceUi.wrappers
    },
    get activeLabel() {
      return resourceCatalogCopy.available
    },
    kind: 'wrapper'
  },
  {
    key: 'connectors',
    get label() {
      return resourceUi.connectors
    },
    get activeLabel() {
      return resourceUi.enabled
    },
    kind: 'mcp'
  },
  {
    key: 'plugins',
    get label() {
      return resourceUi.plugins
    },
    get activeLabel() {
      return resourceUi.enabled
    },
    kind: 'plugin'
  }
] as const satisfies ReadonlyArray<{
  key: keyof HomeResourceCounts
  label: string
  activeLabel: string
  kind: HomeResourceKind
}>

const statusPresentation: Record<
  SessionStatus,
  { label: string; color: 'default' | 'success' | 'warning' | 'error' | 'info' }
> = {
  idle: {
    get label() {
      return homeCopy.readyToContinue
    },
    color: 'default'
  },
  running: {
    get label() {
      return homeCopy.inProgress
    },
    color: 'info'
  },
  needs_approval: {
    get label() {
      return homeCopy.awaitingApproval
    },
    color: 'warning'
  },
  needs_input: {
    get label() {
      return homeCopy.awaitingReply
    },
    color: 'warning'
  },
  failed: {
    get label() {
      return homeCopy.needsAttention
    },
    color: 'error'
  },
  completed_unread: {
    get label() {
      return homeCopy.completed
    },
    color: 'success'
  }
}

function recentSessionStatus(session: SessionSummary): (typeof statusPresentation)[SessionStatus] {
  if (session.status === 'idle' && session.lastRunOutcome === 'completed') {
    return { label: homeCopy.completed, color: 'success' }
  }
  return statusPresentation[session.status]
}

function ResourcePreview({
  resource,
  kind
}: {
  resource: HomeResourceCounts[keyof HomeResourceCounts]
  kind: HomeResourceKind
}): React.JSX.Element {
  useUiLanguage()
  const icons = resource.icons ?? []
  return (
    <Box
      data-phi-home-resource-icon={kind}
      sx={{ width: 42, height: 34, flexShrink: 0, display: 'flex', alignItems: 'center' }}
    >
      {resource.loading && icons.length === 0 ? (
        <Skeleton variant="rounded" width={32} height={32} />
      ) : icons.length > 0 ? (
        icons.map((icon, index) => (
          <Box
            key={icon.key}
            sx={{
              width: 32,
              height: 32,
              flexShrink: 0,
              border: 1,
              borderColor: 'divider',
              borderRadius: 1.25,
              bgcolor: 'background.paper',
              ml: index === 0 ? 0 : -1.75,
              zIndex: icons.length - index,
              overflow: 'hidden'
            }}
          >
            <ResourceIcon icon={icon} kind={kind} size={30} fallbackSize={18} />
          </Box>
        ))
      ) : (
        <Box
          sx={{
            width: 32,
            height: 32,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 1.25,
            bgcolor: 'action.hover',
            color:
              kind === 'skill'
                ? 'primary.main'
                : kind === 'wrapper'
                  ? 'info.main'
                  : kind === 'mcp'
                    ? 'warning.main'
                    : 'secondary.main'
          }}
        >
          <HomeResourceCategoryIcon kind={kind} />
        </Box>
      )}
    </Box>
  )
}

export function HomeOverviewCards({
  sessionsLoading = false,
  resourcesLoading = false,
  projectCount,
  ordinaryConversationCount,
  projectConversationCount,
  projectConversationsLoading,
  projectConversationsIncomplete,
  runningCount,
  attentionCount,
  recentWork,
  resources,
  wrapperRanking,
  wrapperRunCount,
  onOpenSession
}: HomeOverviewCardsProps): React.JSX.Element {
  useUiLanguage()
  const conversationsLoading = sessionsLoading || projectConversationsLoading

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.75fr) minmax(290px, 0.85fr)' },
        gap: 2,
        mt: 2,
        alignItems: 'start'
      }}
    >
      <Box
        data-phi-home-primary-card="true"
        sx={{
          minWidth: 0,
          border: 1,
          borderColor: (theme) => alpha(theme.palette.primary.main, 0.24),
          borderRadius: 3,
          p: { xs: 2.25, md: 2.75 },
          background: (theme) =>
            `linear-gradient(135deg, ${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.11)} 0%, ${theme.palette.background.paper} 76%)`
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 750 }}>
          {homeCopy.continueRecentWork}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          {homeCopy.conversationsAndTheirProjectsReadyToPickUpWhereYou}
        </Typography>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 0.75,
            mt: 1.5,
            minHeight: { xs: 84, sm: 24 }
          }}
        >
          <Chip size="small" variant="outlined" label={homeCopy.valueProjects(projectCount)} />
          <Chip
            size="small"
            variant="outlined"
            aria-label={sessionsLoading ? homeCopy.loadingOrdinaryConversations : undefined}
            label={homeCopy.valueOrdinaryConversations(
              sessionsLoading ? '—' : ordinaryConversationCount
            )}
          />
          <Chip
            size="small"
            variant="outlined"
            aria-label={
              projectConversationsLoading ? homeCopy.loadingProjectConversations : undefined
            }
            label={
              projectConversationsLoading
                ? homeCopy.projectConversations
                : projectConversationsIncomplete
                  ? projectConversationCount > 0
                    ? homeCopy.atLeastValueProjectConversations(projectConversationCount)
                    : homeCopy.projectConversationsUnavailable
                  : homeCopy.valueProjectConversations(projectConversationCount)
            }
          />
          {runningCount > 0 ? (
            <Chip
              size="small"
              color="info"
              variant="soft"
              label={homeCopy.valueRunning(runningCount)}
            />
          ) : null}
          {attentionCount > 0 ? (
            <Chip
              size="small"
              color="warning"
              variant="soft"
              label={homeCopy.valueNeedAttention(attentionCount)}
            />
          ) : null}
        </Box>

        <Box
          data-phi-home-recent-state={
            conversationsLoading ? 'loading' : recentWork.length > 0 ? 'ready' : 'empty'
          }
          aria-busy={conversationsLoading}
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 0.75,
            mt: 1.75,
            // Keep space for the same four rows while loading or showing an empty state.
            minHeight: HOME_RECENT_WORK_LIMIT * 62 + (HOME_RECENT_WORK_LIMIT - 1) * 6
          }}
        >
          {recentWork.map(({ session, project }) => {
            const title = sessionDisplayTitle(session)
            const status = recentSessionStatus(session)
            const scope = project
              ? `${project.name} · ${project.location.kind === 'ssh' ? homeCopy.remote : homeCopy.local}`
              : homeCopy.ordinaryConversation
            return (
              <Button
                key={session.path}
                aria-label={homeCopy.continueValueValue(title, scope)}
                onClick={() => onOpenSession(session.path)}
                sx={{
                  minWidth: 0,
                  minHeight: 62,
                  px: 1.25,
                  py: 0.75,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 2,
                  bgcolor: 'background.paper',
                  color: 'text.primary',
                  textAlign: 'left',
                  textTransform: 'none',
                  '&:hover, &.Mui-focusVisible': {
                    borderColor: 'primary.main',
                    bgcolor: (theme) => alpha(theme.palette.primary.main, 0.06)
                  }
                }}
              >
                <Box
                  sx={{
                    width: 32,
                    height: 32,
                    flexShrink: 0,
                    display: 'grid',
                    placeItems: 'center',
                    borderRadius: 1.5,
                    bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1),
                    color: 'primary.main'
                  }}
                >
                  <PhiIcons.nav.chat sx={{ fontSize: 17 }} />
                </Box>
                <Box data-phi-home-session-content="true" sx={{ flex: 1, minWidth: 0 }}>
                  <Typography noWrap sx={{ fontWeight: 700 }}>
                    {title}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap title={scope}>
                    {scope} · {formatSessionActivity(session)} ·{' '}
                    {`${session.messageCount} ${homeCopy.messages}`}
                  </Typography>
                </Box>
                <Chip
                  data-phi-home-session-status="true"
                  size="small"
                  color={status.color}
                  variant="soft"
                  label={status.label}
                  sx={{
                    width: 88,
                    flexShrink: 0,
                    alignSelf: 'center',
                    '& .MuiChip-label': { width: '100%', textAlign: 'center' }
                  }}
                />
                <PhiIcons.action.back sx={{ fontSize: 17, color: 'text.secondary' }} />
              </Button>
            )
          })}
          {conversationsLoading ? (
            Array.from(
              { length: Math.max(0, HOME_RECENT_WORK_LIMIT - recentWork.length) },
              (_, index) => (
                <Box
                  key={`loading-${index}`}
                  data-phi-home-session-skeleton="true"
                  aria-hidden="true"
                  sx={{
                    minHeight: 62,
                    px: 1.25,
                    py: 0.75,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.25,
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 2,
                    bgcolor: 'background.paper'
                  }}
                >
                  <Skeleton variant="rounded" width={32} height={32} sx={{ flexShrink: 0 }} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Skeleton width="70%" height={24} />
                    <Skeleton width="50%" height={18} />
                  </Box>
                  <Skeleton variant="rounded" width={88} height={24} sx={{ flexShrink: 0 }} />
                  <Skeleton variant="circular" width={17} height={17} sx={{ flexShrink: 0 }} />
                </Box>
              )
            )
          ) : recentWork.length === 0 ? (
            <Box
              sx={{ flex: 1, display: 'grid', placeContent: 'center', textAlign: 'center', p: 2 }}
            >
              <Typography variant="body2" color="text.secondary">
                {homeCopy.noConversationsToContinue}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                {homeCopy.chooseAProjectOrStartANewConversation}
              </Typography>
            </Box>
          ) : null}
        </Box>
      </Box>

      <Box
        data-phi-home-resources-card="true"
        sx={{
          minWidth: 0,
          border: 1,
          borderColor: 'divider',
          borderRadius: 3,
          bgcolor: 'background.paper',
          px: { xs: 2, md: 2.5 },
          py: 1.5
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 750 }}>
          {resourceCatalogCopy.resourceOverview}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {resourceCatalogCopy.resourceOverviewScope}
        </Typography>
        <Box
          sx={{
            mt: 0.75,
            display: 'block'
          }}
        >
          {resourceRows.map(({ key, label, activeLabel, kind }, index) => {
            const resource = {
              ...resources[key],
              loading: resourcesLoading || resources[key].loading
            }
            return (
              <Box
                key={key}
                data-phi-home-resource={key}
                data-phi-home-resource-loading={resource.loading ? 'true' : undefined}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  py: 0.5,
                  borderBottom: index < resourceRows.length - 1 ? 1 : 0,
                  borderColor: 'divider'
                }}
              >
                <ResourcePreview resource={resource} kind={kind} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {resource.loading ? (
                      <Skeleton
                        component="span"
                        width={48}
                        height={18}
                        sx={{ display: 'inline-block', verticalAlign: 'top' }}
                      />
                    ) : (
                      resourceCatalogCopy.total(resource.total)
                    )}
                  </Typography>
                </Box>
                <Box
                  aria-label={
                    resource.loading
                      ? resourceCatalogCopy.resourceLoading(label)
                      : resourceCatalogCopy.resourceCounts(
                          label,
                          resource.active,
                          activeLabel,
                          resource.total
                        )
                  }
                  sx={{
                    width: 144,
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) 5em',
                    columnGap: 0.5,
                    alignItems: 'center',
                    flexShrink: 0
                  }}
                >
                  <Typography
                    component="span"
                    sx={{
                      fontSize: 23,
                      fontWeight: 750,
                      fontVariantNumeric: 'tabular-nums',
                      lineHeight: 1,
                      textAlign: 'right',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {resource.loading ? (
                      <Skeleton
                        component="span"
                        width={28}
                        height={23}
                        sx={{ display: 'inline-block', verticalAlign: 'top', justifySelf: 'end' }}
                      />
                    ) : (
                      resource.active
                    )}
                  </Typography>
                  <Box
                    component="span"
                    sx={{
                      width: '5em',
                      display: 'flex',
                      justifyContent: 'space-between',
                      whiteSpace: 'nowrap',
                      fontSize: '0.75rem',
                      lineHeight: 1.2,
                      color: 'text.secondary'
                    }}
                  >
                    {Array.from(activeLabel, (character, characterIndex) => (
                      <Box component="span" key={`${key}-${characterIndex}`}>
                        {character}
                      </Box>
                    ))}
                  </Box>
                </Box>
              </Box>
            )
          })}
        </Box>
        <HomeWrapperRanking ranking={wrapperRanking} totalRuns={wrapperRunCount} embedded />
      </Box>
    </Box>
  )
}
