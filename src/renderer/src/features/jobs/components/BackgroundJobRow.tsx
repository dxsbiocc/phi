import { jobsCopy } from '../lib/jobsCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { IconButton, LinearProgress, Stack, Tooltip } from '@mui/material'

import { PhiIcons } from '../../../icons'
import { LabeledIconButton } from '../../../components/LabeledIconButton'
import { SidePanelCard } from '../../../components/SidePanelCard'
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
  stopTooltip,
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
  // A recovered run may have no task text; leave out the separator rather than end on "·".
  const sourceLine = [jobSource(item), jobSubtitle(item)].filter(Boolean).join(' · ')
  const percent = jobPercent(item)
  const canStop = canStopJob(item)
  const canRetryJob = Boolean(onRetry && item.kind !== 'history')
  const kind = item.kind === 'history' ? item.snapshot.sourceKind : item.kind
  return (
    <SidePanelCard
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
      icon={<BackgroundJobIcon kind={kind} />}
      title={title}
      status={status.label}
      statusColor={JOB_TONE_COLOR[status.tone]}
      subtitle={sourceLine}
      compact={compact}
      reserveActionSpace={canStop || canRetryJob}
      footer={
        (item.kind === 'environment' || item.kind === 'upload') && item.active ? (
          <LinearProgress
            variant={percent === undefined ? 'indeterminate' : 'determinate'}
            value={percent ?? 0}
            aria-label={
              item.kind === 'upload'
                ? jobsCopy.fileUploadProgress
                : jobsCopy.environmentBuildProgress
            }
            sx={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: 2 }}
          />
        ) : null
      }
      actions={
        canStop || canRetryJob ? (
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
              <LabeledIconButton
                label={jobsCopy.retry}
                size="small"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation()
                  onRetry(item)
                }}
              >
                <PhiIcons.action.refresh size={15} aria-hidden />
              </LabeledIconButton>
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
        ) : null
      }
    />
  )
}
