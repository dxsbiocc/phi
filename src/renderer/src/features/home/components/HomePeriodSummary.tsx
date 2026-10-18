import { homeCopy } from '../lib/homeCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Box, LinearProgress, Skeleton, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'

import type { HomeActivityPeriodSummary, HomeActivitySummary } from '../../../types'
import { completionRate, formatActivityDuration } from '../lib/homeActivity'

interface HomePeriodSummaryProps {
  activity: HomeActivitySummary | null
  loading: boolean
}

const periodLabels = [
  {
    key: 'week',
    get label() {
      return homeCopy.thisWeek
    }
  },
  {
    key: 'month',
    get label() {
      return homeCopy.thisMonth
    }
  },
  {
    key: 'year',
    get label() {
      return homeCopy.thisYear
    }
  }
] as const

function PeriodRow({
  label,
  period,
  loading
}: {
  label: string
  period: HomeActivityPeriodSummary | undefined
  loading: boolean
}): React.JSX.Element {
  useUiLanguage()
  const rate = period ? completionRate(period) : 0

  return (
    <Box
      sx={{
        py: 1.5,
        '&:not(:last-child)': { borderBottom: 1, borderColor: 'divider' }
      }}
    >
      <Box sx={{ display: 'grid', gridTemplateColumns: '44px minmax(88px, 1fr) auto', gap: 1.5 }}>
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          {label}
        </Typography>
        <Box sx={{ minWidth: 0 }}>
          <Typography
            variant="body2"
            sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', minHeight: '1lh' }}
          >
            {loading ? (
              <Skeleton
                component="span"
                width={72}
                height="1em"
                sx={{ display: 'inline-block', verticalAlign: 'top' }}
              />
            ) : period ? (
              formatActivityDuration(period.durationMs)
            ) : (
              homeCopy.noneYet
            )}
          </Typography>
          <Typography
            component="div"
            variant="caption"
            color="text.secondary"
            sx={{ minHeight: '1lh' }}
          >
            {loading ? (
              <Skeleton
                component="span"
                width="100%"
                height="1em"
                sx={{ display: 'inline-block', verticalAlign: 'top', maxWidth: 156 }}
              />
            ) : period ? (
              homeCopy.valueActiveDaysValueRuns(period.activeDays, period.totalRuns)
            ) : (
              homeCopy.noActivityYet
            )}
          </Typography>
        </Box>
        <Typography
          variant="body2"
          color={period && period.totalRuns > 0 ? 'text.primary' : 'text.secondary'}
          sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
        >
          {loading ? (
            <Skeleton
              component="span"
              width={28}
              height="1em"
              sx={{ display: 'inline-block', verticalAlign: 'top' }}
            />
          ) : (
            `${rate}%`
          )}
        </Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={rate}
        aria-label={
          loading
            ? homeCopy.loadingValueActivity(label)
            : homeCopy.valueCompletionRateValue(label, rate)
        }
        sx={{
          mt: 1,
          ml: '59px',
          height: 4,
          borderRadius: 999,
          bgcolor: (theme) => alpha(theme.palette.text.primary, 0.07),
          '& .MuiLinearProgress-bar': { borderRadius: 999 }
        }}
      />
    </Box>
  )
}

export function HomePeriodSummary({
  activity,
  loading
}: HomePeriodSummaryProps): React.JSX.Element {
  useUiLanguage()
  return (
    <Box
      sx={{
        height: '100%',
        border: 1,
        borderColor: 'divider',
        borderRadius: 3,
        bgcolor: 'background.paper',
        p: { xs: 2, md: 2.5 }
      }}
    >
      <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
        {homeCopy.workRhythm}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, mb: 0.75 }}>
        {homeCopy.taskDurationActiveDaysAndCompletionRate}
      </Typography>

      <Box sx={{ mt: 0.75 }}>
        {periodLabels.map(({ key, label }) => (
          <PeriodRow key={key} label={label} period={activity?.periods[key]} loading={loading} />
        ))}
      </Box>
    </Box>
  )
}
