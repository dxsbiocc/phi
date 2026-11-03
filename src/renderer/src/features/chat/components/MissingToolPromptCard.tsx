import {
  Alert,
  Box,
  Button,
  FormControlLabel,
  Paper,
  Radio,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useState } from 'react'

import type { AgentUserInteractionResponse } from '../../../types'
import { useUiLanguage } from '../../../lib/i18n'
import {
  missingToolPromptDraftForRequest,
  missingToolPromptResponse,
  reduceMissingToolPromptDraft,
  type MissingToolId,
  type MissingToolPromptChoice,
  type MissingToolPromptDraft,
  type MissingToolPromptDraftAction,
  type MissingToolPromptRequest
} from '../lib/missingToolPrompt'
import { missingToolPromptCopy } from '../lib/missingToolPromptCopy'

type MissingToolPromptCardProps = {
  request: MissingToolPromptRequest
  onRespond: (
    requestId: string,
    response: AgentUserInteractionResponse,
    cancelled?: boolean
  ) => void
}

const INSTALLABLE_TOOLS = new Set<MissingToolId>(['nextflow', 'java', 'jupyter'])

function SummaryRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(96px, auto) minmax(0, 1fr)', gap: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
        {label}
      </Typography>
      <Typography
        variant="caption"
        sx={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}
      >
        {value}
      </Typography>
    </Box>
  )
}

