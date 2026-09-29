import { Box, IconButton, Typography } from '@mui/material'
import type { ContextUsageSnapshot } from '../../../../../shared/contextUsageTypes'
import { PhiIcons } from '../../../icons'
import { contextUsageCategories } from '../lib/contextUsageBreakdown'
import { contextUsagePresentation, formatTokens } from '../lib/contextUsagePresentation'

export function ContextUsageBreakdownPanel({
  usage,
  loading,
  onClose
}: {
  usage: ContextUsageSnapshot | null
  loading: boolean
  onClose?: () => void
}): React.JSX.Element {
  const presentation = contextUsagePresentation(usage, loading)
  const categories = contextUsageCategories(usage)
  const barDenominator = usage ? Math.max(usage.contextWindow, usage.tokens) : 1
  const freeTokens = usage ? Math.max(0, usage.contextWindow - usage.tokens) : 0
  const freePercent = usage ? (freeTokens / usage.contextWindow) * 100 : 0
  const largestId = categories.find((category) => category.tokens > 0)?.id

  return (
    <Box
      data-phi-context-breakdown-panel="true"
      sx={{
        width: { xs: 'min(360px, calc(100vw - 40px))', sm: 420 },
        maxWidth: 'calc(100vw - 40px)',
        p: 2,
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        bgcolor: 'background.paper',
        color: 'text.primary',
        boxShadow: 8
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          上下文用量
        </Typography>
        {onClose && (
          <IconButton size="small" aria-label="关闭上下文详情" onClick={onClose} sx={{ ml: 1 }}>
            <PhiIcons.action.close size={16} />
          </IconButton>
        )}
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {usage ? `${Math.round(usage.percent)}% 已使用` : presentation.label}
        </Typography>
        {usage && (
          <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
            {formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)} tokens
          </Typography>
        )}
      </Box>
      {usage && (
        <Box
          aria-label="上下文分类占比"
          sx={{
            display: 'flex',
            width: '100%',
            height: 8,
            overflow: 'hidden',
            borderRadius: 4,
            bgcolor: 'action.hover',
            mb: 1.5
          }}
        >
          {categories.length > 0 ? (
            categories.map((category) =>
              category.tokens > 0 ? (
                <Box
                  key={category.id}
                  title={`${category.label} ${formatTokens(category.tokens)} tokens`}
                  data-phi-context-segment={category.id}
                  sx={{
                    width: `${(category.tokens / barDenominator) * 100}%`,
                    minWidth: 2,
                    bgcolor: category.color,
                    flexShrink: 0
                  }}
                />
              ) : null
            )
          ) : (
            <Box sx={{ width: `${presentation.progress ?? 0}%`, bgcolor: 'text.disabled' }} />
          )}
          {freeTokens > 0 && <Box sx={{ flex: 1, bgcolor: 'action.selected' }} />}
        </Box>
      )}
      {categories.length > 0 ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {categories.map((category) => (
            <Box
              key={category.id}
              data-phi-context-category={category.id}
              sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}
            >
              <Box
                sx={{
                  width: 12,
                  height: 12,
                  flexShrink: 0,
                  borderRadius: 0.5,
                  bgcolor: category.color
                }}
              />
              <Typography
                variant="body2"
                sx={{ flex: 1, minWidth: 0, fontWeight: category.id === largestId ? 700 : 400 }}
              >
                {category.label}
                {category.id === largestId ? ' · 最多' : ''}
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
              >
                {formatTokens(category.tokens)} · {category.windowPercent.toFixed(1)}%
              </Typography>
            </Box>
          ))}
          <Box
            title="未使用容量包含自动压缩预留"
            sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}
          >
            <Box
              sx={{
                width: 12,
                height: 12,
                flexShrink: 0,
                borderRadius: 0.5,
                bgcolor: 'action.disabledBackground'
              }}
            />
            <Typography variant="body2" sx={{ flex: 1 }}>
              未使用容量
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {formatTokens(freeTokens)} · {freePercent.toFixed(1)}%
            </Typography>
          </Box>
          {usage?.deferredMcpTokens !== undefined && (
            <Box
              data-phi-context-deferred-mcp="true"
              title="完整 schema 的潜在开销，不计入当前用量；目录提示可能计入系统上下文"
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                minWidth: 0,
                pt: 0.75,
                borderTop: 1,
                borderColor: 'divider'
              }}
            >
              <Box
                sx={{
                  width: 12,
                  height: 12,
                  flexShrink: 0,
                  borderRadius: 0.5,
                  bgcolor: 'text.disabled'
                }}
              />
              <Typography variant="body2" sx={{ flex: 1 }}>
                MCP 工具（未注入）
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatTokens(usage.deferredMcpTokens)} · —
              </Typography>
            </Box>
          )}
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary">
          {usage ? '当前运行时只提供总量，分类数据暂不可用。' : presentation.detail}
        </Typography>
      )}
    </Box>
  )
}
