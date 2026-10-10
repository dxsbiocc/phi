import { Box, Typography } from '@mui/material'

import type { MetricsUiBlock } from '../../../../../../shared/uiBlockTypes'
import { UiBlockContainer } from './UiBlockContainer'

const STATUS_COLORS = {
  ok: 'success.main',
  warn: 'warning.main',
  error: 'error.main',
  neutral: 'divider'
} as const

export function MetricsBlock({ block }: { block: MetricsUiBlock }): React.JSX.Element {
  return (
    <UiBlockContainer title={block.title}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
          gap: 0.75,
          p: 1,
          pt: block.title ? 0.25 : 1,
          '@container phi-chat (max-width: 560px)': {
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 0.5,
            p: 0.75,
            pt: block.title ? 0.25 : 0.75
          }
        }}
      >
        {block.items.map((item, index) => (
          <Box
            key={`${item.label}-${index}`}
            sx={{
              minWidth: 0,
              px: 1,
              py: 0.875,
              border: 1,
              borderLeft: 3,
              borderColor: 'divider',
              borderLeftColor: STATUS_COLORS[item.status ?? 'neutral'],
              borderRadius: 1.25,
              bgcolor: 'action.hover'
            }}
          >
            <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
              {item.label}
            </Typography>
            <Typography
              component="div"
              sx={{ mt: 0.125, fontSize: '1.15rem', lineHeight: 1.25, fontWeight: 700 }}
            >
              {String(item.value)}
              {item.unit ? (
                <Typography component="span" variant="caption" sx={{ ml: 0.375 }}>
                  {item.unit}
                </Typography>
              ) : null}
            </Typography>
            {item.hint ? (
              <Typography
                variant="caption"
                sx={{ display: 'block', mt: 0.25, color: 'text.secondary' }}
              >
                {item.hint}
              </Typography>
            ) : null}
          </Box>
        ))}
      </Box>
    </UiBlockContainer>
  )
}
