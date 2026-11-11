import { Box, ButtonBase, IconButton, Paper, Typography } from '@mui/material'

import { AnimatedList, AnimatedListItem } from './AnimatedList'
import { useUiLanguage } from '../../../lib/i18n'
import { PhiIcons } from '../../../icons'
import { useBackgroundJobArrivals } from '../hooks/useBackgroundJobArrivals'
import type { BackgroundJobArrival } from '../hooks/useBackgroundJobArrivals'
import type { BackgroundJobDisplayItem } from '../lib/backgroundJobGroups'
import { jobOperation, jobTitle } from '../lib/backgroundJobLabels'
import { jobsCopy } from '../lib/jobsCopy'
import { BackgroundJobIcon } from './BackgroundJobIcon'
import { usePluginJobIcon } from '../hooks/pluginJobIcons'

const CloseIcon = PhiIcons.action.close

export function ArrivalCard({
  item,
  phase,
  onOpen,
  onDismiss
}: {
  item: BackgroundJobDisplayItem
  phase: BackgroundJobArrival['phase']
  onOpen: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const title = item.kind === 'workflow' ? item.title : jobTitle(item.job)
  const source = item.kind === 'workflow' ? jobsCopy.workflow : jobOperation(item.job)
  const pluginIcon = usePluginJobIcon(item.kind === 'workflow' ? '' : item.job.key)
  const status =
    phase === 'completed'
      ? jobsCopy.completed
      : phase === 'failed'
        ? jobsCopy.failed
        : jobsCopy.addedToBackgroundJobs
  return (
    <Paper
      elevation={5}
      sx={{
        position: 'relative',
        mb: 0.75,
        borderRadius: 2,
        overflow: 'hidden',
        border: 1,
        borderColor: 'divider',
        '&:hover .phi-background-job-arrival-dismiss, &:focus-within .phi-background-job-arrival-dismiss':
          { opacity: 1 }
      }}
    >
      <ButtonBase
        data-phi-background-job-arrival={item.key}
        onClick={onOpen}
        aria-label={jobsCopy.viewDetailsForValue(title)}
        sx={{ width: '100%', p: 1.25, gap: 1.25, textAlign: 'left', justifyContent: 'flex-start' }}
      >
        <BackgroundJobIcon
          kind={
            item.kind === 'workflow'
              ? 'wrapper'
              : item.job.kind === 'history'
                ? item.job.snapshot.sourceKind
                : item.job.kind
          }
          icon={pluginIcon}
        />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap title={title}>
            {title}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div" noWrap>
            {status} · {source}
          </Typography>
        </Box>
      </ButtonBase>
      {/* Kept outside ButtonBase: a button must not be nested inside another button. */}
      <IconButton
        className="phi-background-job-arrival-dismiss"
        data-phi-background-job-arrival-dismiss={item.key}
        size="small"
        aria-label={jobsCopy.close}
        onClick={onDismiss}
        sx={{
          position: 'absolute',
          top: 4,
          right: 4,
          opacity: 0,
          transition: 'opacity 120ms ease',
          '&.Mui-focusVisible, &:focus-visible': { opacity: 1 }
        }}
      >
        <CloseIcon fontSize="small" />
      </IconButton>
    </Paper>
  )
}

/** Short-lived arrival cards; task status and history continue to live in the jobs panel. */
export function BackgroundJobArrivalNotice({
  onOpen
}: {
  onOpen: (item: BackgroundJobDisplayItem) => void
}): React.JSX.Element | null {
  useUiLanguage()
  const { arrivals, dismiss } = useBackgroundJobArrivals()
  return (
    <Box
      data-phi-background-job-arrivals="floating"
      aria-live="polite"
      sx={{
        position: 'fixed',
        top: 52,
        right: 16,
        width: 'min(360px, calc(100vw - 32px))',
        zIndex: 1200,
        pointerEvents: 'auto',
        WebkitAppRegion: 'no-drag'
      }}
    >
      <AnimatedList className="phi-background-job-arrival-list">
        {arrivals.map(({ item, phase }) => (
          <AnimatedListItem key={`${item.key}:${phase}`}>
            <ArrivalCard
              item={item}
              phase={phase}
              onOpen={() => {
                dismiss(item.key)
                onOpen(item)
              }}
              onDismiss={() => dismiss(item.key)}
            />
          </AnimatedListItem>
        ))}
      </AnimatedList>
    </Box>
  )
}
