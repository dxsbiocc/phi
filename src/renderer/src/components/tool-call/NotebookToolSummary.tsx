import { Box, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { PhiIcons } from '../../icons'
import type { NotebookToolSummary } from '../../types'
import { notebookCellLabel, notebookTargetLabel, notebookVerb } from './notebookToolSummaryModel'

export function NotebookToolSummaryBlock({
  notebook
}: {
  notebook: NotebookToolSummary
}): ReactNode {
  const target = notebookTargetLabel(notebook)
  const cellLabel = notebookCellLabel(notebook)
  const details = [
    cellLabel,
    notebook.cellType ?? '',
    notebook.executionState ?? '',
    notebook.executionCount !== undefined && notebook.executionCount !== null
      ? `#${notebook.executionCount}`
      : ''
  ].filter(Boolean)

  return (
    <Box
      sx={{
        mb: 1.25,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        minWidth: 0,
        color: 'text.secondary'
      }}
    >
      <PhiIcons.nav.analysis sx={{ mt: 0.2, fontSize: 20, color: 'primary.main' }} />
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 700, color: 'text.primary' }}>
          {notebookVerb(notebook.kind, 'done')}
        </Typography>
        <Typography
          variant="caption"
          component="div"
          sx={{
            mt: 0.25,
            minWidth: 0,
            fontFamily: 'var(--font-mono)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
          title={target}
        >
          {target}
        </Typography>
        {details.length > 0 ? (
          <Typography variant="caption" component="div" sx={{ mt: 0.25 }}>
            {details.join(' · ')}
          </Typography>
        ) : null}
        {notebook.summary ? (
          <Typography variant="caption" component="div" sx={{ mt: 0.25 }}>
            {notebook.summary}
          </Typography>
        ) : null}
      </Box>
    </Box>
  )
}
