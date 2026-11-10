import { useState } from 'react'
import { settingsUi } from '../features/settings/lib/settingsUi'
import { phiPluginDisplayTitle } from '../features/phi-plugin/lib/phiPlugins'
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
import type { PackageChangelogEntry, PackageUpdateView } from '../../../shared/packageManagerTypes'
import MarkdownContent from './MarkdownContent'
import { PACKAGE_TRUST_DESCRIPTIONS, PACKAGE_TRUST_LABELS } from '../lib/packageTrust'

const COLLAPSED_NOTE_LINES = 8
const COLLAPSED_NOTE_MAX_LENGTH = 640

function isLongNotes(notes: string): boolean {
  return (
    notes.length > COLLAPSED_NOTE_MAX_LENGTH ||
    notes.split('\n').filter((line) => line.trim()).length > COLLAPSED_NOTE_LINES
  )
}

function UpdateChange({
  change,
  showVersion
}: {
  change: PackageChangelogEntry
  showVersion: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const long = isLongNotes(change.notes)
  return (
    <Box>
      {showVersion ? (
        <Typography variant="subtitle2" component="h4" sx={{ mt: 1, fontWeight: 700 }}>
          {change.version}
        </Typography>
      ) : null}
      <Box sx={{ position: 'relative' }}>
        <Box
          sx={{
            maxHeight: expanded || !long ? undefined : 'calc(1.5em * 8)',
            overflow: expanded || !long ? undefined : 'hidden',
            fontSize: '0.875rem',
            lineHeight: 1.5,
            '& > :first-of-type': { mt: 0 },
            '& > :last-of-type': { mb: 0 }
          }}
        >
          <MarkdownContent text={change.notes} />
        </Box>
        {long && !expanded ? (
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              insetInline: 0,
              bottom: 0,
              height: '2.5em',
              pointerEvents: 'none',
              background: (theme) =>
                `linear-gradient(to bottom, transparent, ${theme.palette.background.paper})`
            }}
          />
        ) : null}
      </Box>
      {long ? (
        <Button size="small" sx={{ mt: 0.5 }} onClick={() => setExpanded((value) => !value)}>
          {expanded ? settingsUi.showLess : settingsUi.showMore}
        </Button>
      ) : null}
    </Box>
  )
}

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
              const changes = update.changes ?? []
              const title =
                update.type === 'plugin'
                  ? phiPluginDisplayTitle({ id: update.id, title: update.title })
                  : update.title
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
                    <Typography sx={{ fontWeight: 700 }}>{title}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {update.currentVersion} → {update.newVersion}
                    </Typography>
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                        {settingsUi.whatsNew}
                      </Typography>
                      {changes.length > 0 ? (
                        changes.map((change, index) => (
                          <UpdateChange
                            key={`${change.version}:${index}`}
                            change={change}
                            showVersion={changes.length > 1}
                          />
                        ))
                      ) : (
                        <>
                          <Typography variant="body2" color="text.secondary">
                            {settingsUi.noReleaseNotesForThisVersion}
                          </Typography>
                          {update.summary ? (
                            <Typography variant="body2" color="text.secondary">
                              {update.summary}
                            </Typography>
                          ) : null}
                        </>
                      )}
                    </Box>
                  </Box>
                  {update.trust !== 'imported' && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={PACKAGE_TRUST_LABELS[update.trust]}
                      title={PACKAGE_TRUST_DESCRIPTIONS[update.trust]}
                    />
                  )}
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
