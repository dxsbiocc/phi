import { Box, Button, Stack, Typography } from '@mui/material'

import { PhiIcons } from '../../icons'

/** The shared shell of a catalog entry's detail page: back, identity, chips, action, body. */
export function CatalogDetailFrame({
  entryId,
  backLabel,
  icon,
  title,
  chips,
  action,
  onBack,
  children
}: {
  entryId: string
  backLabel: string
  icon: React.ReactNode
  title: string
  chips?: React.ReactNode
  /** The install / uninstall controls of the entry. */
  action: React.ReactNode
  onBack: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Box
      data-phi-catalog-detail={entryId}
      sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', px: 3, py: 2 }}>
        <Button
          size="small"
          aria-label={backLabel}
          onClick={onBack}
          startIcon={<PhiIcons.action.back size={16} sx={{ transform: 'rotate(180deg)' }} />}
        >
          返回
        </Button>
        {icon}
        <Typography variant="h6" noWrap sx={{ flex: 1, minWidth: 0 }} title={title}>
          {title}
        </Typography>
        {chips}
        {action}
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', borderTop: 1, borderColor: 'divider' }}>
        {children}
      </Box>
    </Box>
  )
}
