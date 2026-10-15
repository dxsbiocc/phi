import { useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography
} from '@mui/material'

import type { NotebookAiGenerationJob } from '../../../../../shared/notebookAiJobTypes'
import type { AnalysisNotebookGeneratedCell } from '../../../../../shared/notebookCodeGeneration'
import MarkdownContent from '../../../components/MarkdownContent'
import { PhiIcons } from '../../../icons'
import { workspacePanelText } from '../../../layout'
import { notebookJobPreviewCells } from '../lib/notebookJobPreview'

const CloseIcon = PhiIcons.action.close

function fencedCode(cell: AnalysisNotebookGeneratedCell): string {
  const longestRun = Math.max(0, ...(cell.source.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  const language = cell.language?.trim().replace(/[^a-zA-Z0-9_-]/g, '') || ''
  return `${fence}${language}\n${cell.source}\n${fence}`
}

function NotebookPreviewCell({ cell }: { cell: AnalysisNotebookGeneratedCell }): React.JSX.Element {
  return (
    <Box data-phi-notebook-job-preview-cell={cell.cellType} sx={{ minWidth: 0, mb: 1.5 }}>
      {cell.cellType === 'markdown' ? (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ ...workspacePanelText.label, display: 'block', mb: 0.5 }}
        >
          Markdown
        </Typography>
      ) : null}
      <Box
        sx={{
          fontSize: workspacePanelText.body.fontSize,
          lineHeight: 1.6,
          '& > div': { fontSize: 'inherit', lineHeight: 'inherit' },
          '& h1, & h2, & h3': { fontSize: 14, lineHeight: 1.45 }
        }}
      >
        <MarkdownContent text={cell.cellType === 'markdown' ? cell.source : fencedCode(cell)} />
      </Box>
    </Box>
  )
}

/** A short in-panel excerpt and a focused read-only dialog for generated cells. */
export function NotebookJobPreview({
  job
}: {
  job: NotebookAiGenerationJob
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const cells = notebookJobPreviewCells(job)
  if (cells.length === 0) return null

  return (
    <Box data-phi-notebook-job-preview="true" sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={workspacePanelText.label}>
          生成内容预览
        </Typography>
        <Button size="small" onClick={() => setOpen(true)} aria-label="展开生成内容预览">
          查看内容
        </Button>
      </Box>
      <Box sx={{ maxHeight: 160, overflow: 'hidden', minWidth: 0 }}>
        {cells.slice(0, 2).map((cell, index) => (
          <NotebookPreviewCell
            key={index}
            cell={{ ...cell, source: cell.source.slice(0, 2_000) }}
          />
        ))}
      </Box>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        aria-labelledby="phi-notebook-job-preview-title"
        maxWidth="md"
        fullWidth
        scroll="paper"
      >
        <DialogTitle
          id="phi-notebook-job-preview-title"
          sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
        >
          <Typography component="span" sx={{ ...workspacePanelText.heading, flex: 1 }}>
            生成内容预览 · {job.notebookName}
          </Typography>
          <IconButton aria-label="关闭生成内容预览" onClick={() => setOpen(false)} size="small">
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ px: 2.5, py: 2, minWidth: 0 }}>
          {cells.map((cell, index) => (
            <NotebookPreviewCell key={index} cell={cell} />
          ))}
        </DialogContent>
      </Dialog>
    </Box>
  )
}
