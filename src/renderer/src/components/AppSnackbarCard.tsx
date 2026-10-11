import { forwardRef, type CSSProperties } from 'react'
import { Box, IconButton, Typography } from '@mui/material'
import { FiAlertTriangle, FiCheckCircle, FiInfo, FiX, FiXCircle } from 'react-icons/fi'

export type SnackbarSeverity = 'error' | 'info' | 'success' | 'warning'
export type SnackbarNotice = {
  id: number
  severity: SnackbarSeverity
  message: string
  persistent?: boolean
}

const appearance = {
  info: {
    label: '提示',
    color: '#2455E8',
    softColor: '#D4DFFF',
    backgroundColor: '#F2F5FF',
    Icon: FiInfo
  },
  success: {
    label: '成功',
    color: '#16834A',
    softColor: '#D4F3E1',
    backgroundColor: '#F1FBF5',
    Icon: FiCheckCircle
  },
  warning: {
    label: '警告',
    color: '#B76D00',
    softColor: '#FFE6C1',
    backgroundColor: '#FFF8EA',
    Icon: FiAlertTriangle
  },
  error: {
    label: '错误',
    color: '#C81919',
    softColor: '#FFD2D0',
    backgroundColor: '#FFF3F3',
    Icon: FiXCircle
  }
} satisfies Record<
  SnackbarSeverity,
  { label: string; color: string; softColor: string; backgroundColor: string; Icon: typeof FiInfo }
>

type AppSnackbarCardProps = {
  notice: SnackbarNotice
  onClose: () => void
  style?: CSSProperties
}

const AppSnackbarCard = forwardRef<HTMLDivElement, AppSnackbarCardProps>(function AppSnackbarCard(
  { notice, onClose, style },
  ref
): React.JSX.Element {
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
      <IconButton
        aria-label="关闭通知"
        onClick={onClose}
        size="small"
        sx={{ flexShrink: 0, p: '4px', color: '#555555', '&:hover': { bgcolor: '#F2F2F2' } }}
      >
        <FiX size={16} />
      </IconButton>
    </Box>
  )
})

export default AppSnackbarCard
