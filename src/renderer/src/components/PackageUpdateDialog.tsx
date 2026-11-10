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

/** One package update, opened from that package's message. */
export function PackageUpdateDialog({
  open,
  update,
  busy,
  error,
  onClose,
  onApply
}: {
  open: boolean
  update: PackageUpdateView | null
  busy: boolean
  error: string | null
  onClose: () => void
  onApply: (update: PackageUpdateView) => void
}): React.JSX.Element {
  useUiLanguage()
  const changes = update?.changes ?? []
  const title =
    update === null
      ? ''
      : update.type === 'plugin'
        ? phiPluginDisplayTitle({ id: update.id, title: update.title })
        : update.title
  return (
    <Dialog
      open={open && update !== null}
      onClose={busy ? undefined : onClose}
      maxWidth="md"
      fullWidth
    >
      {update ? (
        <Stack spacing={2} sx={{ p: 3 }}>
          <Box>
            <Typography variant="overline" color="text.secondary">
              {settingsUi.contentPackageUpdate}
            </Typography>
            <Typography variant="h5">{title}</Typography>
            <Typography variant="body2" color="text.secondary">
              {update.currentVersion} → {update.newVersion}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {settingsUi.updatesAreInstalledOnlyAfterYourConfirmation}
            </Typography>
          </Box>
          <Divider />
          {error ? <Alert severity="error">{error}</Alert> : null}
          <Box>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
              <Typography variant="subtitle2" sx={{ flex: 1, fontWeight: 700 }}>
                {settingsUi.whatsNew}
              </Typography>
              {update.trust !== 'imported' && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={PACKAGE_TRUST_LABELS[update.trust]}
                  title={PACKAGE_TRUST_DESCRIPTIONS[update.trust]}
                />
              )}
            </Stack>
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
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
            <Button disabled={busy} onClick={onClose}>
              {settingsUi.close}
            </Button>
            <Button variant="contained" disabled={busy} onClick={() => onApply(update)}>
              {busy ? <CircularProgress size={16} color="inherit" /> : settingsUi.update}
            </Button>
          </Box>
        </Stack>
      ) : null}
    </Dialog>
  )
}
