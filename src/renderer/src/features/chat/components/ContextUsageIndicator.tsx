import { Box, Button, LinearProgress, Tooltip, Typography } from '@mui/material'
import type { ContextUsageSnapshot } from '../../../../../shared/contextUsageTypes'
import { contextUsagePresentation } from '../lib/contextUsagePresentation'
import { AutoCompactionSettingsButton } from './AutoCompactionSettingsButton'
import type { ManualCompactionTarget } from '../../../../../shared/contextUsageTypes'

export function ContextUsageIndicator({
  usage,
  loading,
  compacting = false,
  compactDisabled = false,
  autoCompactionTarget,
  autoCompactionDisabled = false,
  onCompact
}: {
  usage: ContextUsageSnapshot | null
  loading: boolean
  compacting?: boolean
  compactDisabled?: boolean
  autoCompactionTarget?: ManualCompactionTarget
  autoCompactionDisabled?: boolean
  onCompact?: () => void
}): React.JSX.Element {
  const presentation = contextUsagePresentation(usage, loading)
  return (
    <Box sx={{ width: '100%', minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 24 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
          上下文窗口
        </Typography>
        <Tooltip title={presentation.detail} placement="top">
          <Typography
            role="status"
            data-phi-context-usage={presentation.progress === null ? 'unavailable' : 'available'}
            variant="caption"
            sx={{ color: 'text.secondary', ml: 'auto', fontVariantNumeric: 'tabular-nums' }}
          >
            {presentation.label}
          </Typography>
        </Tooltip>
        {onCompact && (
          <Button
            type="button"
            size="small"
            aria-label="压缩当前会话上下文"
            data-phi-context-compact-action="true"
            disabled={compactDisabled || compacting}
            onClick={onCompact}
            sx={{ minWidth: 0, px: 0.75, py: 0.25, fontSize: '0.75rem', whiteSpace: 'nowrap' }}
          >
            {compacting ? '正在压缩…' : '压缩上下文'}
          </Button>
        )}
        {autoCompactionTarget && (
          <AutoCompactionSettingsButton
            target={autoCompactionTarget}
            disabled={autoCompactionDisabled}
          />
        )}
      </Box>
      {presentation.progress !== null && (
        <LinearProgress
          variant="determinate"
          value={presentation.progress}
          aria-label="上下文容量使用率"
          sx={{ mt: 0.25, height: 4, borderRadius: 2, bgcolor: 'action.hover' }}
        />
      )}
    </Box>
  )
}
