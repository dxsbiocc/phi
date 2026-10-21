import { Box, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { GoCheck } from 'react-icons/go'

const connectorCatalogCardSx = {
  minWidth: 0,
  minHeight: 108,
  p: 1.75,
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: 2,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 1.5,
  cursor: 'pointer',
  '&:hover': { bgcolor: 'action.hover' }
} as const

/** Shared catalog card shell for built-in and custom connectors. */
export function ConnectorCatalogCardFrame({
  icon,
  title,
  description,
  children,
  trailing,
  onOpen,
  configured = false
}: {
  icon: React.ReactNode
  title: string
  description: string
  children?: React.ReactNode
  trailing?: React.ReactNode
  onOpen?: () => void
  configured?: boolean
}): React.JSX.Element {
  const interactive = Boolean(onOpen)
  return (
    <Box
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={(event) => {
        if (
          interactive &&
          event.target === event.currentTarget &&
          (event.key === 'Enter' || event.key === ' ')
        ) {
          event.preventDefault()
          onOpen?.()
        }
      }}
      onClick={onOpen}
      data-phi-connector-configured={configured}
      sx={{
        ...connectorCatalogCardSx,
        cursor: interactive ? 'pointer' : 'default',
        '&:hover': interactive ? { bgcolor: 'action.hover' } : undefined
      }}
    >
      {icon}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography noWrap title={title} sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        <Typography
          noWrap
          title={description}
          variant="body2"
          color="text.secondary"
          sx={{ mt: 0.25 }}
        >
          {description}
        </Typography>
        {children}
      </Box>
      {trailing}
    </Box>
  )
}

export function ConnectorAddedMark({ label }: { label: string }): React.JSX.Element {
  return (
    <Box
      role="img"
      aria-label={label}
      data-phi-connector-state="added"
      sx={{
        width: 34,
        height: 34,
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
        borderRadius: 1.5,
        color: 'success.dark',
        bgcolor: (theme) =>
          alpha(theme.palette.success.main, theme.palette.mode === 'dark' ? 0.28 : 0.16)
      }}
    >
      <GoCheck size={20} aria-hidden="true" />
    </Box>
  )
}
