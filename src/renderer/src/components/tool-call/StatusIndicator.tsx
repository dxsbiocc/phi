import { chatCopy } from '../../features/chat/lib/chatCopy'
import { useUiLanguage } from '../../lib/i18n'
import { CircularProgress } from '@mui/material'
import type { ReactNode } from 'react'
import { PhiIcons } from '../../icons'
import type { ToolCallItem } from '../../types'

const CancelIcon = PhiIcons.state.denied
const CheckCircleIcon = PhiIcons.state.done

export function StatusIndicator({ status }: { status: ToolCallItem['status'] }): ReactNode {
  useUiLanguage()
  if (status === 'running') {
    return (
      <CircularProgress
        size={14}
        thickness={5}
        color="inherit"
        sx={{
          color: 'text.secondary',
          '@media (prefers-reduced-motion: reduce)': {
            animation: 'none'
          }
        }}
        aria-label={chatCopy.executing}
      />
    )
  }
  if (status === 'error') {
    return <CancelIcon sx={{ fontSize: 14 }} color="error" aria-label={chatCopy.failed} />
  }
  return <CheckCircleIcon sx={{ fontSize: 14, color: 'success.main' }} aria-label={chatCopy.done} />
}
