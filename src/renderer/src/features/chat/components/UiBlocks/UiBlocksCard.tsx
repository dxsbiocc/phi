import { Box, Typography } from '@mui/material'

import type { UiBlocksItem } from '../../lib/uiBlocks'
import { MetricsBlock } from './MetricsBlock'
import { StepsBlock } from './StepsBlock'
import { TableBlock } from './TableBlock'

export function UiBlocksCard({ item }: { item: UiBlocksItem }): React.JSX.Element {
  if (!item.blocks) {
    return (
      <Typography
        variant="caption"
        sx={{ display: 'block', mx: 1.5, my: 0.75, color: 'text.secondary' }}
      >
        无法显示结构化内容
      </Typography>
    )
  }

  return (
    <Box
      role="region"
      aria-label="结构化结果"
      sx={{
        display: 'grid',
        gap: 1,
        minWidth: 0,
        maxWidth: '100%',
        mx: 1,
        my: 1,
        color: 'text.primary',
        '@container phi-chat (max-width: 560px)': { mx: 0, my: 0.5, gap: 0.5 }
      }}
    >
      {item.blocks.map((block, index) => {
        if (block.type === 'table') return <TableBlock key={index} block={block} />
        if (block.type === 'metrics') return <MetricsBlock key={index} block={block} />
        return <StepsBlock key={index} block={block} />
      })}
    </Box>
  )
}
