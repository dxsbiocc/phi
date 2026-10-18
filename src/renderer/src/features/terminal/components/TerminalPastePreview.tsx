import { terminalUi } from '../lib/terminalUi'
import { useUiLanguage } from '../../../lib/i18n'
import { Box, Button, Typography } from '@mui/material'

function pasteLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/u)
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

export interface TerminalPastePreviewProps {
  text: string
  busy?: boolean
  onSend(): void
  onCancel(): void
}

export function TerminalPastePreview(props: TerminalPastePreviewProps): React.JSX.Element {
  useUiLanguage()
  const lines = pasteLines(props.text)
  const preview = lines
    .slice(0, 2)
    .map((line) => {
      if (!line) return '·'
      return line.length > 120 ? `${line.slice(0, 120)}…` : line
    })
    .join('\n')

  return (
    <Box
      data-phi-terminal-paste-preview="true"
      role="dialog"
      aria-label={terminalUi.multilinePastePreview}
      sx={{
        flexShrink: 0,
        mx: 1.5,
        mb: 1.5,
        p: 1.25,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1.5,
        bgcolor: 'background.paper',
        boxShadow: 3,
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box
        sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}
      >
        <Typography variant="caption" sx={{ fontWeight: 800 }}>
          {terminalUi.multilinePaste}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {lines.length} {terminalUi.lines}
        </Typography>
      </Box>
      <Typography
        component="pre"
        sx={{
          m: 0,
          mt: 0.5,
          maxHeight: 42,
          overflow: 'hidden',
          color: 'text.secondary',
          fontFamily: '"SF Mono", Menlo, monospace',
          fontSize: 11.5,
          lineHeight: 1.35,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere'
        }}
      >
        {preview}
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.75, mt: 1 }}>
        <Button size="small" color="inherit" disabled={props.busy} onClick={props.onCancel}>
          {terminalUi.cancel}
        </Button>
        <Button size="small" variant="contained" disabled={props.busy} onClick={props.onSend}>
          {terminalUi.sendToTerminal}
        </Button>
      </Box>
    </Box>
  )
}
