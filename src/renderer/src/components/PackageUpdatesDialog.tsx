import { settingsUi } from '../features/settings/lib/settingsUi'
import { useUiLanguage } from '../lib/i18n'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  Divider,
  Stack,
  Typography
} from '@mui/material'
import type { PackageUpdateView } from '../../../shared/packageManagerTypes'
import { PACKAGE_TRUST_DESCRIPTIONS, PACKAGE_TRUST_LABELS } from '../lib/packageTrust'

export function PackageUpdatesDialog({
  open,
  updates,
  busyKey,
  error,
  onClose,
  onApply,
  onApplyAll
}: {
  open: boolean
  updates: readonly PackageUpdateView[]
  busyKey: string | null
  error: string | null
  onClose: () => void
  onApply: (update: PackageUpdateView) => void
  onApplyAll: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Dialog open={open} onClose={busyKey ? undefined : onClose} maxWidth="md" fullWidth>
      <Stack spacing={2} sx={{ p: 3 }}>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="h5">{settingsUi.contentPackageUpdates}</Typography>
            <Typography variant="body2" color="text.secondary">
              {settingsUi.updatesAreInstalledOnlyAfterYourConfirmation}
            </Typography>
          </Box>
          <Button
            variant="contained"
            disabled={updates.length === 0 || busyKey !== null}
            onClick={onApplyAll}
          >
            {busyKey === 'all' ? settingsUi.updatingAll : settingsUi.updateAll}
          </Button>
        </Stack>
        <Divider />
        {error ? <Alert severity="error">{error}</Alert> : null}
        {updates.length === 0 ? (
          <Typography color="text.secondary">{settingsUi.noUpdatesAvailable}</Typography>
        ) : (
          <Stack spacing={1.25}>
            {updates.map((update) => {
              const key = `${update.type}:${update.id}`
              return (
                <Stack
                  key={key}
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1.5}
                  sx={{
                    alignItems: { sm: 'center' },
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 2,
                    p: 2
                  }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 700 }}>{update.title}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {update.currentVersion} → {update.newVersion}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ overflowWrap: 'anywhere' }}
                    >
                      {update.registryPath}
                    </Typography>
                  </Box>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={PACKAGE_TRUST_LABELS[update.trust]}
                    title={PACKAGE_TRUST_DESCRIPTIONS[update.trust]}
                  />
                  <Button
                    variant="contained"
                    disabled={busyKey !== null}
                    onClick={() => onApply(update)}
                  >
                    {busyKey === key ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      settingsUi.update
                    )}
                  </Button>
                </Stack>
              )
            })}
          </Stack>
        )}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button disabled={busyKey !== null} onClick={onClose}>
            {settingsUi.close}
          </Button>
        </Box>
      </Stack>
    </Dialog>
  )
}
