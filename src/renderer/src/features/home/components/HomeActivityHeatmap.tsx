import { Box, Skeleton, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'

import type { HomeActivityDay } from '../../../types'
import {
  buildHomeActivityCalendar,
  formatActivityDuration,
  totalActiveDays
} from '../lib/homeActivity'
import type { HomeActivitySummary } from '../../../types'

interface HomeActivityHeatmapProps {
  activity: HomeActivitySummary | null
  loading: boolean
}

const weekdayLabels = [
  { row: 2, label: '一' },
  { row: 4, label: '三' },
  { row: 6, label: '五' }
] as const

function dayDescription(day: HomeActivityDay & { label: string }): string {
  if (day.totalRuns === 0 && day.durationMs === 0) return `${day.label}，无活动`
  return `${day.label}，${day.totalRuns} 次运行，${formatActivityDuration(day.durationMs)}`
}

export function HomeActivityHeatmap({
  activity,
  loading
}: HomeActivityHeatmapProps): React.JSX.Element {
  const weeks = buildHomeActivityCalendar(activity?.dayBuckets ?? [])
  const activeDays = activity ? totalActiveDays(activity) : 0

  return (
    <Box
      sx={{
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        border: 1,
        borderColor: 'divider',
        borderRadius: 3,
        bgcolor: 'background.paper',
        p: { xs: 2, md: 2.5 }
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 2,
          mb: 2.25
        }}
      >
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            过去一年的活跃度
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            每个方格代表一天，深色表示更多运行次数与任务历时。
          </Typography>
        </Box>
        <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
          {loading ? (
            <Skeleton width={68} height={34} />
          ) : (
            <Typography
              component="p"
              sx={{
                fontSize: 24,
                lineHeight: 1.2,
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {activeDays}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary">
            个活跃日
          </Typography>
        </Box>
      </Box>

      <Box
        role="img"
        aria-label={`过去一年共有 ${activeDays} 个活跃日`}
        sx={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          overflowX: 'auto',
          py: 1,
          pb: 1.5
        }}
      >
        <Box sx={{ width: '100%', minWidth: 620 }}>
          <Box
            aria-hidden="true"
            sx={{
              display: 'grid',
              gridTemplateColumns: '24px repeat(53, minmax(8px, 1fr))',
              gap: '3px',
              minHeight: 18,
              mb: 0.5
            }}
          >
            <Box />
            {weeks.map((week, weekIndex) => (
              <Typography
                key={week.key}
                variant="caption"
                color="text.secondary"
                sx={{
                  minWidth: 0,
                  overflow: 'visible',
                  whiteSpace: 'nowrap',
                  fontSize: 10,
                  lineHeight: '14px',
                  ...(weekIndex === weeks.length - 1
                    ? { justifySelf: 'end', transform: 'translateX(-2px)' }
                    : {})
                }}
              >
                {week.monthLabel ?? ''}
              </Typography>
            ))}
          </Box>
          <Box sx={{ display: 'flex', gap: '6px' }}>
            <Box
              aria-hidden="true"
              sx={{
                width: 18,
                flexShrink: 0,
                display: 'grid',
                gridTemplateRows: 'repeat(7, 1fr)',
                gap: '3px'
              }}
            >
              {Array.from({ length: 7 }, (_, index) => {
                const marker = weekdayLabels.find((item) => item.row === index + 1)
                return (
                  <Typography
                    key={index}
                    variant="caption"
                    color="text.secondary"
                    sx={{ fontSize: 10, lineHeight: 1, alignSelf: 'center' }}
                  >
                    {marker?.label ?? ''}
                  </Typography>
                )
              })}
            </Box>
            <Box
              sx={{
                flex: 1,
                display: 'grid',
                gridTemplateColumns: 'repeat(53, minmax(8px, 1fr))',
                gap: '3px'
              }}
            >
              {weeks.map((week) => (
                <Box
                  key={week.key}
                  sx={{ display: 'grid', gridTemplateRows: 'repeat(7, 1fr)', gap: '3px' }}
                >
                  {week.days.map((day, dayIndex) =>
                    day ? (
                      <Box
                        component="span"
                        key={day.date}
                        title={dayDescription(day)}
                        aria-hidden="true"
                        sx={{
                          width: '100%',
                          aspectRatio: '1',
                          minWidth: 8,
                          maxWidth: 13,
                          justifySelf: 'center',
                          borderRadius: '2px',
                          bgcolor: (theme) => {
                            const colors = [
                              alpha(
                                theme.palette.text.primary,
                                theme.palette.mode === 'dark' ? 0.08 : 0.06
                              ),
                              alpha(theme.palette.primary.main, 0.22),
                              alpha(theme.palette.primary.main, 0.42),
                              alpha(theme.palette.primary.main, 0.68),
                              theme.palette.primary.main
                            ]
                            return colors[day.level]
                          },
                          transition: (theme) =>
                            theme.transitions.create(['background-color', 'box-shadow'], {
                              duration: theme.transitions.duration.shorter
                            }),
                          '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                          '&:hover': {
                            boxShadow: (theme) =>
                              `0 0 0 2px ${alpha(theme.palette.primary.main, 0.28)}`
                          }
                        }}
                      />
                    ) : (
                      <Box
                        component="span"
                        key={`future-${dayIndex}`}
                        aria-hidden="true"
                        sx={{
                          width: '100%',
                          aspectRatio: '1',
                          minWidth: 8,
                          maxWidth: 13,
                          justifySelf: 'center',
                          visibility: 'hidden'
                        }}
                      />
                    )
                  )}
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      </Box>

      <Box
        aria-hidden="true"
        sx={{
          mt: 1.5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 0.75
        }}
      >
        <Typography variant="caption" color="text.secondary">
          少
        </Typography>
        {[0, 1, 2, 3, 4].map((level) => (
          <Box
            key={level}
            sx={{
              width: 10,
              height: 10,
              borderRadius: '2px',
              bgcolor: (theme) => {
                const colors = [
                  alpha(theme.palette.text.primary, theme.palette.mode === 'dark' ? 0.08 : 0.06),
                  alpha(theme.palette.primary.main, 0.22),
                  alpha(theme.palette.primary.main, 0.42),
                  alpha(theme.palette.primary.main, 0.68),
                  theme.palette.primary.main
                ]
                return colors[level]
              }
            }}
          />
        ))}
        <Typography variant="caption" color="text.secondary">
          多
        </Typography>
      </Box>
    </Box>
  )
}
