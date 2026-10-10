import { Box, Typography } from '@mui/material'
import { GoCheckCircle, GoCircle, GoSync, GoXCircle } from 'react-icons/go'

import type { StepsUiBlock } from '../../../../../../shared/uiBlockTypes'
import { UiBlockContainer } from './UiBlockContainer'

const STATUS_LABELS = {
  done: '已完成',
  running: '进行中',
  pending: '待处理',
  failed: '失败'
} as const

const STATUS_COLORS = {
  done: 'success.main',
  running: 'info.main',
  pending: 'text.disabled',
  failed: 'error.main'
} as const

function StatusIcon({
  status
}: {
  status: StepsUiBlock['items'][number]['status']
}): React.JSX.Element {
  const props = { size: 17, 'aria-hidden': true } as const
  if (status === 'done') return <GoCheckCircle {...props} />
  if (status === 'running') return <GoSync {...props} />
  if (status === 'failed') return <GoXCircle {...props} />
  return <GoCircle {...props} />
}

export function StepsBlock({ block }: { block: StepsUiBlock }): React.JSX.Element {
  return (
    <UiBlockContainer title={block.title}>
      <Box sx={{ px: 1.25, py: 0.5, '@container phi-chat (max-width: 560px)': { px: 0.75 } }}>
        {block.items.map((item, index) => (
          <Box
            key={`${item.label}-${index}`}
            sx={{
              display: 'grid',
              gridTemplateColumns: '20px minmax(0, 1fr) auto',
              alignItems: 'start',
              columnGap: 0.75,
              py: 0.75,
              borderBottom: index < block.items.length - 1 ? 1 : 0,
              borderColor: 'divider'
            }}
          >
            <Box
              component="span"
              aria-label={STATUS_LABELS[item.status]}
              sx={{ display: 'inline-flex', mt: 0.125, color: STATUS_COLORS[item.status] }}
            >
              <StatusIcon status={item.status} />
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                {item.label}
              </Typography>
              {item.detail ? (
                <Typography
                  variant="caption"
                  sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}
                >
                  {item.detail}
                </Typography>
              ) : null}
            </Box>
            <Typography
              variant="caption"
              sx={{ color: STATUS_COLORS[item.status], whiteSpace: 'nowrap' }}
            >
              {STATUS_LABELS[item.status]}
            </Typography>
          </Box>
        ))}
      </Box>
    </UiBlockContainer>
  )
}
