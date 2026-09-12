import { Box, Tooltip } from '@mui/material'
import type { ReactNode } from 'react'
import { TOOL_ACTION_ICON_META, type PhiIconMeta } from '../icons'
import type { ToolActionKind } from '../lib/toolActions'

const TOOL_ACTION_META = TOOL_ACTION_ICON_META satisfies Record<ToolActionKind, PhiIconMeta>

export function ToolActionIcon({
  action,
  size = 16
}: {
  action: ToolActionKind
  size?: number
}): ReactNode {
  const meta = TOOL_ACTION_META[action]
  const Icon = meta.Icon
  const color = 'color' in meta ? meta.color : 'text.secondary'

  return (
    <Tooltip title={meta.label} enterDelay={500}>
      <Box
        component="span"
        role="img"
        aria-label={meta.label}
        sx={{
          width: size + 2,
          height: size + 2,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color
        }}
      >
        <Icon sx={{ fontSize: size }} />
      </Box>
    </Tooltip>
  )
}
