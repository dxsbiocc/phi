import { Box, Button, Chip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'

import { ResourceIcon, type ResourceIconProps } from '../../../components/ResourceIcon'
import { PhiIcons } from '../../../icons'
import { sessionDisplayTitle } from '../../../lib/sessionTitles'
import type { SessionStatus, SessionSummary } from '../../../types'
import { formatSessionActivity } from '../lib/homeActivity'
import type { HomeRecentWorkItem, HomeResourceCounts, RankedWrapper } from '../lib/homeOverview'
import { HomeResourceCategoryIcon } from './HomeResourceCategoryIcon'
import { HomeWrapperRanking } from './HomeWrapperRanking'

interface HomeOverviewCardsProps {
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
  { key: 'skills', label: 'Skills', activeLabel: '已启用', kind: 'skill' },
  { key: 'wrappers', label: 'Wrappers', activeLabel: '可用', kind: 'wrapper' },
  { key: 'connectors', label: 'Connectors', activeLabel: '已启用', kind: 'mcp' },
  { key: 'plugins', label: 'Plugins', activeLabel: '已启用', kind: 'plugin' }
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
  idle: { label: '可继续', color: 'default' },
  running: { label: '进行中', color: 'info' },
  needs_approval: { label: '等待批准', color: 'warning' },
  needs_input: { label: '等待回复', color: 'warning' },
  failed: { label: '需处理', color: 'error' },
  completed_unread: { label: '已完成', color: 'success' }
}

function recentSessionStatus(session: SessionSummary): (typeof statusPresentation)[SessionStatus] {
  if (session.status === 'idle' && session.lastRunOutcome === 'completed') {
    return { label: '已完成', color: 'success' }
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
  const icons = resource.icons ?? []
  return (
    <Box
      data-phi-home-resource-icon={kind}
      sx={{ width: 42, height: 34, flexShrink: 0, display: 'flex', alignItems: 'center' }}
    >
      {icons.length > 0 ? (
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
  const showContinuation = recentWork.length > 0 || projectConversationsLoading

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: showContinuation
          ? { xs: '1fr', md: 'minmax(0, 1.55fr) minmax(290px, 0.85fr)' }
          : '1fr',
        gap: 2,
        mt: 2,
        alignItems: 'start'
      }}
    >
      {showContinuation ? (
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
            继续最近的工作
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            对话与所属项目放在一起，直接接着做。
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1.5 }}>
            <Chip size="small" variant="outlined" label={`${projectCount} 个项目`} />
            <Chip
              size="small"
              variant="outlined"
              label={`${ordinaryConversationCount} 条普通对话`}
            />
            <Chip
              size="small"
              variant="outlined"
              label={
                projectConversationsLoading
                  ? '正在读取项目对话'
                  : projectConversationsIncomplete
                    ? projectConversationCount > 0
                      ? `至少 ${projectConversationCount} 条项目对话`
                      : '项目对话暂不可用'
                    : `${projectConversationCount} 条项目对话`
              }
            />
            {runningCount > 0 ? (
              <Chip size="small" color="info" variant="soft" label={`${runningCount} 项运行中`} />
            ) : null}
            {attentionCount > 0 ? (
              <Chip
                size="small"
                color="warning"
                variant="soft"
                label={`${attentionCount} 项需关注`}
              />
            ) : null}
          </Box>

          {recentWork.length > 0 ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mt: 1.75 }}>
              {recentWork.map(({ session, project }) => {
                const title = sessionDisplayTitle(session)
                const status = recentSessionStatus(session)
                const scope = project
                  ? `${project.name} · ${project.location.kind === 'ssh' ? '远程' : '本地'}`
                  : '普通对话'
                return (
                  <Button
                    key={session.path}
                    aria-label={`继续 ${title}，${scope}`}
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
                        {scope} · {formatSessionActivity(session)} · {session.messageCount} 条消息
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
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ py: 3, mt: 1.5 }}>
              {projectConversationsLoading
                ? '正在读取最近的工作…'
                : '还没有可继续的对话，选择项目或新建对话开始。'}
            </Typography>
          )}
        </Box>
      ) : null}

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
          资源概览
        </Typography>
        <Typography variant="caption" color="text.secondary">
          当前工作范围已启用 / 可用
        </Typography>
        <Box
          sx={{
            mt: 0.75,
            display: showContinuation ? 'block' : 'grid',
            gridTemplateColumns: showContinuation
              ? undefined
              : { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
            columnGap: showContinuation ? 0 : 2
          }}
        >
          {resourceRows.map(({ key, label, activeLabel, kind }, index) => {
            const resource = resources[key]
            return (
              <Box
                key={key}
                data-phi-home-resource={key}
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
                    共 {resource.total} 个
                  </Typography>
                </Box>
                <Box
                  aria-label={`${label} ${resource.active} ${activeLabel}，共 ${resource.total} 个`}
                  sx={{
                    width: 112,
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) 3em',
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
                    {resource.loading ? '—' : resource.active}
                  </Typography>
                  <Box
                    component="span"
                    sx={{
                      width: '3em',
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
