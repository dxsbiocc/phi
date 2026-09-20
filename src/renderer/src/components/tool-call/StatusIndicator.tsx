import { CircularProgress } from '@mui/material'
import type { ReactNode } from 'react'
import { PhiIcons } from '../../icons'
import type { ToolCallItem } from '../../types'

const CancelIcon = PhiIcons.state.denied
const CheckCircleIcon = PhiIcons.state.done

export function StatusIndicator({ status }: { status: ToolCallItem['status'] }): ReactNode {
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
        aria-label="执行中"
      />
    )
  }
  if (status === 'error') {
    return <CancelIcon sx={{ fontSize: 14 }} color="error" aria-label="失败" />
  }
  return <CheckCircleIcon sx={{ fontSize: 14, color: 'success.main' }} aria-label="完成" />
}
