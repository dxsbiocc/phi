import { jobsCopy } from '../lib/jobsCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Box, IconButton, LinearProgress, Stack, Typography } from '@mui/material'

import { PhiIcons } from '../../../icons'
import type { UnifiedBackgroundJob } from '../lib/backgroundJobs'
import { BackgroundJobIcon } from './BackgroundJobIcon'
import {
  canStopJob,
  jobPercent,
  jobSource,
  jobStatus,
  jobSubtitle,
  jobTitle,
  stopAriaLabel,
  JOB_TONE_COLOR
} from '../lib/backgroundJobLabels'

const StopIcon = PhiIcons.action.stop

/** One job in the list. The whole row opens its detail inside the panel. */
export function BackgroundJobRow({
  item,
  busy,
  compact = false,
  onOpen,
  onStop,
  onRetry
}: {
  item: UnifiedBackgroundJob
  nowMs: number
  busy: boolean
  /** Workflow steps show the tool name and status, without the source line. */
  compact?: boolean
  onOpen: (item: UnifiedBackgroundJob) => void
  onStop: (item: UnifiedBackgroundJob) => void
  onRetry?: (item: UnifiedBackgroundJob) => void
}): React.JSX.Element {
  useUiLanguage()
  const title = jobTitle(item)
  const status = jobStatus(item)
  const percent = jobPercent(item)
  const canStop = canStopJob(item)
  const canRetryJob = Boolean(onRetry && item.kind !== 'history')
  const kind = item.kind === 'history' ? item.snapshot.sourceKind : item.kind
  return (
    <Box
      role="button"
      tabIndex={0}
      aria-label={jobsCopy.viewDetailsForValue(title)}
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
        borderRadius: 2,
        px: compact ? 1.25 : 1,
        py: compact ? 0.75 : 1,
        mb: compact ? 0 : 0.9,
        height: compact ? 44 : 68,
        boxSizing: 'border-box',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        overflow: 'hidden',
        minWidth: 0,
        cursor: 'pointer',
        bgcolor: 'background.paper',
        boxShadow: '0 2px 5px rgba(18, 35, 43, 0.05), 0 8px 20px rgba(18, 35, 43, 0.04)',
        transition: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 200ms ease',
        '&:hover': {
          transform: 'translateY(-1px)',
          boxShadow: '0 4px 10px rgba(18, 35, 43, 0.09), 0 12px 25px rgba(18, 35, 43, 0.06)'
        },
        '@media (prefers-reduced-motion: reduce)': {
          transition: 'none',
          '&:hover': { transform: 'none' }
        },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 1 }
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0, width: '100%' }}>
        <BackgroundJobIcon kind={kind} />
        <Box sx={{ minWidth: 0, flex: 1, pr: canStop || canRetryJob ? 3.5 : 0 }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'baseline', minWidth: 0 }}>
            <Typography
              variant="body2"
              noWrap
              sx={{ minWidth: 0, flex: 1, fontWeight: 700, fontSize: '0.92rem' }}
              title={title}
            >
              {title}
            </Typography>
            <Typography
              variant="caption"
              noWrap
              sx={{ flexShrink: 0, color: JOB_TONE_COLOR[status.tone] }}
            >
              {status.label}
            </Typography>
          </Stack>
          {compact ? null : (
            <Typography
              variant="caption"
              color="text.secondary"
              component="div"
              title={`${jobSource(item)} · ${jobSubtitle(item)}`}
              noWrap
            >
              {jobSource(item)} · {jobSubtitle(item)}
            </Typography>
          )}
        </Box>
      </Stack>
      {(item.kind === 'environment' || item.kind === 'upload') && item.active && (
        <LinearProgress
          variant={percent === undefined ? 'indeterminate' : 'determinate'}
          value={percent ?? 0}
          aria-label={
            item.kind === 'upload' ? jobsCopy.fileUploadProgress : jobsCopy.environmentBuildProgress
          }
          sx={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: 2 }}
        />
      )}
      {(canStop || canRetryJob) && (
        <Stack
          direction="row"
          spacing={0.25}
          sx={{
            position: 'absolute',
            right: 5,
            ...(compact ? { top: '50%', transform: 'translateY(-50%)' } : { bottom: 2 })
          }}
        >
          {onRetry && item.kind !== 'history' && (
            <IconButton
              size="small"
              aria-label={jobsCopy.retry}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation()
                onRetry(item)
              }}
            >
              <PhiIcons.action.refresh size={15} aria-hidden />
            </IconButton>
          )}
          {canStop && (
            <IconButton
              size="small"
              aria-label={stopAriaLabel(item)}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation()
                onStop(item)
              }}
            >
              <StopIcon size={15} aria-hidden />
            </IconButton>
          )}
        </Stack>
      )}
    </Box>
  )
}
