import { useUiLanguage } from '../../lib/i18n'
import { Box, Button, Divider, Stack } from '@mui/material'

import { PhiIcons } from '../../icons'
import { resourceCatalogCopy } from '../../lib/resourceUi'

/**
 * The shared shell of a catalog entry's detail page. The top bar carries navigation and the
 * entry's install/uninstall control; identity chips belong to the content. A caller that renders
 * its own header below the bar can turn the default divider off with `headerDivider={false}`.
 */
export function CatalogDetailFrame({
  entryId,
  backLabel,
  action,
  headerDivider = true,
  onBack,
  children
}: {
  entryId: string
  backLabel: string
  /** The install / uninstall controls of the entry. */
  action: React.ReactNode
  /** The divider under the top bar belongs to the default shell. */
  headerDivider?: boolean
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
        sx={{ alignItems: 'center', justifyContent: 'space-between', px: 3, py: 2 }}
      >
        <Button
          size="small"
          aria-label={backLabel}
          onClick={onBack}
          startIcon={<PhiIcons.action.back size={16} sx={{ transform: 'rotate(180deg)' }} />}
        >
          {resourceCatalogCopy.back}
        </Button>
        {action}
      </Stack>
      {headerDivider ? <Divider data-phi-catalog-detail-divider="true" /> : null}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>{children}</Box>
    </Box>
  )
}
