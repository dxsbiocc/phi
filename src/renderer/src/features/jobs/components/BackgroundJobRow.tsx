import { Box, Button, IconButton, LinearProgress, Stack, Tooltip, Typography } from '@mui/material'

import { PhiIcons } from '../../../icons'
import { workspacePanelText } from '../../../layout'
import type { UnifiedBackgroundJob } from '../lib/backgroundJobs'
import {
  canStopJob,
  jobDetail,
  jobPercent,
  jobSource,
  jobStatus,
  jobSubtitle,
  jobTitle,
  stopAriaLabel,
  stopTooltip,
  JOB_TONE_COLOR
} from '../lib/backgroundJobLabels'

const StopIcon = PhiIcons.action.stop

const clampTwoLines = {
  minWidth: 0,
  overflow: 'hidden',
  overflowWrap: 'anywhere',
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2
} as const

/** One job in the list. The whole row opens its detail inside the panel. */
export function BackgroundJobRow({
  item,
  nowMs,
  busy,
  onOpen,
  onStop,
  onRetry
}: {
  item: UnifiedBackgroundJob
  nowMs: number
  busy: boolean
  onOpen: (item: UnifiedBackgroundJob) => void
  onStop: (item: UnifiedBackgroundJob) => void
  onRetry?: (item: UnifiedBackgroundJob) => void
}): React.JSX.Element {
  const title = jobTitle(item)
  const status = jobStatus(item)
  const detail = jobDetail(item, nowMs)
  const percent = jobPercent(item)
  const canStop = canStopJob(item)
  const warning = item.kind === 'connector' && item.setup.failureKind === 'needs-setup'
  return (
    <Box
      role="button"
      tabIndex={0}
      aria-label={`查看 ${title} 详情`}
      data-phi-background-job={item.key}
      onClick={() => onOpen(item)}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(item)
        }
      }}
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1.5,
        p: 1,
        mb: 1,
        minWidth: 0,
        cursor: 'pointer',
        '&:hover': { bgcolor: 'action.hover' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 1 }
      }}
    >
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
        <Box
          aria-hidden
          sx={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            flexShrink: 0,
            bgcolor: JOB_TONE_COLOR[status.tone]
          }}
        />
        <Typography
          variant="body2"
          noWrap
          sx={{ ...workspacePanelText.itemTitle, flex: 1 }}
          title={title}
        >
          {title}
        </Typography>
        <Typography
          variant="caption"
          sx={{ ...workspacePanelText.body, flexShrink: 0, color: JOB_TONE_COLOR[status.tone] }}
        >
          {status.label}
        </Typography>
      </Stack>
      <Typography
        variant="caption"
        color="text.secondary"
        component="div"
        title={`${jobSource(item)} · ${jobSubtitle(item)}`}
        noWrap
        sx={workspacePanelText.body}
      >
        {jobSource(item)} · {jobSubtitle(item)}
      </Typography>
      <Typography
        variant="caption"
        color={warning ? 'warning.main' : status.tone === 'error' ? 'error.main' : 'text.secondary'}
        component="div"
        title={detail}
        sx={{ ...workspacePanelText.body, ...clampTwoLines }}
      >
        {detail}
      </Typography>
      {(item.kind === 'environment' || item.kind === 'upload') && item.active && (
        <LinearProgress
          variant={percent === undefined ? 'indeterminate' : 'determinate'}
          value={percent ?? 0}
          aria-label={item.kind === 'upload' ? '文件上传进度' : '环境构建进度'}
          sx={{ mt: 0.75, height: 2, borderRadius: 1 }}
        />
      )}
      {(canStop || (onRetry && item.kind !== 'history')) && (
        <Stack direction="row" spacing={1} sx={{ mt: 0.5, justifyContent: 'flex-end' }}>
          {onRetry && item.kind !== 'history' && (
            <Button
              size="small"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation()
                onRetry(item)
              }}
            >
              重试
            </Button>
          )}
          {canStop && (
            <Tooltip title={stopTooltip(item)}>
              <span>
                <IconButton
                  size="small"
                  aria-label={stopAriaLabel(item)}
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    onStop(item)
                  }}
                >
                  <StopIcon size={15} />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Stack>
      )}
    </Box>
  )
}
