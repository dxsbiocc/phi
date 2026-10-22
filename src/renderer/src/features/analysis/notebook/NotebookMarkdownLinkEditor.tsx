import { useState } from 'react'
import { Box, Button, Popover, Stack, TextField } from '@mui/material'
import { useUiLanguage } from '../../../lib/i18n'
import { analysisCopy } from '../lib/analysisUiCopy'

export function NotebookMarkdownLinkEditor({
  anchor,
  initialTitle,
  onCancel,
  onInsert
}: {
  anchor: DOMRect
  initialTitle: string
  onCancel: () => void
  onInsert: (title: string, url: string) => void
}): React.JSX.Element {
  useUiLanguage()
  const [title, setTitle] = useState(initialTitle)
  const [url, setUrl] = useState('')
  const valid = Boolean(
    title.trim() && url.trim() && !/^(?:javascript|data|vbscript):/i.test(url.trim())
  )

  return (
    <Popover
      open
      anchorReference="anchorPosition"
      anchorPosition={{ top: anchor.bottom + 8, left: anchor.left }}
      transitionDuration={0}
      onClose={onCancel}
      slotProps={{
        paper: { sx: { borderRadius: 2, p: 1.5, width: 300, maxWidth: 'calc(100vw - 24px)' } }
      }}
    >
      <Box
        component="form"
        role="dialog"
        aria-label={analysisCopy.insertLink}
        data-phi-notebook-link-editor="true"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) onInsert(title.trim(), url.trim())
        }}
      >
        <Stack spacing={1.25}>
          <TextField
            autoFocus={!initialTitle}
            fullWidth
            size="small"
            label={analysisCopy.markdownLinkTitle}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            slotProps={{ htmlInput: { 'data-phi-notebook-link-title': 'true' } }}
          />
          <TextField
            autoFocus={Boolean(initialTitle)}
            fullWidth
            size="small"
            label={analysisCopy.markdownLinkUrl}
            placeholder="https://example.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            slotProps={{ htmlInput: { 'data-phi-notebook-link-url': 'true' } }}
          />
          <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
            <Button size="small" onClick={onCancel}>
              {analysisCopy.cancel}
            </Button>
            <Button
              type="submit"
              variant="contained"
              size="small"
              disabled={!valid}
              data-phi-notebook-link-submit="true"
            >
              {analysisCopy.insertIntoMarkdown}
            </Button>
          </Stack>
        </Stack>
      </Box>
    </Popover>
  )
}
