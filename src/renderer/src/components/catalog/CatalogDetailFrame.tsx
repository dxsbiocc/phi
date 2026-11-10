import { useUiLanguage } from '../../lib/i18n'
import { Box, Button, Stack } from '@mui/material'

import { PhiIcons } from '../../icons'
import { resourceCatalogCopy } from '../../lib/resourceUi'

/**
 * The shared shell of a catalog entry's detail page. The top bar carries navigation, an optional
 * heading and the entry's install/uninstall control; identity chips belong to the content.
 */
export function CatalogDetailFrame({
  entryId,
  backLabel,
  title,
  action,
  onBack,
  children
}: {
  entryId: string
  backLabel: string
  /** Optional entry heading shown in the top bar, right after the back button. */
  title?: React.ReactNode
  /** The install / uninstall controls of the entry. */
  action: React.ReactNode
  onBack: () => void
  children: React.ReactNode
}): React.JSX.Element {
  useUiLanguage()

  return (
    <Box
      data-phi-catalog-detail={entryId}
      sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        sx={{
          alignItems: 'center',
          justifyContent: title ? 'flex-start' : 'space-between',
          px: 3,
          py: 2
        }}
      >
        <Button
          size="small"
          aria-label={backLabel}
          onClick={onBack}
          startIcon={<PhiIcons.action.back size={16} sx={{ transform: 'rotate(180deg)' }} />}
        >
          {resourceCatalogCopy.back}
        </Button>
        {title ? (
          <>
            <Box data-phi-catalog-detail-title="true">{title}</Box>
            <Box sx={{ flex: 1 }} />
          </>
        ) : null}
        {action}
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', borderTop: 1, borderColor: 'divider' }}>
        {children}
      </Box>
    </Box>
  )
}
