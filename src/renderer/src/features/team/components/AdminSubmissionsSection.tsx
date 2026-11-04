import { Alert, Button, Chip, List, ListItem, Paper, Stack, Typography } from '@mui/material'
import type {
  TeamAdminSubmissionView,
  TeamSubmissionInvalidReasonCode
} from '../../../../../shared/teamPackTypes'

import { getUiLocale, useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'

function invalidReason(code: TeamSubmissionInvalidReasonCode | undefined): string {
  return teamCopy.invalidSubmissionReason[code ?? 'unknown']
}

// eslint-disable-next-line max-lines-per-function -- one review row keeps validation evidence beside its actions
export function AdminSubmissionsSection({
  submissions,
  busy,
  onRefresh,
  onImport,
  onAccept,
  onDelete
}: {
  submissions: TeamAdminSubmissionView[]
  busy: boolean
  onRefresh: () => void
  onImport: () => void
  onAccept: (submission: TeamAdminSubmissionView) => void
  onDelete: (submission: TeamAdminSubmissionView) => void
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
          <Typography variant="h6">{teamCopy.submissions}</Typography>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" disabled={busy} onClick={onRefresh}>
              {teamCopy.refreshSubmissions}
            </Button>
            <Button variant="outlined" disabled={busy} onClick={onImport}>
              {teamCopy.importSubmission}
            </Button>
          </Stack>
        </Stack>
        <Alert severity="warning" variant="filled">
          {teamCopy.submissionCodeReviewWarning}
        </Alert>
        {submissions.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {teamCopy.noSubmissions}
          </Typography>
        ) : (
          <List disablePadding>
            {submissions.map((submission, index) => (
              <ListItem
                key={submission.entryId}
                disableGutters
                divider={index < submissions.length - 1}
                alignItems="flex-start"
                sx={{ display: 'block', py: 1.5 }}
              >
                <Stack spacing={0.75}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Typography sx={{ fontWeight: 700 }}>
                      {submission.valid
                        ? teamCopy.submissionFromValue(submission.memberName ?? '—')
                        : teamCopy.invalidSubmission}
                    </Typography>
                    {!submission.valid ? (
                      <Chip size="small" color="error" label={teamCopy.invalidSubmission} />
                    ) : null}
                  </Stack>
                  {!submission.valid ? (
                    <Alert severity="error">
                      {invalidReason(submission.invalidReasonCode)}
                      {submission.invalidDetail ? ` ${submission.invalidDetail}` : ''}
                    </Alert>
                  ) : null}
                  {submission.packages.map((entry) => (
                    <Typography key={`${entry.type}:${entry.id}`} variant="body2">
                      {entry.type} · {entry.id} · {entry.version}
                    </Typography>
                  ))}
                  {submission.note ? (
                    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                      {submission.note}
                    </Typography>
                  ) : null}
                  <Typography variant="caption" color="text.secondary">
                    {submission.createdAt
                      ? new Intl.DateTimeFormat(getUiLocale(), {
                          dateStyle: 'medium',
                          timeStyle: 'short'
                        }).format(new Date(submission.createdAt))
                      : null}
                    {submission.createdAt ? ' · ' : null}
                    {teamCopy.submissionSizeValue(
                      new Intl.NumberFormat(getUiLocale(), {
                        style: 'unit',
                        unit: 'byte',
                        unitDisplay: 'short'
                      }).format(submission.bytes)
                    )}
                  </Typography>
                  <Stack direction="row" spacing={1}>
                    {submission.valid ? (
                      <Button
                        size="small"
                        variant="contained"
                        disabled={busy}
                        onClick={() => onAccept(submission)}
                      >
                        {teamCopy.acceptSubmission}
                      </Button>
                    ) : null}
                    <Button
                      size="small"
                      color="error"
                      disabled={busy}
                      onClick={() => onDelete(submission)}
                    >
                      {teamCopy.deleteSubmission}
                    </Button>
                  </Stack>
                </Stack>
              </ListItem>
            ))}
          </List>
        )}
      </Stack>
    </Paper>
  )
}
