import { Box, Button, Typography } from '@mui/material'

function pasteLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/u)
}

export interface TerminalPastePreviewProps {
  text: string
  busy?: boolean
  onSend(): void
  onCancel(): void
}

export function TerminalPastePreview(props: TerminalPastePreviewProps): React.JSX.Element {
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
      aria-label="多行粘贴预览"
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
          多行粘贴
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {lines.length} 行
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
          取消
        </Button>
        <Button size="small" variant="contained" disabled={props.busy} onClick={props.onSend}>
          发送到终端
        </Button>
      </Box>
    </Box>
  )
}
