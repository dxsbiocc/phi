import { terminalUi } from '../lib/terminalUi'
import { useUiLanguage } from '../../../lib/i18n'
import { Box, Typography } from '@mui/material'
import { workspacePanelText } from '../../../layout'

export type TerminalStatusKind =
  'starting' | 'exited' | 'failed' | 'remote' | 'unsupported' | 'limit' | 'unavailable'

export interface TerminalStatusPaneProps {
  kind: TerminalStatusKind
  exitCode?: number
  message?: string
  terminalCount?: number
  compact?: boolean
}

function statusCopy(props: TerminalStatusPaneProps): {
  title: string
  detail?: string
  alert?: boolean
} {
  switch (props.kind) {
    case 'starting':
      return { title: terminalUi.startingShell }
    case 'exited':
      return {
        title: props.message || terminalUi.shellExitedCodeValue(props.exitCode ?? '—')
      }
    case 'failed':
      return {
        title: props.message || terminalUi.shellFailedToStart,
        detail: terminalUi.createANewTerminalAndTryAgain,
        alert: true
      }
    case 'remote':
      return { title: terminalUi.openARemoteProjectSessionFirst }
    case 'unsupported':
      return { title: terminalUi.terminalIsNotSupportedOnThisPlatform, alert: true }
    case 'limit':
      return {
        title: terminalUi.terminalLimitReachedValueOpen(props.terminalCount ?? 0),
        detail: terminalUi.closeATerminalBeforeCreatingAnother,
        alert: true
      }
    case 'unavailable':
      return {
        title: terminalUi.restartPhiToUseTheTerminal,
        detail: terminalUi.thisWindowUsesAnOlderBackgroundProcessQuit,
        alert: true
      }
  }
}

export function TerminalStatusPane(props: TerminalStatusPaneProps): React.JSX.Element {
  useUiLanguage()
  const copy = statusCopy(props)
  return (
    <Box
      data-phi-terminal-status={props.kind}
      role={copy.alert ? 'alert' : 'status'}
      sx={{
        width: props.compact ? 'auto' : '100%',
        minHeight: props.compact ? 'auto' : 112,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        px: 2,
        py: props.compact ? 1 : 2.5,
        textAlign: 'center',
        color: 'text.primary',
        bgcolor: props.compact ? 'background.paper' : 'transparent',
        borderTop: props.compact ? 1 : 0,
        borderColor: 'divider',
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box sx={{ minWidth: 0, maxWidth: 320 }}>
        <Typography
          variant="body2"
          sx={{ ...workspacePanelText.heading, fontWeight: props.kind === 'starting' ? 500 : 700 }}
        >
          {copy.title}
        </Typography>
        {copy.detail ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ ...workspacePanelText.body, display: 'block', mt: 0.5 }}
          >
            {copy.detail}
          </Typography>
        ) : null}
      </Box>
    </Box>
  )
}
