import { chatCopy } from '../lib/chatCopy'
import { alpha, type Theme } from '@mui/material/styles'
import { useUiLanguage } from '../../../lib/i18n'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Select,
  Stack,
  Typography
} from '@mui/material'
import { useState } from 'react'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import type {
  RuntimeRecoveryApi,
  RuntimeRecoveryState,
  RuntimeRecoveryTarget,
  RuntimeSummaryContinuation
} from '../../../../../shared/runtimeRecoveryTypes'
import { useRuntimeRecovery } from '../hooks/useRuntimeRecovery'
import { runtimeRecoveryViewKey, selectedRecoveryModel } from '../lib/runtimeRecoveryState'

// App places the banner in a floating column matching the composer; it fills that column.
const bannerWidthSx = {
  mx: 0,
  boxShadow: 3,
  // Slightly see-through, blurring the messages beneath so the text stays readable.
  bgcolor: (theme: Theme) => alpha(theme.palette.background.paper, 0.82),
  backdropFilter: 'blur(8px)',
  // Let the message fill the banner so its action row can sit at the bottom right.
  '& .MuiAlert-message': { flex: 1, minWidth: 0 }
} as const

export function RuntimeRecoveryBanner({
  api,
  target,
  models = [],
  onRecovered,
  onSummaryCreated
}: {
  api: RuntimeRecoveryApi
  target: RuntimeRecoveryTarget | null
  models?: readonly { providerId: string; modelId: string; name?: string }[]
  onRecovered?: (state: RuntimeRecoveryState) => void | Promise<void>
  onSummaryCreated?: (result: RuntimeSummaryContinuation) => void | Promise<void>
}): React.JSX.Element | null {
  useUiLanguage()
  const recovery = useRuntimeRecovery(api, target, onRecovered, onSummaryCreated)
  const viewKey = runtimeRecoveryViewKey(target)
  const [selection, setSelection] = useState({ viewKey: '', summaryOpen: false, replacement: '' })
  const summaryOpen = selection.viewKey === viewKey && selection.summaryOpen
  const replacement = selection.viewKey === viewKey ? selection.replacement : ''
  const updateSelection = (patch: Partial<typeof selection>): void =>
    setSelection({ viewKey, summaryOpen, replacement, ...patch })
  const state = recovery.state
  if (!state)
    return recovery.error ? (
      <Alert
        severity="warning"
        action={<Button onClick={() => void recovery.refresh()}>{chatCopy.refreshStatus}</Button>}
        sx={{ ...bannerWidthSx, my: 1 }}
      >
        {recovery.error}
      </Alert>
    ) : null
  if (state.phase === 'not-started') return null
  if (state.phase === 'connected')
    return recovery.error ? (
      <Alert severity="warning" sx={{ ...bannerWidthSx, my: 1 }}>
        <Typography variant="body2">
          {chatCopy.conversationConnectedReopenItToRefreshItsContents}
        </Typography>
        <Typography variant="caption">{recovery.error}</Typography>
      </Alert>
    ) : null
  const busy = recovery.pending || state.phase === 'busy'
  const chosen = selectedRecoveryModel(replacement, models)
  const needsModel = state.issue === 'model-unavailable'
  return (
    <>
      <Alert
        severity={
          state.issue === 'journal-invalid' || state.issue === 'binding-changed'
            ? 'error'
            : 'warning'
        }
        variant="outlined"
        sx={{ ...bannerWidthSx, my: 1, flexShrink: 0 }}
      >
        <Stack spacing={1}>
          <Typography variant="body2">{state.message}</Typography>
          {recovery.error ? (
            <Typography variant="caption" color="error">
              {recovery.error}
            </Typography>
          ) : null}
          {needsModel ? (
            <Select
              size="small"
              value={replacement}
              displayEmpty
              disabled={busy}
              inputProps={{ 'aria-label': chatCopy.chooseAReplacementModel }}
              onChange={(event) => updateSelection({ replacement: event.target.value })}
            >
              <MenuItem value="" disabled>
                {chatCopy.chooseAnAvailableReplacementModel}
              </MenuItem>
              {models.map((model) => (
                <MenuItem
                  key={JSON.stringify([model.providerId, model.modelId])}
                  value={JSON.stringify([model.providerId, model.modelId])}
                >
                  {model.name ?? model.modelId} · {model.providerId}
                </MenuItem>
              ))}
            </Select>
          ) : null}
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', justifyContent: 'flex-end' }}
          >
            {busy ? <CircularProgress size={14} /> : null}
            <Button
              size="small"
              disabled={busy || !state.canResume || (needsModel && !chosen)}
              onClick={() => void recovery.resume(chosen)}
            >
              {chatCopy.recoverOriginalConversation}
            </Button>
            {state.summary ? (
              <Button
                size="small"
                disabled={busy}
                onClick={() => updateSelection({ summaryOpen: true })}
              >
                {chatCopy.reviewSummaryAndCreateNew}
              </Button>
            ) : null}
            <Button size="small" disabled={busy} onClick={() => void recovery.refresh()}>
              {chatCopy.refreshStatus}
            </Button>
          </Stack>
        </Stack>
      </Alert>
      <ConfirmationDialog
        open={summaryOpen && Boolean(state.summary)}
        onClose={() => {
          if (!busy) updateSelection({ summaryOpen: false })
        }}
      >
        <DialogTitle>{chatCopy.createAConversationFromALocalSummary}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {chatCopy.theOldConversationIsPreservedTheNewConversationWillNot}
          </Typography>
          <Box
            component="pre"
            sx={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              maxHeight: 320,
              overflow: 'auto',
              font: 'inherit',
              bgcolor: 'action.hover',
              p: 1.5,
              borderRadius: 1
            }}
          >
            {state.summary?.content}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => updateSelection({ summaryOpen: false })}>
            {chatCopy.cancel}
          </Button>
          <Button
            disabled={busy || state.canContinueFromSummary === false}
            onClick={() => void recovery.continueFromSummary()}
          >
            {chatCopy.createConversationFromThisSummary}
          </Button>
        </DialogActions>
      </ConfirmationDialog>
    </>
  )
}
