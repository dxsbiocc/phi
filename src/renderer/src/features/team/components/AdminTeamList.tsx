import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import type { TeamAdminListItem, TeamCreatedAdminTeam } from '../../../../../shared/teamPackTypes'

import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'

const CopyIcon = PhiIcons.action.copy

export function AdminTeamList({
  teams,
  selectedTeamId,
  onSelect,
  onCreate,
  onRestore,
  onCopyFingerprint
}: {
  teams: TeamAdminListItem[]
  selectedTeamId: string | null
  onSelect: (team: TeamAdminListItem) => void
  onCreate: () => void
  onRestore: () => void
  onCopyFingerprint: (fingerprint: string) => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
      <Stack spacing={1.5}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' } }}
        >
          <Typography variant="h6">{teamCopy.managedTeams}</Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
            <Button variant="contained" onClick={onCreate}>
              {teamCopy.createTeam}
            </Button>
            <Button variant="outlined" onClick={onRestore}>
              {teamCopy.restoreTeam}
            </Button>
          </Stack>
        </Stack>
        {teams.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {teamCopy.noManagedTeams}
          </Typography>
        ) : (
          <List disablePadding>
            {teams.map((team) => (
              <ListItemButton
                key={team.teamId}
                selected={team.teamId === selectedTeamId}
                onClick={() => onSelect(team)}
                sx={{ borderRadius: 1 }}
              >
                <ListItemText
                  primary={team.name}
                  secondary={
                    <Typography
                      component="code"
                      variant="caption"
                      sx={{ overflowWrap: 'anywhere' }}
                    >
                      {team.publicKeyFingerprint}
                    </Typography>
                  }
                />
                <Tooltip title={teamCopy.copyFingerprint}>
                  <IconButton
                    aria-label={teamCopy.copyFingerprint}
                    onClick={(event) => {
                      event.stopPropagation()
                      onCopyFingerprint(team.publicKeyFingerprint)
                    }}
                  >
                    <CopyIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </ListItemButton>
            ))}
          </List>
        )}
      </Stack>
    </Paper>
  )
}

export function CreatedTeamBackupDialog({
  team,
  onCopy,
  onExport,
  onClose
}: {
  team: TeamCreatedAdminTeam | null
  onCopy: () => void
  onExport: () => void
  onClose: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Dialog open={team !== null} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{teamCopy.teamCreated}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Alert severity="warning">{teamCopy.signingKeyBackupWarning}</Alert>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {team?.name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {teamCopy.publicKeyFingerprint}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Typography component="code" variant="body2" sx={{ flex: 1, overflowWrap: 'anywhere' }}>
              {team?.publicKeyFingerprint}
            </Typography>
            <Tooltip title={teamCopy.copyFingerprint}>
              <IconButton aria-label={teamCopy.copyFingerprint} onClick={onCopy}>
                <CopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{teamCopy.done}</Button>
        <Button variant="contained" onClick={onExport}>
          {teamCopy.backupSigningKeyNow}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
