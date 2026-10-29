import { Box, Collapse, IconButton, Typography } from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import { useMediaQuery } from '@mui/material'
import type { ReactNode } from 'react'

import { PhiIcons } from '../../../icons'

export type PlanTimelineTone = 'success' | 'active' | 'error' | 'pending' | 'neutral'

const SPIN = 'phi-plan-spin 0.9s linear infinite'
const ENTER = 'phi-plan-step-in 0.45s ease both'

function toneColors(theme: Theme, tone: PlanTimelineTone): { background: string; color: string } {
  if (tone === 'success') {
    return {
      background: alpha(theme.palette.success.main, 0.16),
      color: theme.palette.success.main
    }
  }
  if (tone === 'active') {
    return {
      background: alpha(theme.palette.primary.main, 0.14),
      color: theme.palette.primary.main
    }
  }
  if (tone === 'error') {
    return {
      background: alpha(theme.palette.error.main, 0.14),
      color: theme.palette.error.main
    }
  }
  if (tone === 'pending') {
    return { background: theme.palette.action.hover, color: theme.palette.text.disabled }
  }
  return { background: theme.palette.action.selected, color: theme.palette.text.secondary }
}

export function PlanTimelineIcon({
  tone,
  spinning = false,
  icon
}: {
  tone: PlanTimelineTone
  spinning?: boolean
  icon?: ReactNode
}): React.JSX.Element {
  const Icon =
    tone === 'success'
      ? PhiIcons.state.check
      : tone === 'active'
        ? PhiIcons.state.inProgress
        : tone === 'error'
          ? PhiIcons.state.warning
          : tone === 'pending'
            ? PhiIcons.state.pending
            : PhiIcons.state.thinking
  return (
    <Box
      aria-hidden
      sx={(theme) => {
        const colors = toneColors(theme, tone)
        return {
          position: 'relative',
          zIndex: 1,
          flex: 'none',
          width: 24,
          height: 24,
          mt: 0.25,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '50%',
          bgcolor: colors.background,
          color: colors.color,
          boxShadow: `0 0 0 4px ${theme.palette.background.paper}`,
          '@keyframes phi-plan-spin': { to: { transform: 'rotate(360deg)' } },
          '& .phi-plan-spin-icon': spinning
            ? {
                animation: SPIN,
                '@media (prefers-reduced-motion: reduce)': { animation: 'none' }
              }
            : undefined
        }
      }}
    >
      {icon ?? <Icon className={spinning ? 'phi-plan-spin-icon' : undefined} size={14} />}
    </Box>
  )
}

function PlanTimelineConnector(): React.JSX.Element {
  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        left: '11px',
        top: 28,
        bottom: -6,
        width: '2px',
        bgcolor: 'divider',
        zIndex: 0
      }}
    />
  )
}

function PlanTimelineStepTitle({
  title,
  meta,
  interactive,
  expanded,
  onToggle,
  toggleLabel
}: {
  title: string
  meta?: ReactNode
  interactive: boolean
  expanded?: boolean
  onToggle?: () => void
  toggleLabel?: string
}): React.JSX.Element {
  const ToggleIcon = expanded ? PhiIcons.action.collapse : PhiIcons.action.expand
  return (
    <Box
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={interactive ? expanded : undefined}
      aria-label={toggleLabel}
      onClick={interactive ? onToggle : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onToggle?.()
            }
          : undefined
      }
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        minWidth: 0,
        mx: -0.5,
        px: 0.5,
        py: 0.25,
        borderRadius: 1,
        cursor: interactive ? 'pointer' : 'default',
        '&:hover': interactive ? { bgcolor: 'action.hover' } : undefined
      }}
    >
      <Typography variant="body2" sx={{ minWidth: 0, flex: 1, fontWeight: 650 }}>
        {title}
      </Typography>
      {meta}
      {interactive ? <ToggleIcon size={16} aria-hidden /> : null}
    </Box>
  )
}

export function PlanTimelineStep({
  isLast,
  tone,
  index,
  dimmed = false,
  icon,
  title,
  meta,
  expanded,
  onToggle,
  toggleLabel,
  children
}: {
  isLast: boolean
  tone: PlanTimelineTone
  index: number
  dimmed?: boolean
  icon?: ReactNode
  title: string
  meta?: ReactNode
  expanded?: boolean
  onToggle?: () => void
  toggleLabel?: string
  children?: ReactNode
}): React.JSX.Element {
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const interactive = Boolean(onToggle && children)
  return (
    <Box sx={{ opacity: dimmed ? 0.62 : 1 }}>
      <Box
        sx={{
          position: 'relative',
          display: 'flex',
          gap: 1.5,
          animation: reduceMotion ? 'none' : ENTER,
          animationDelay: reduceMotion ? undefined : `${index * 70}ms`,
          '@keyframes phi-plan-step-in': {
            from: { opacity: 0, transform: 'translateY(-6px)' },
            to: { opacity: 1, transform: 'none' }
          },
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' }
        }}
      >
        {isLast ? null : <PlanTimelineConnector />}
        <PlanTimelineIcon tone={tone} spinning={tone === 'active' && !icon} icon={icon} />
        <Box sx={{ flex: 1, minWidth: 0, pb: isLast ? 0 : 2 }}>
          <PlanTimelineStepTitle
            title={title}
            meta={meta}
            interactive={interactive}
            expanded={expanded}
            onToggle={onToggle}
            toggleLabel={toggleLabel}
          />
          {children && onToggle ? (
            <Collapse in={expanded} timeout={reduceMotion ? 0 : 280} unmountOnExit={false}>
              <Box sx={{ pt: 0.75 }}>{children}</Box>
            </Collapse>
          ) : (
            children
          )}
        </Box>
      </Box>
    </Box>
  )
}

export function PlanTimelineHeader({
  tone,
  title,
  subtitle,
  expanded,
  expandLabel,
  onToggle,
  trailing
}: {
  tone: PlanTimelineTone
  title: string
  subtitle?: ReactNode
  expanded?: boolean
  expandLabel?: string
  onToggle?: () => void
  trailing?: ReactNode
}): React.JSX.Element {
  return (
    <Box
      onClick={onToggle}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        px: 1.75,
        py: 1.35,
        cursor: onToggle ? 'pointer' : 'default',
        bgcolor: expanded ? 'action.hover' : 'transparent',
        borderBottom: expanded ? 1 : 0,
        borderColor: 'divider',
        '&:hover': onToggle ? { bgcolor: 'action.hover' } : undefined
      }}
    >
      <PlanTimelineIcon tone={tone} spinning={tone === 'active'} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle2" noWrap title={title} sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        {subtitle ? (
          <Typography variant="caption" color="text.secondary" component="div">
            {subtitle}
          </Typography>
        ) : null}
      </Box>
      {trailing ? (
        <Box onClick={(event) => event.stopPropagation()} sx={{ display: 'flex', flexShrink: 0 }}>
          {trailing}
        </Box>
      ) : null}
      {onToggle ? (
        <IconButton
          size="small"
          aria-label={expandLabel}
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
          sx={{ color: 'text.secondary', flexShrink: 0 }}
        >
          {expanded ? (
            <PhiIcons.action.collapse size={18} aria-hidden />
          ) : (
            <PhiIcons.action.expand size={18} aria-hidden />
          )}
        </IconButton>
      ) : null}
    </Box>
  )
}
