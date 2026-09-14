import { Box, Button, CircularProgress, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'

import { PhiIcons } from '../../../icons'
import { notebookAccentColor } from './notebookCellStyles'

const AcceptIcon = PhiIcons.action.approve
const RejectIcon = PhiIcons.action.cancel

export default function NotebookAiPreviewActions({
  isGenerating,
  onAccept,
  onReject
}: {
  isGenerating: boolean
  onAccept: () => void
  onReject: () => void
}): React.JSX.Element {
  return (
    <Box
      data-phi-notebook-ai-preview-actions="true"
      sx={{
        display: 'grid',
        gridTemplateColumns: '32px minmax(0, 1fr) 32px',
        gap: 0.5,
        mt: -0.5
      }}
    >
      <Box
        sx={{
          gridColumn: 2,
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 0.75
        }}
      >
        {isGenerating ? (
          <Typography
            data-phi-notebook-ai-preview-generating="true"
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.75,
              px: 1,
              py: 0.5,
              borderRadius: 1,
              color: 'text.secondary',
              bgcolor: (theme) => alpha(notebookAccentColor(theme, 'ai'), 0.07),
              fontSize: '0.78rem',
              fontWeight: 800
            }}
          >
            <CircularProgress size={14} thickness={4} color="inherit" />
            正在生成预览
          </Typography>
        ) : (
          <>
            <Button
              size="small"
              variant="outlined"
              color="success"
              startIcon={<AcceptIcon sx={{ fontSize: 16 }} />}
              aria-label="接受 AI 生成内容"
              data-phi-notebook-ai-preview-accept="true"
              onClick={onAccept}
              sx={{ minWidth: 94, borderRadius: 1, fontWeight: 800, textTransform: 'none' }}
            >
              Accept
            </Button>
            <Button
              size="small"
              variant="outlined"
              color="error"
              startIcon={<RejectIcon sx={{ fontSize: 16 }} />}
              aria-label="拒绝 AI 生成内容"
              data-phi-notebook-ai-preview-reject="true"
              onClick={onReject}
              sx={{ minWidth: 94, borderRadius: 1, fontWeight: 800, textTransform: 'none' }}
            >
              Reject
            </Button>
          </>
        )}
      </Box>
    </Box>
  )
}
