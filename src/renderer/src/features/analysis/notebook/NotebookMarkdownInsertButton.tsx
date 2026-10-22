import { analysisCopy } from '../lib/analysisUiCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { useState } from 'react'
import { IconButton, ListItemText, Menu, MenuItem, Tooltip } from '@mui/material'
import type { SxProps, Theme } from '@mui/material/styles'
import { PhiIcons } from '../../../icons'
import { markdownInsertKinds, type MarkdownInsertKind } from './markdownInsert'

const labels: Record<MarkdownInsertKind, () => string> = {
  bold: () => analysisCopy.insertBold,
  italic: () => analysisCopy.insertItalic,
  link: () => analysisCopy.insertLink,
  formula: () => analysisCopy.insertFormula,
  codeBlock: () => analysisCopy.insertCodeBlock,
  image: () => analysisCopy.insertImage,
  list: () => analysisCopy.insertList,
  quote: () => analysisCopy.insertQuote,
  table: () => analysisCopy.insertTable
}

export function NotebookMarkdownInsertButton({
  buttonSx,
  onPrepare,
  onOpenChange,
  onInsert
}: {
  buttonSx: SxProps<Theme>
  onPrepare: () => void
  onOpenChange: (open: boolean) => void
  onInsert: (kind: MarkdownInsertKind) => void
}): React.JSX.Element {
  useUiLanguage()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  const close = (): void => {
    setAnchor(null)
    onOpenChange(false)
  }

  return (
    <>
      <Tooltip title={analysisCopy.insertIntoMarkdown}>
        <IconButton
          size="small"
          aria-label={analysisCopy.insertIntoMarkdown}
          aria-haspopup="menu"
          aria-expanded={anchor ? 'true' : undefined}
          data-phi-notebook-markdown-insert="true"
          onPointerDown={(event) => {
            onOpenChange(true)
            onPrepare()
            event.preventDefault()
          }}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={buttonSx}
        >
          <PhiIcons.action.add size={16} />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={close}
        disableAutoFocus
        disableAutoFocusItem
        disableEnforceFocus
        disableRestoreFocus
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { mt: 1, minWidth: 160 } } }}
      >
        {markdownInsertKinds.map((kind) => (
          <MenuItem
            key={kind}
            onClick={() => {
              close()
              onInsert(kind)
            }}
          >
            <ListItemText primary={labels[kind]()} />
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}
