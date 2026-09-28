import { Box, CircularProgress, IconButton, Popover, Tooltip } from '@mui/material'
import { useId, useState } from 'react'
import type { ContextUsageSnapshot } from '../../../../../shared/contextUsageTypes'
import {
  COMPOSER_ICON_SIZE,
  compactComposerIconButtonSx
} from '../../../components/chat/composerControlStyles'
import { contextUsagePresentation } from '../lib/contextUsagePresentation'
import { ContextUsageBreakdownPanel } from './ContextUsageBreakdownPanel'

export function ContextUsageIndicator({
  usage,
  loading
}: {
  usage: ContextUsageSnapshot | null
  loading: boolean
}): React.JSX.Element {
  const presentation = contextUsagePresentation(usage, loading)
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null)
  const detailId = useId()
  const open = Boolean(anchorEl)
  return (
    <>
      <Tooltip
        title={`${presentation.label}，点击查看详情`}
        placement="top"
        open={open ? false : undefined}
      >
        <IconButton
          type="button"
          size="small"
          aria-label={`上下文用量：${presentation.label}，点击查看详情`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
          data-phi-context-usage={presentation.progress === null ? 'unavailable' : 'available'}
          onClick={(event) => setAnchorEl(event.currentTarget)}
          sx={{ ...compactComposerIconButtonSx, color: 'text.secondary' }}
        >
          <Box
            sx={{
              position: 'relative',
              display: 'inline-flex',
              width: COMPOSER_ICON_SIZE,
              height: COMPOSER_ICON_SIZE
            }}
          >
            <CircularProgress
              variant="determinate"
              value={100}
              size={COMPOSER_ICON_SIZE}
              thickness={6}
              aria-hidden="true"
              sx={{ position: 'absolute', color: 'action.disabledBackground' }}
            />
            <CircularProgress
              variant={loading ? 'indeterminate' : 'determinate'}
              value={presentation.progress ?? 0}
              size={COMPOSER_ICON_SIZE}
              thickness={6}
              aria-hidden="true"
              sx={{ color: 'primary.main' }}
            />
          </Box>
        </IconButton>
      </Tooltip>
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        slotProps={{
          paper: {
            id: detailId,
            role: 'dialog',
            'aria-label': '上下文用量详情',
            sx: {
              bgcolor: 'background.paper',
              backgroundImage: 'none',
              boxShadow: 'none',
              borderRadius: 2
            }
          }
        }}
      >
        <ContextUsageBreakdownPanel
          usage={usage}
          loading={loading}
          onClose={() => setAnchorEl(null)}
        />
      </Popover>
    </>
  )
}
