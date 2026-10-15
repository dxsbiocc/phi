import { Box, Typography } from '@mui/material'
import { useLayoutEffect, useRef } from 'react'

import type {
  NotebookAiGenerationActivity,
  NotebookAiGenerationJob
} from '../../../../../shared/notebookAiJobTypes'
import { workspacePanelText } from '../../../layout'

const KIND_LABEL: Record<NotebookAiGenerationActivity['kind'], string> = {
  phase: '进度',
  thinking: '思考',
  text: '回复',
  action: '行动'
}

function time(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour12: false })
}

/** Follow new events only while the reader has kept the activity viewport at its end. */
export function NotebookJobActivity({
  job
}: {
  job: NotebookAiGenerationJob
}): React.JSX.Element | null {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const followRef = useRef(true)
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport && followRef.current) viewport.scrollTop = viewport.scrollHeight
  }, [job.entries])
  if (!job.entries?.length) return null

  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ ...workspacePanelText.label, display: 'block', mb: 0.5 }}
      >
        运行过程
      </Typography>
      <Box
        ref={viewportRef}
        data-phi-notebook-job-activity
        role="log"
        aria-label="Notebook AI 运行过程"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={(event) => {
          const viewport = event.currentTarget
          followRef.current =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 24
        }}
        sx={{
          minWidth: 0,
          maxHeight: 320,
          overflowY: 'auto',
          overflowX: 'hidden',
          p: 1.25,
          borderRadius: 1,
          bgcolor: 'action.hover',
          userSelect: 'text'
        }}
      >
        {job.entries.map((entry) => (
          <Box
            key={entry.id}
            data-phi-notebook-job-activity-kind={entry.kind}
            sx={{ mb: 1.25, '&:last-child': { mb: 0 } }}
          >
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, minWidth: 0 }}>
              <Typography
                variant="caption"
                sx={{
                  ...workspacePanelText.label,
                  color:
                    entry.status === 'failed'
                      ? 'error.main'
                      : entry.kind === 'thinking'
                        ? 'text.secondary'
                        : 'primary.main',
                  overflowWrap: 'anywhere'
                }}
              >
                {KIND_LABEL[entry.kind]}
                {entry.label ? ` · ${entry.label}` : ''}
              </Typography>
              <Typography
                variant="caption"
                color="text.disabled"
                sx={{ ml: 'auto', flexShrink: 0, fontSize: 11 }}
              >
                {time(entry.at)}
              </Typography>
              {entry.status === 'running' && (
                <Box
                  aria-label="进行中"
                  sx={{
                    width: 5,
                    height: 5,
                    flexShrink: 0,
                    borderRadius: '50%',
                    bgcolor: 'info.main',
                    alignSelf: 'center'
                  }}
                />
              )}
            </Box>
            {entry.text && (
              <Typography
                component="div"
                sx={{
                  ...workspacePanelText.body,
                  mt: 0.25,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  color: entry.kind === 'thinking' ? 'text.secondary' : 'text.primary'
                }}
              >
                {entry.text}
              </Typography>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  )
}
