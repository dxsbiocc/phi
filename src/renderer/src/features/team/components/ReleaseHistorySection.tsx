import {
  Alert,
  Button,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Typography
} from '@mui/material'
import type { TeamAdminRelease } from '../../../../../shared/teamPackTypes'

import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import { getUiLocale, useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'

export function ReleaseHistorySection({
  releases,
  onWithdraw
}: {
  releases: TeamAdminRelease[]
  onWithdraw: (release: TeamAdminRelease) => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
      <Stack spacing={1.5}>
        <Typography variant="h6">{teamCopy.versionHistory}</Typography>
        {releases.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {teamCopy.noReleaseHistory}
          </Typography>
        ) : (
          <List disablePadding>
            {[...releases].reverse().map((release, index) => (
              <ListItem
                key={release.release}
                disableGutters
                divider={index < releases.length - 1}
                secondaryAction={
                  release.withdrawn ? (
                    <Chip size="small" label={teamCopy.withdrawn} />
                  ) : (
                    <Button color="error" onClick={() => onWithdraw(release)}>
                      {teamCopy.withdraw}
                    </Button>
                  )
                }
              >
                <ListItemText
                  primary={teamCopy.versionValue(release.release)}
                  secondary={`${new Intl.DateTimeFormat(getUiLocale(), {
                    dateStyle: 'medium',
                    timeStyle: 'short'
                  }).format(new Date(release.publishedAt))} · ${teamCopy.recipientsValue(
                    release.memberIds.length
                  )}`}
                />
              </ListItem>
            ))}
          </List>
        )}
      </Stack>
    </Paper>
  )
}

export function WithdrawReleaseDialog({
  release,
  busy,
  onClose,
  onConfirm
}: {
  release: TeamAdminRelease | null
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <ConfirmationDialog open={release !== null} onClose={busy ? undefined : onClose}>
      <DialogTitle>{release ? teamCopy.withdrawTitle(release.release) : ''}</DialogTitle>
      <DialogContent>
        <Alert severity="warning">{teamCopy.withdrawWarning}</Alert>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{teamCopy.cancel}</Button>
        <Button color="error" variant="contained" disabled={busy} onClick={onConfirm}>
          {teamCopy.withdraw}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