// One card owns the mutually exclusive candidate, manual-path, and reviewed-install states.
// eslint-disable-next-line max-lines-per-function
export function MissingToolPromptCard({
  request,
  onRespond
}: MissingToolPromptCardProps): React.JSX.Element {
  useUiLanguage()
  const [savedDraft, setSavedDraft] = useState<MissingToolPromptDraft | null>(null)
  const draft = missingToolPromptDraftForRequest(request.requestId, savedDraft)
  const install = INSTALLABLE_TOOLS.has(request.tool.id) ? request.install : undefined
  const enteredPath = draft.path.trim()

  const updateDraft = (action: MissingToolPromptDraftAction): void => {
    setSavedDraft((current) =>
      reduceMissingToolPromptDraft(
        missingToolPromptDraftForRequest(request.requestId, current),
        action
      )
    )
  }
  const respond = (choice: MissingToolPromptChoice): void => {
    const response = missingToolPromptResponse(request.requestId, request.tool.id, choice)
    onRespond(request.requestId, response, choice.kind === 'cancel')
  }

  return (
    <Paper
      variant="outlined"
      role="alert"
      aria-label={missingToolPromptCopy.requiredToolNotFoundValue(request.tool.label)}
      data-phi-missing-tool-prompt={request.tool.id}
      sx={{
        width: '100%',
        mb: 1,
        borderRadius: 2,
        p: 1.5,
        borderColor: 'warning.main',
        bgcolor: 'background.paper'
      }}
    >
      <Stack spacing={1.5}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {missingToolPromptCopy.requiredToolNotFound}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {missingToolPromptCopy.phiNeedsThisToolBeforeThePausedActionCanContinue}
            </Typography>
          </Box>
          <Button color="inherit" size="small" onClick={() => respond({ kind: 'cancel' })}>
            {missingToolPromptCopy.cancel}
          </Button>
        </Box>

        <SummaryRow label={missingToolPromptCopy.requiredTool} value={request.tool.label} />

        {!draft.reviewingInstall ? (
          <>
            <Stack spacing={0.75}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                {missingToolPromptCopy.foundCandidates}
              </Typography>
              {request.candidates.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {missingToolPromptCopy.noCandidatesFound}
                </Typography>
              ) : (
                request.candidates.map((candidate) => (
                  <Box
                    key={`${candidate.source}:${candidate.path}`}
                    sx={{
                      border: '1px solid',
                      borderColor:
                        draft.candidatePath === candidate.path ? 'primary.main' : 'divider',
                      borderRadius: 1.25,
                      bgcolor:
                        draft.candidatePath === candidate.path
                          ? 'action.selected'
                          : 'background.paper',
                      px: 0.75,
                      py: 0.25
                    }}
                  >
                    <FormControlLabel
                      control={
                        <Radio
                          size="small"
                          checked={draft.candidatePath === candidate.path}
                          onChange={() =>
                            updateDraft({ type: 'select-candidate', path: candidate.path })
                          }
                          slotProps={{
                            input: {
                              'aria-label': `${missingToolPromptCopy.chooseCandidate}: ${candidate.path}`
                            }
                          }}
                        />
                      }
                      label={
                        <Box sx={{ minWidth: 0, py: 0.35 }}>
                          <Typography
                            variant="body2"
                            sx={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}
                          >
                            {candidate.path}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {missingToolPromptCopy.source[candidate.source]}
                            {candidate.version ? ` · ${candidate.version}` : ''}
                          </Typography>
                        </Box>
                      }
                      sx={{ alignItems: 'flex-start', m: 0, width: '100%' }}
                    />
                  </Box>
                ))
              )}
              <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                  size="small"
                  variant="contained"
                  disabled={!draft.candidatePath}
                  onClick={() =>
                    draft.candidatePath && respond({ kind: 'candidate', path: draft.candidatePath })
                  }
                >
                  {missingToolPromptCopy.useSelectedCandidate}
                </Button>
              </Box>
            </Stack>

            <Stack spacing={0.75}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                {missingToolPromptCopy.enterAPath}
              </Typography>
              {request.rejectedPath ? (
                <Alert severity="warning" variant="outlined" sx={{ py: 0 }}>
                  {missingToolPromptCopy.pathNotAccepted(request.rejectedPath.path)}{' '}
                  {missingToolPromptCopy.rejectReason[request.rejectedPath.reason]}
                </Alert>
              ) : null}
              <TextField
                fullWidth
                size="small"
                label={missingToolPromptCopy.environmentFolderOrAbsoluteExecutablePath}
                helperText={missingToolPromptCopy.pathHelp}
                value={draft.path}
                onChange={(event) => updateDraft({ type: 'enter-path', path: event.target.value })}
              />
              <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                  size="small"
                  variant="contained"
                  disabled={!enteredPath}
                  onClick={() => respond({ kind: 'path', path: enteredPath })}
                >
                  {missingToolPromptCopy.useThisPath}
                </Button>
              </Box>
            </Stack>
          </>
        ) : null}

        {install ? (
          <Box
            sx={{
              border: '1px solid',
              borderColor: draft.reviewingInstall ? 'warning.main' : 'divider',
              borderRadius: 1.25,
              p: 1.25
            }}
          >
            <Stack spacing={0.75}>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                {missingToolPromptCopy.installANewEnvironment}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {missingToolPromptCopy.installIsNeverAutomatic}
              </Typography>
              <SummaryRow label={missingToolPromptCopy.environment} value={install.environment} />
              <SummaryRow label={missingToolPromptCopy.what} value={install.packages.join(', ')} />
              <SummaryRow label={missingToolPromptCopy.where} value={install.location} />
              <SummaryRow
                label={missingToolPromptCopy.approximateSize}
                value={install.approximateSize}
              />
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
                {draft.reviewingInstall ? (
                  <>
                    <Button size="small" onClick={() => updateDraft({ type: 'close-install' })}>
                      {missingToolPromptCopy.back}
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      color="warning"
                      onClick={() => respond({ kind: 'install' })}
                    >
                      {missingToolPromptCopy.confirmInstallation}
                    </Button>
                  </>
                ) : (
                  <Button size="small" onClick={() => updateDraft({ type: 'review-install' })}>
                    {missingToolPromptCopy.reviewInstallation}
                  </Button>
                )}
              </Box>
            </Stack>
          </Box>
        ) : null}
      </Stack>
    </Paper>
  )
}
