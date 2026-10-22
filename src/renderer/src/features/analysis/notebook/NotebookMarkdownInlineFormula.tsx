import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Box, Popover, TextField } from '@mui/material'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { useUiLanguage } from '../../../lib/i18n'
import { analysisCopy } from '../lib/analysisUiCopy'
import { inlineMathAt } from '../../../lib/markdown/markdownInlineMath'

export function NotebookMarkdownInlineFormula({
  source,
  readOnly,
  onBodyChange
}: {
  source: string
  readOnly: boolean
  onBodyChange: (body: string) => void
}): React.JSX.Element {
  useUiLanguage()
  const formula = inlineMathAt(source, 0)
  const renderedRef = useRef<HTMLSpanElement | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!renderedRef.current) return
    katex.render(formula?.body ?? '', renderedRef.current, {
      displayMode: false,
      throwOnError: false,
      strict: 'ignore',
      trust: false
    })
  }, [formula?.body])

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' || event.key === 'Enter') {
      event.preventDefault()
      setAnchor(null)
      requestAnimationFrame(() => anchor?.focus())
    }
    event.stopPropagation()
  }

  return (
    <>
      <Box
        component="span"
        data-phi-notebook-inline-formula="true"
        role={readOnly ? undefined : 'button'}
        tabIndex={readOnly ? undefined : 0}
        aria-label={readOnly ? undefined : analysisCopy.editMarkdownFormula}
        onClick={(event) => {
          if (!readOnly) setAnchor(event.currentTarget)
        }}
        onKeyDown={(event) => {
          if (!readOnly && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            setAnchor(event.currentTarget)
          }
        }}
        sx={{ display: 'inline', cursor: readOnly ? 'default' : 'text' }}
      >
        <span ref={renderedRef} />
      </Box>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { p: 1, width: 280 } } }}
      >
        <TextField
          autoFocus
          fullWidth
          size="small"
          data-phi-notebook-inline-formula-input="true"
          aria-label={analysisCopy.markdownFormulaInput}
          value={formula?.body ?? ''}
          onChange={(event) => onBodyChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          slotProps={{ input: { sx: { fontFamily: 'var(--font-mono)' } } }}
        />
      </Popover>
    </>
  )
}
