import { Box, LinearProgress, Skeleton, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'

import type { HomeActivityPeriodSummary, HomeActivitySummary } from '../../../types'
import { completionRate, formatActivityDuration } from '../lib/homeActivity'

interface HomePeriodSummaryProps {
  activity: HomeActivitySummary | null
  loading: boolean
}

const periodLabels = [
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'year', label: '今年' }
] as const

function PeriodRow({
  label,
  period
}: {
  label: string
  period: HomeActivityPeriodSummary
}): React.JSX.Element {
  const rate = completionRate(period)

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
          <Typography variant="body2" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {formatActivityDuration(period.durationMs)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {period.activeDays} 个活跃日 · {period.totalRuns} 次运行
          </Typography>
        </Box>
        <Typography
          variant="body2"
          color={period.totalRuns > 0 ? 'text.primary' : 'text.secondary'}
          sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
        >
          {rate}%
        </Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={rate}
        aria-label={`${label}运行完成率 ${rate}%`}
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
        工作节奏
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, mb: 0.75 }}>
        任务历时、活跃天数与完成率
      </Typography>

      {loading || !activity ? (
        <Box sx={{ mt: 2 }}>
          {[0, 1, 2].map((key) => (
            <Box key={key} sx={{ py: 1.5 }}>
              <Skeleton width="72%" />
              <Skeleton width="100%" height={12} />
            </Box>
          ))}
        </Box>
      ) : (
        <Box sx={{ mt: 0.75 }}>
          {periodLabels.map(({ key, label }) => (
            <PeriodRow key={key} label={label} period={activity.periods[key]} />
          ))}
        </Box>
      )}
    </Box>
  )
}
