import { Box, Typography } from '@mui/material'
import { alpha, useTheme, type Theme } from '@mui/material/styles'

import type { MetricsUiBlock } from '../../../../../../shared/uiBlockTypes'
import { metricColorKeys, type MetricColor } from '../../lib/metricColors'
import { UiBlockContainer } from './UiBlockContainer'

type MetricSurface = {
  background: string
  foreground: string
  muted: string
  line: string
  wash: string
}

function metricSurface(color: MetricColor, theme: Theme): MetricSurface {
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

function MetricCircle({
  color,
  size,
  sx
}: {
  color: string
  size: number
  sx: Record<string, number>
}): React.JSX.Element {
  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        width: size,
        height: size,
        borderRadius: '50%',
        bgcolor: color,
        pointerEvents: 'none',
        ...sx
      }}
    />
  )
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
      <MetricCircle color={surface.wash} size={108} sx={{ right: -28, top: -36 }} />
      <MetricCircle color={surface.wash} size={72} sx={{ right: 18, bottom: -30 }} />
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
