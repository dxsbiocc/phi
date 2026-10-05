import { Box, Button, IconButton, Typography } from '@mui/material'

import { PhiIcons } from '../../../icons'
import type { OfficeComposerTarget } from '../lib/officePromptTarget'

const CloseIcon = PhiIcons.action.close

export function OfficeTargetChip({
  target,
  onClearSelection,
  onRemove
}: {
  target: OfficeComposerTarget
  onClearSelection?: () => void
  onRemove: () => void
}): React.JSX.Element {
  const selection = target.humanEdit === 'none' ? undefined : target.selection
  const selectionLabel = selection
    ? selection.sheet && selection.range
      ? `${selection.sheet}!${selection.range}`
      : `${selection.sheet ?? '跨表'} · ${selection.paths.length} 项`
    : null
  return (
    <Box
      data-phi-office-target={target.artifactId}
      sx={{
        display: 'flex',
        alignItems: 'center',
        width: 'fit-content',
        maxWidth: '100%',
        mb: 0.75
      }}
    >
      <Typography variant="caption" noWrap sx={{ color: 'text.secondary' }}>
        关联文档：{target.label}
        {selectionLabel ? ` · 选区：${selectionLabel}` : ''}
      </Typography>
      {selection && onClearSelection && (
        <Button
          size="small"
          onClick={onClearSelection}
          data-phi-office-clear-selection={target.artifactId}
          sx={{ ml: 0.5, minWidth: 0, p: 0.25, fontSize: '0.7rem' }}
        >
          清除选区
        </Button>
      )}
      <IconButton
        size="small"
        aria-label={`取消关联文档 ${target.label}`}
        onClick={onRemove}
        sx={{ ml: 0.25, p: 0.25 }}
      >
        <CloseIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
  )
}
