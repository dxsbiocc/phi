import { useEffect, useRef, useState } from 'react'
import { Box, IconButton, Tooltip, Typography } from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import { TbTextWrap } from 'react-icons/tb'
import { PhiIcons } from '../../../icons'
import { formatNotebookExecutionCompletedAt } from '../lib/notebookExecutionTime'

const CopyIcon = PhiIcons.action.copy
const ClearIcon = PhiIcons.action.delete

export default function NotebookOutputHeader({
  executionCompletedAt,
  copyText,
  hasOutputs,
  wrapText,
  onToggleWrap,
  onClearOutputs
}: {
  executionCompletedAt?: string
  copyText: string
  hasOutputs: boolean
  wrapText: boolean
  onToggleWrap: () => void
  onClearOutputs?: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const completedAtLabel = formatNotebookExecutionCompletedAt(executionCompletedAt)

  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const copyOutput = async (): Promise<void> => {
    await navigator.clipboard.writeText(copyText)
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 1200)
  }

  const actionSx = {
    width: 26,
    height: 26,
    p: 0,
    color: 'text.secondary',
    bgcolor: 'transparent',
    '&:hover': {
      color: 'text.primary',
      bgcolor: (theme: Theme) => alpha(theme.palette.text.primary, 0.08)
    }
  } as const

  return (
    <Box
      data-phi-notebook-output-header="true"
      sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 26, mb: hasOutputs ? 1 : 0 }}
    >
      {completedAtLabel ? (
        <Typography
          component="time"
          dateTime={executionCompletedAt}
          title="运行结束时间"
          data-phi-notebook-cell-execution-completed-at={executionCompletedAt}
          sx={{
            color: 'text.secondary',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.72rem',
            lineHeight: 1.5
          }}
        >
          {completedAtLabel}
        </Typography>
      ) : null}
      <Box
        data-phi-notebook-output-toolbar="true"
        className="notebook-output-hover-actions"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          ml: 'auto',
          flexShrink: 0,
          opacity: 0,
          pointerEvents: 'none',
          transition: 'opacity 140ms ease'
        }}
      >
        <Tooltip title={copied ? '已复制' : '复制输出'}>
          <span>
            <IconButton
              size="small"
              aria-label={copied ? '已复制输出' : '复制输出'}
              disabled={!copyText}
              onClick={() =>
                void copyOutput().catch((error) =>
                  console.error('Failed to copy notebook output:', error)
                )
              }
              data-phi-notebook-output-copy="true"
              sx={actionSx}
            >
              <CopyIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={wrapText ? '关闭输出换行' : '开启输出换行'}>
          <IconButton
            size="small"
            aria-label={wrapText ? '关闭输出换行' : '开启输出换行'}
            aria-pressed={wrapText}
            onClick={onToggleWrap}
            data-phi-notebook-output-wrap-toggle="true"
            sx={{ ...actionSx, color: wrapText ? 'text.primary' : 'text.secondary' }}
          >
            <Box component={TbTextWrap} sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="清空输出">
          <span>
            <IconButton
              size="small"
              aria-label="清空输出"
              disabled={!hasOutputs || !onClearOutputs}
              onClick={onClearOutputs}
              data-phi-notebook-output-clear="true"
              sx={actionSx}
            >
              <ClearIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
    </Box>
  )
}
