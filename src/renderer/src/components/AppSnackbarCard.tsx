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
    title: '提示',
    color: '#2455E8',
    softColor: '#D4DFFF',
    backgroundColor: '#F2F5FF',
    Icon: FiInfo
  },
  success: {
    title: '成功',
    color: '#16834A',
    softColor: '#D4F3E1',
    backgroundColor: '#F1FBF5',
    Icon: FiCheckCircle
  },
  warning: {
    title: '警告',
    color: '#B76D00',
    softColor: '#FFE6C1',
    backgroundColor: '#FFF8EA',
    Icon: FiAlertTriangle
  },
  error: {
    title: '错误',
    color: '#C81919',
    softColor: '#FFD2D0',
    backgroundColor: '#FFF3F3',
    Icon: FiXCircle
  }
} satisfies Record<
  SnackbarSeverity,
  { title: string; color: string; softColor: string; backgroundColor: string; Icon: typeof FiInfo }
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
  const { title, color, softColor, backgroundColor, Icon } = appearance[notice.severity]

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
        gap: '15px',
        boxSizing: 'border-box',
        width: 600,
        maxWidth: 'calc(100% - 32px)',
        minHeight: 80,
        py: '10px',
        pl: '23px',
        pr: '10px',
        overflow: 'hidden',
        borderRadius: '8px',
        bgcolor: backgroundColor,
        boxShadow: '0 8px 24px rgba(149, 157, 165, 0.2)'
      }}
    >
      <Box
        component="svg"
        viewBox="0 0 18 80"
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
        <path d="M0 0H10Q18 5 10 10Q2 15 10 20Q18 25 10 30Q2 35 10 40Q18 45 10 50Q2 55 10 60Q18 65 10 70Q2 75 10 80H0Z" />
      </Box>
      <Box
        aria-hidden="true"
        sx={{
          display: 'grid',
          flex: '0 0 35px',
          placeItems: 'center',
          width: 35,
          height: 35,
          borderRadius: '50%',
          bgcolor: softColor,
          color,
          fontSize: 17
        }}
      >
        <Icon />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ color, fontSize: 17, fontWeight: 700, lineHeight: 1.3 }}>
          {title}
        </Typography>
        <Typography
          sx={{ color: '#555555', fontSize: 14, lineHeight: 1.4, overflowWrap: 'anywhere' }}
        >
          {notice.message}
        </Typography>
      </Box>
      <IconButton
        aria-label="关闭通知"
        onClick={onClose}
        size="small"
        sx={{ flexShrink: 0, color: '#555555', '&:hover': { bgcolor: '#F2F2F2' } }}
      >
        <FiX size={18} />
      </IconButton>
    </Box>
  )
})

export default AppSnackbarCard
