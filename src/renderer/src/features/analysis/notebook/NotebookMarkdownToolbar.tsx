import { analysisCopy } from '../lib/analysisUiCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { IconButton, Paper, Popper } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { FiBold, FiCode, FiHash, FiItalic, FiLink, FiList, FiMessageSquare } from 'react-icons/fi'
import { markdownInsertLabel, type MarkdownInsertKind } from './markdownInsert'
import WarmTooltip, { WarmTooltipGroup } from './WarmTooltip'

const actions = [
  { kind: 'bold', icon: FiBold, shortcut: '⌘B' },
  { kind: 'italic', icon: FiItalic, shortcut: '⌘I' },
  { kind: 'link', icon: FiLink, shortcut: '⌘K' },
  { kind: 'formula', icon: FiHash, shortcut: undefined },
  { kind: 'codeBlock', icon: FiCode, shortcut: undefined },
  { kind: 'list', icon: FiList, shortcut: undefined },
  { kind: 'quote', icon: FiMessageSquare, shortcut: undefined }
] as const satisfies readonly {
  kind: MarkdownInsertKind
  icon: typeof FiBold
  shortcut: string | undefined
}[]

export function NotebookMarkdownToolbar({
  anchor,
  onInsert
}: {
  anchor: DOMRect | null
  onInsert: (kind: MarkdownInsertKind) => void
}): React.JSX.Element {
  useUiLanguage()
  const theme = useTheme()
  const surface = theme.palette.mode === 'dark' ? theme.palette.background.paper : '#f5f5f5'
  const ink = theme.palette.mode === 'dark' ? theme.palette.text.primary : '#18181b'

  return (
    <Popper
      open={Boolean(anchor)}
      anchorEl={anchor ? { getBoundingClientRect: () => anchor } : null}
      placement="top"
      modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}
      sx={{ zIndex: (muiTheme) => muiTheme.zIndex.modal + 1 }}
    >
      <Paper
        data-phi-notebook-markdown-toolbar="true"
        role="toolbar"
        aria-label={analysisCopy.markdownFormattingTools}
        elevation={5}
        sx={{ display: 'flex', alignItems: 'center', gap: 0.25, p: 0.5, borderRadius: 2 }}
      >
        <WarmTooltipGroup delay={400} warmWindow={300} travel={320} lean={0}>
          {actions.map(({ kind, icon: Icon, shortcut }) => (
            <WarmTooltip
              key={kind}
              content={markdownInsertLabel(kind)}
              shortcut={shortcut}
              side="top"
              surfaceColor={surface}
              inkColor={ink}
              size="md"
              radius={8}
              gap={8}
              arrow
              popDuration={160}
              popScale={0.94}
              popBlur={4}
              showFuse={false}
            >
              <IconButton
                size="small"
                aria-label={markdownInsertLabel(kind)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => onInsert(kind)}
                sx={{ width: 30, height: 30, borderRadius: 1, color: 'text.primary' }}
              >
                <Icon size={16} />
              </IconButton>
            </WarmTooltip>
          ))}
        </WarmTooltipGroup>
      </Paper>
    </Popper>
  )
}
