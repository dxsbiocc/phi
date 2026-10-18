import { forwardRef, type CSSProperties, type ForwardedRef } from 'react'
import { Box, Button, IconButton, Typography } from '@mui/material'
import { appCopy } from '../lib/appCopy'
import { useUiLanguage } from '../lib/i18n'
import { FiAlertTriangle, FiCheckCircle, FiInfo, FiX, FiXCircle } from 'react-icons/fi'

export type SnackbarSeverity = 'error' | 'info' | 'success' | 'warning'
export type SnackbarNotice = {
  id: number
  severity: SnackbarSeverity
  message: string
  persistent?: boolean
  action?: {
    label: string
    onClick: () => void
  }
}

const appearance = {
  info: {
    get label() {
      return appCopy.noticeInfo
    },
    color: '#2455E8',
    softColor: '#D4DFFF',
    backgroundColor: '#F2F5FF',
    Icon: FiInfo
  },
  success: {
    get label() {
      return appCopy.noticeSuccess
    },
    color: '#16834A',
    softColor: '#D4F3E1',
    backgroundColor: '#F1FBF5',
    Icon: FiCheckCircle
  },
  warning: {
    get label() {
      return appCopy.noticeWarning
    },
    color: '#B76D00',
    softColor: '#FFE6C1',
    backgroundColor: '#FFF8EA',
    Icon: FiAlertTriangle
  },
  error: {
    get label() {
      return appCopy.noticeError
    },
    color: '#C81919',
    softColor: '#FFD2D0',
    backgroundColor: '#FFF3F3',
    Icon: FiXCircle
  }
} satisfies Record<
  SnackbarSeverity,
  { label: string; color: string; softColor: string; backgroundColor: string; Icon: typeof FiInfo }
>

export type AppSnackbarCardProps = {
  notice: SnackbarNotice
  onClose: () => void
  style?: CSSProperties
}

export function AppSnackbarCardContent(
  { notice, onClose, style }: AppSnackbarCardProps,
  ref?: ForwardedRef<HTMLDivElement>
): React.JSX.Element {
  useUiLanguage()
  const { label, color, softColor, backgroundColor, Icon } = appearance[notice.severity]

  return (
    <Box
      ref={ref}
      style={style}
      className="PhiSnackbar-card"
      role={notice.severity === 'error' || notice.severity === 'warning' ? 'alert' : 'status'}
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        boxSizing: 'border-box',
        width: 600,
        maxWidth: 'calc(100% - 32px)',
        minHeight: 44,
        py: '4px',
        pl: '24px',
        pr: '6px',
        overflow: 'hidden',
        borderRadius: '8px',
        bgcolor: backgroundColor,
        boxShadow: '0 8px 24px rgba(149, 157, 165, 0.2)'
      }}
    >
      <Box
        component="svg"
        viewBox="0 0 18 40"
        preserveAspectRatio="none"
        aria-hidden="true"
        sx={{
          position: 'absolute',
          inset: '0 auto 0 0',
          width: 18,
          height: '100%',
          fill: softColor
        }}
      >
        <path d="M0 0H10Q18 5 10 10Q2 15 10 20Q18 25 10 30Q2 35 10 40H0Z" />
      </Box>
      <Box
        role="img"
        aria-label={label}
        sx={{
          display: 'grid',
          flex: '0 0 24px',
          placeItems: 'center',
          width: 24,
          height: 24,
          borderRadius: '50%',
          bgcolor: softColor,
          color,
          fontSize: 14
        }}
      >
        <Icon />
      </Box>
      <Typography
        sx={{
          flex: 1,
          minWidth: 0,
          py: '6px',
          color: '#555555',
          fontSize: 14,
          lineHeight: 1.4,
          overflowWrap: 'anywhere'
        }}
      >
        {notice.message}
      </Typography>
      {notice.action ? (
        <Button
          variant="text"
          size="small"
          onClick={() => {
            onClose()
            notice.action?.onClick()
          }}
          sx={{ flexShrink: 0, textTransform: 'none' }}
        >
          {notice.action.label}
        </Button>
      ) : null}
      <IconButton
        aria-label={appCopy.closeNotice}
        onClick={onClose}
        size="small"
        sx={{ flexShrink: 0, p: '4px', color: '#555555', '&:hover': { bgcolor: '#F2F2F2' } }}
      >
        <FiX size={16} />
      </IconButton>
    </Box>
  )
}

const AppSnackbarCard = forwardRef<HTMLDivElement, AppSnackbarCardProps>(AppSnackbarCardContent)

export default AppSnackbarCard
