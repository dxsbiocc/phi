import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { wrapperCopy } from '../lib/wrapperCopy'
import { Alert, Chip, FormControlLabel, Stack, Switch, Typography } from '@mui/material'

import type { WrapperCompositionCatalogItem } from '../../../../../shared/wrapperCompositionManifestTypes'

export interface WrapperPackageControlProps {
  wrapper: WrapperCompositionCatalogItem
  busy?: boolean
  onSetEnabled?: (packageId: string, enabled: boolean) => void
}

/** Package ownership and enablement stay separate from the large wrapper detail view. */
export function WrapperPackageControl({
  wrapper,
  busy = false,
  onSetEnabled
}: WrapperPackageControlProps): React.JSX.Element {
  useUiLanguage()
  if (!wrapper.packageId) {
    return <Chip size="small" variant="outlined" label={wrapperCopy.userDefined} />
  }

  const packageId = wrapper.packageId
  const enabled = wrapper.packageEnabled !== false
  return (
    <Stack spacing={1.25}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip
          size="small"
          variant="outlined"
          label={wrapperCopy.packageLabel(packageId)}
          sx={{ fontFamily: 'var(--font-mono)' }}
        />
        <FormControlLabel
          sx={{ m: 0 }}
          control={
            <Switch
              size="small"
              checked={enabled}
              disabled={busy || !onSetEnabled}
              onChange={(_event, checked) => onSetEnabled?.(packageId, checked)}
              slotProps={{ input: { 'aria-label': wrapperCopy.enablePackage(packageId) } }}
            />
          }
          label={
            <Typography variant="caption" color="text.secondary">
              {enabled ? resourceUi.enabled : resourceUi.disabled}
            </Typography>
          }
        />
      </Stack>
      {wrapper.hiddenReason ? <Alert severity="warning">{wrapper.hiddenReason}</Alert> : null}
    </Stack>
  )
}
