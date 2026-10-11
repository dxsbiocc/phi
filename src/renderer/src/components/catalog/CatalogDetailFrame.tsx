import { Box, Button, Stack } from '@mui/material'

import { PhiIcons } from '../../icons'

/**
 * The shared shell of a catalog entry's detail page. The top bar only carries navigation and the
 * entry's install/uninstall control; its name and chips belong to the content.
 */
export function CatalogDetailFrame({
  entryId,
  backLabel,
  action,
  onBack,
  children
}: {
  entryId: string
  backLabel: string
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
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: 'center', justifyContent: 'space-between', px: 3, py: 2 }}
      >
        <Button
          size="small"
          aria-label={backLabel}
          onClick={onBack}
          startIcon={<PhiIcons.action.back size={16} sx={{ transform: 'rotate(180deg)' }} />}
        >
          返回
        </Button>
        {action}
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', borderTop: 1, borderColor: 'divider' }}>
        {children}
      </Box>
    </Box>
  )
}
