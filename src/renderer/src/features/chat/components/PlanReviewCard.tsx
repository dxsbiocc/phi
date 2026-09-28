import { Box, Paper, Typography } from '@mui/material'

import type { PlanReviewItem } from '../../../types'
import MarkdownContent from '../../../components/MarkdownContent'

const STATUS_LABEL: Record<PlanReviewItem['status'], string> = {
  pending: '等待评审',
  approved: '已批准执行',
  revise: '需要修改',
  cancelled: '已取消'
}

export function PlanReviewCard({
  item,
  cwd
}: {
  item: PlanReviewItem
  cwd: string
}): React.JSX.Element {
  return (
    <Paper
      variant="outlined"
      aria-label="计划评审记录"
      sx={{ mx: 1, my: 0.75, p: 1.5, borderRadius: 2, minWidth: 0 }}
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        计划 · {item.title}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {STATUS_LABEL[item.status]}
      </Typography>
      <Box sx={{ mt: 1, maxHeight: 320, overflowY: 'auto' }}>
        <MarkdownContent text={item.content} cwd={cwd} />
      </Box>
      {item.note && (
        <Typography variant="body2" sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>
          修改意见：{item.note}
        </Typography>
      )}
    </Paper>
  )
}
