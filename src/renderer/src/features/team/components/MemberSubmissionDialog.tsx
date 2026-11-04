import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  List,
  ListItem,
  ListItemText,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import type {
  TeamSubmissionCandidate,
  TeamSubmissionDeliveryResult
} from '../../../../../shared/teamPackTypes'

import { useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'
import { teamErrorText } from '../lib/teamErrors'
import { packageSelectionKey } from '../lib/teamPackages'

const MAX_NOTE_LENGTH = 1_000

// eslint-disable-next-line max-lines-per-function -- selection, note, and delivery result form one submission transaction
export function MemberSubmissionDialog({
  open,
  teamName,
  candidates,
  selected,
  note,
  busy,
  errorCode,
  result,
  onToggle,
  onNoteChange,
  onClose,
  onSubmit
}: {
  open: boolean
  teamName: string
  candidates: TeamSubmissionCandidate[]
  selected: string[]
  note: string
  busy: boolean
  errorCode: string | null
  result: TeamSubmissionDeliveryResult | null
  onToggle: (candidate: TeamSubmissionCandidate) => void
  onNoteChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}): React.JSX.Element {
  useUiLanguage()
  const selectedSet = new Set(selected)
  const noteLength = [...note].length
  const error = teamErrorText(errorCode)
  const canSubmit = selected.length > 0 && noteLength <= MAX_NOTE_LENGTH && !busy && !result

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{teamCopy.submissionTitle(teamName)}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Alert severity="info">{teamCopy.submissionHint}</Alert>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {result ? (
            <Alert severity="success">
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                {result.delivery === 'directory'
                  ? teamCopy.submissionDelivered
                  : teamCopy.submissionExported}
              </Typography>
              <Typography component="code" variant="caption" sx={{ overflowWrap: 'anywhere' }}>
                {result.path}
              </Typography>
            </Alert>
          ) : null}
          <div>
            <Typography variant="subtitle2">{teamCopy.submissionResources}</Typography>
            {candidates.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {busy ? teamCopy.loading : teamCopy.noSubmissionResources}
              </Typography>
            ) : (
              <List disablePadding>
                {candidates.map((candidate) => {
                  const key = packageSelectionKey(candidate)
                  return (
                    <ListItem key={key} disableGutters divider sx={{ display: 'block' }}>
                      <FormControlLabel
                        disabled={!candidate.canSubmit || busy || Boolean(result)}
                        sx={{ m: 0, width: '100%' }}
                        control={
                          <Checkbox
                            checked={selectedSet.has(key)}
                            onChange={() => onToggle(candidate)}
                          />
                        }
                        label={
                          <ListItemText
                            primary={candidate.title}
                            secondary={`${candidate.type} · ${candidate.version}`}
                          />
                        }
                      />
                      {!candidate.canSubmit ? (
                        <Typography variant="caption" color="warning.dark" sx={{ pl: 4 }}>
                          {teamCopy.submissionTeamOnlyReason}
                        </Typography>
                      ) : null}
                    </ListItem>
                  )
                })}
              </List>
            )}
          </div>
          <TextField
            multiline
            minRows={3}
            label={teamCopy.submissionNote}
            placeholder={teamCopy.submissionNotePlaceholder}
            value={note}
            disabled={Boolean(result)}
            error={noteLength > MAX_NOTE_LENGTH}
            helperText={teamCopy.submissionNoteHelp(noteLength, MAX_NOTE_LENGTH)}
            onChange={(event) => onNoteChange(event.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{result ? teamCopy.done : teamCopy.cancel}</Button>
        {!result ? (
          <Button variant="contained" disabled={!canSubmit} onClick={onSubmit}>
            {teamCopy.submitAction}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  )
}
