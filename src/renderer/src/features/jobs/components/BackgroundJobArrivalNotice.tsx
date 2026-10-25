import { Box, ButtonBase, Paper, Typography } from '@mui/material'

import { AnimatedList, AnimatedListItem } from './AnimatedList'
import { useUiLanguage } from '../../../lib/i18n'
import { useBackgroundJobArrivals } from '../hooks/useBackgroundJobArrivals'
import type { BackgroundJobArrival } from '../hooks/useBackgroundJobArrivals'
import type { BackgroundJobDisplayItem } from '../lib/backgroundJobGroups'
import { jobSource, jobTitle } from '../lib/backgroundJobLabels'
import { jobsCopy } from '../lib/jobsCopy'
import { BackgroundJobIcon } from './BackgroundJobIcon'

function ArrivalCard({
  item,
  phase,
  onOpen
}: {
  item: BackgroundJobDisplayItem
  phase: BackgroundJobArrival['phase']
  onOpen: () => void
}): React.JSX.Element {
  const title = item.kind === 'workflow' ? item.title : jobTitle(item.job)
  const source = item.kind === 'workflow' ? jobsCopy.workflow : jobSource(item.job)
  const status =
    phase === 'completed'
      ? jobsCopy.completed
      : phase === 'failed'
        ? jobsCopy.failed
        : jobsCopy.addedToBackgroundJobs
  return (
    <Paper
      elevation={5}
      sx={{ mb: 0.75, borderRadius: 2, overflow: 'hidden', border: 1, borderColor: 'divider' }}
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
            />
          </AnimatedListItem>
        ))}
      </AnimatedList>
    </Box>
  )
}
