import { terminalUi } from '../lib/terminalUi'
import { useUiLanguage } from '../../../lib/i18n'
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  TextField,
  Typography
} from '@mui/material'
import type { KeyboardEvent } from 'react'

import type { TerminalDraftState } from '../hooks/useTerminalDraft'
import {
  missingTerminalDraftInputs,
  substituteTerminalDraftInputs,
  terminalDraftSelectionBoundary
} from '../lib/terminalDraft'

export interface TerminalAssistPanelProps {
  state: TerminalDraftState
  targetLabel: string
  targetOpen: boolean
  currentLineDirty: boolean
  generationBusy: boolean
  onRequestChange(value: string): void
  onSelectionChange(value: string | undefined): void
  onCommandChange(value: string): void
  onInputChange(name: string, value: string): void
  onReadyForDirtyLineChange(value: boolean): void
  onGenerate(): void
  onCancelGeneration(): void
  onCopy(source: string): void
  onSend(source: string): void
  onClose(): void
}

export function TerminalAssistPanel(props: TerminalAssistPanelProps): React.JSX.Element {
  useUiLanguage()
  const { state } = props
  const requiredInputs = state.draft?.requiredInputs ?? []
  const preview = substituteTerminalDraftInputs(state.command, requiredInputs, state.inputValues)
  const missingInputs = missingTerminalDraftInputs(requiredInputs, state.inputValues)
  const selectionBoundary = state.selection ? terminalDraftSelectionBoundary(state.selection) : null
  const generating = state.phase === 'generating'
  const sendDisabled =
    generating ||
    props.generationBusy ||
    state.submitting ||
    state.submitted ||
    !state.draft ||
    !preview.trim() ||
    missingInputs.length > 0 ||
    !props.targetOpen ||
    (props.currentLineDirty && !state.readyForDirtyLine)

  const generateFromShortcut = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || !event.metaKey) return
    event.preventDefault()
    if (!generating && !props.generationBusy && state.request.trim()) props.onGenerate()
  }

  return (
    <Box
      data-phi-terminal-assist="true"
      role="region"
      aria-label={
        state.kind === 'explain' ? terminalUi.askAgentToExplain : terminalUi.helpWriteACommand
      }
      sx={{
        flexShrink: 0,
        mx: 1.5,
        mb: 1.5,
        p: 1.25,
        maxHeight: 'min(58%, 520px)',
        overflowY: 'auto',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1.5,
        bgcolor: 'background.paper',
        boxShadow: 3,
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" sx={{ display: 'block', fontWeight: 800 }}>
            {state.kind === 'explain' ? terminalUi.askAgentToExplain : terminalUi.helpWriteACommand}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {terminalUi.target}
            {props.targetLabel} {terminalUi.generatedContentIsNotSentAutomatically}
          </Typography>
        </Box>
        <Button size="small" color="inherit" disabled={generating} onClick={props.onClose}>
          {terminalUi.close}
        </Button>
      </Box>

      <TextField
        fullWidth
        multiline
        minRows={2}
        maxRows={5}
        size="small"
        label={
          state.kind === 'explain'
            ? terminalUi.whatWouldYouLikeToUnderstand
            : terminalUi.describeWhatYouWantToDo
        }
        value={state.request}
        disabled={generating}
        onChange={(event) => props.onRequestChange(event.currentTarget.value)}
        onKeyDown={generateFromShortcut}
        sx={{ mt: 1 }}
      />

      {state.selection !== undefined ? (
        <Box sx={{ mt: 1 }}>
          <TextField
            fullWidth
            multiline
            minRows={2}
            maxRows={5}
            size="small"
            label={terminalUi.attachedTerminalContent}
            value={state.selection}
            disabled={generating}
            onChange={(event) => props.onSelectionChange(event.currentTarget.value)}
          />
          <Box
            sx={{
              mt: 0.25,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 1
            }}
          >
            <Typography
              role={selectionBoundary?.truncated || state.selectionTruncated ? 'status' : undefined}
              variant="caption"
              color={
                selectionBoundary?.truncated || state.selectionTruncated
                  ? 'warning.main'
                  : 'text.secondary'
              }
            >
              {selectionBoundary?.truncated
                ? terminalUi.exceeds16KiBOnlyTheFirstValueCharacters(
                    selectionBoundary.includedCharacters
                  )
                : state.selectionTruncated
                  ? terminalUi.attachedContentTruncatedTo16KiB
                  : terminalUi.onlyThisContentWillBeSentWithThe}
            </Typography>
            <Button
              size="small"
              color="inherit"
              disabled={generating}
              onClick={() => props.onSelectionChange(undefined)}
            >
              {terminalUi.removeAttachedContent}
            </Button>
          </Box>
        </Box>
      ) : null}

      <Box sx={{ mt: 1, display: 'flex', justifyContent: 'flex-end', gap: 0.75 }}>
        {generating ? (
          <>
            <Box
              role="status"
              sx={{ mr: 'auto', display: 'flex', alignItems: 'center', gap: 0.75 }}
            >
              <CircularProgress size={14} />
              <Typography variant="caption" color="text.secondary">
                {terminalUi.generating}
              </Typography>
            </Box>
            <Button size="small" color="inherit" onClick={props.onCancelGeneration}>
              {terminalUi.cancel}
            </Button>
          </>
        ) : (
          <Button
            size="small"
            variant="contained"
            disabled={props.generationBusy || !state.request.trim()}
            onClick={props.onGenerate}
          >
            {terminalUi.generate}
          </Button>
        )}
      </Box>

      {state.error ? (
        <Typography role="alert" variant="caption" color="error" sx={{ display: 'block', mt: 1 }}>
          {state.error}
        </Typography>
      ) : null}

      {state.phase === 'result' && state.draft ? (
        <Box sx={{ mt: 1.25, pt: 1.25, borderTop: 1, borderColor: 'divider' }}>
          <TextField
            fullWidth
            multiline
            minRows={2}
            maxRows={8}
            size="small"
            label={terminalUi.commandDraft}
            value={state.command}
            disabled={state.submitted}
            onChange={(event) => props.onCommandChange(event.currentTarget.value)}
            slotProps={{
              htmlInput: { style: { fontFamily: '"SF Mono", Menlo, monospace', fontSize: 12 } }
            }}
          />

          {state.draft.explanation ? (
            <Typography
              data-phi-terminal-draft-explanation="true"
              variant="body2"
              sx={{ mt: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            >
              {state.draft.explanation}
            </Typography>
          ) : null}

          {requiredInputs.map((input) => (
            <TextField
              key={input.name}
              fullWidth
              size="small"
              required
              label={input.name}
              helperText={input.description}
              value={state.inputValues[input.name] ?? ''}
              disabled={state.submitted}
              onChange={(event) => props.onInputChange(input.name, event.currentTarget.value)}
              sx={{ mt: 1 }}
            />
          ))}

          {requiredInputs.length > 0 ? (
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {terminalUi.sendPreview}
              </Typography>
              <Typography
                component="pre"
                data-phi-terminal-command-preview="true"
                sx={{
                  m: 0,
                  mt: 0.25,
                  p: 0.75,
                  borderRadius: 1,
                  bgcolor: 'action.hover',
                  fontFamily: '"SF Mono", Menlo, monospace',
                  fontSize: 11.5,
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere'
                }}
              >
                {preview}
              </Typography>
            </Box>
          ) : null}

          {props.currentLineDirty ? (
            <FormControlLabel
              sx={{ mt: 0.5, alignItems: 'flex-start' }}
              control={
                <Checkbox
                  size="small"
                  checked={state.readyForDirtyLine}
                  disabled={state.submitted}
                  onChange={(event) => props.onReadyForDirtyLineChange(event.target.checked)}
                />
              }
              label={terminalUi.iAmReadyToReceiveThisCommandThe}
            />
          ) : null}

          {!props.targetOpen ? (
            <Typography role="alert" variant="caption" color="warning.main">
              {terminalUi.theTargetTerminalIsClosedCannotSend}
            </Typography>
          ) : null}

          <Box sx={{ mt: 1, display: 'flex', justifyContent: 'flex-end', gap: 0.75 }}>
            <Button
              size="small"
              color="inherit"
              disabled={!preview}
              onClick={() => props.onCopy(preview)}
            >
              {terminalUi.copy}
            </Button>
            <Button
              size="small"
              variant="contained"
              disabled={sendDisabled}
              onClick={() => props.onSend(preview)}
            >
              {state.submitted ? terminalUi.sent : terminalUi.sendToValue(props.targetLabel)}
            </Button>
          </Box>
        </Box>
      ) : null}
    </Box>
  )
}
