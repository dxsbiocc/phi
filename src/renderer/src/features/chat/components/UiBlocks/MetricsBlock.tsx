import { Box, Typography } from '@mui/material'
import { alpha, useTheme, type Theme } from '@mui/material/styles'

import type { MetricsUiBlock } from '../../../../../../shared/uiBlockTypes'
import { UiBlockContainer } from './UiBlockContainer'

const STATUS_COLOR = {
  ok: 'success',
  warn: 'warning',
  error: 'error',
  neutral: 'grey'
} as const

const FALLBACK_COLORS = ['info', 'secondary', 'primary'] as const

type MetricStatus = keyof typeof STATUS_COLOR | undefined
type MetricColor =
  (typeof STATUS_COLOR)[keyof typeof STATUS_COLOR] | (typeof FALLBACK_COLORS)[number]

export function metricColorKeys(statuses: MetricStatus[]): MetricColor[] {
  const used = new Set<MetricColor>()
  return statuses.map((status) => {
    const preferred: MetricColor = STATUS_COLOR[status ?? 'neutral']
    const color = used.has(preferred)
      ? (FALLBACK_COLORS.find((candidate) => !used.has(candidate)) ?? preferred)
      : preferred
    used.add(color)
    return color
  })
}

function metricSurface(color: MetricColor, theme: Theme) {
  const background =
    color === 'grey'
      ? theme.palette.mode === 'dark'
        ? theme.palette.grey[700]
        : theme.palette.grey[800]
      : theme.palette[color].main
  const foreground = theme.palette.getContrastText(background)
  return {
    background,
    foreground,
    muted: alpha(foreground, 0.78),
    line: alpha(foreground, 0.22),
    wash: alpha(foreground, 0.12)
  }
}

function MetricCard({
  item,
  color
}: {
  item: MetricsUiBlock['items'][number]
  color: MetricColor
}): React.JSX.Element {
  const theme = useTheme()
  const surface = metricSurface(color, theme)
  return (
    <Box
      sx={{
        position: 'relative',
        overflow: 'hidden',
        minWidth: 0,
        px: 1.5,
        py: 1.25,
        borderRadius: 1.5,
        bgcolor: surface.background,
        color: surface.foreground
      }}
    >
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          right: -28,
          top: -36,
          width: 108,
          height: 108,
          borderRadius: '50%',
          bgcolor: surface.wash,
          pointerEvents: 'none'
        }}
      />
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          right: 18,
          bottom: -30,
          width: 72,
          height: 72,
          borderRadius: '50%',
          bgcolor: surface.wash,
          pointerEvents: 'none'
        }}
      />
      <Typography
        variant="caption"
        sx={{ position: 'relative', display: 'block', color: surface.muted, fontWeight: 600 }}
      >
        {item.label}
      </Typography>
      <Typography
        component="div"
        sx={{
          position: 'relative',
          mt: 0.75,
          fontSize: '1.5rem',
          lineHeight: 1.15,
          fontWeight: 700,
          letterSpacing: '-0.02em'
        }}
      >
        {String(item.value)}
        {item.unit ? (
          <Typography component="span" variant="caption" sx={{ ml: 0.5, fontWeight: 700 }}>
            {item.unit}
          </Typography>
        ) : null}
      </Typography>
      {item.hint ? (
        <Typography
          variant="caption"
          sx={{
            position: 'relative',
            display: 'block',
            mt: 1,
            pt: 0.875,
            borderTop: '1px solid',
            borderColor: surface.line,
            color: surface.muted
          }}
        >
          {item.hint}
        </Typography>
      ) : null}
    </Box>
  )
}

export function MetricsBlock({ block }: { block: MetricsUiBlock }): React.JSX.Element {
  const colors = metricColorKeys(block.items.map((item) => item.status))
  return (
    <UiBlockContainer title={block.title} framed={false}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))',
          gap: 1,
          '@container phi-chat (max-width: 560px)': {
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 0.75
          }
        }}
      >
        {block.items.map((item, index) => (
          <MetricCard key={`${item.label}-${index}`} item={item} color={colors[index]} />
        ))}
      </Box>
    </UiBlockContainer>
  )
}
