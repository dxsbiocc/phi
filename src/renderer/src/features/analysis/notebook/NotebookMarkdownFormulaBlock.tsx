import { useEffect, useRef, useState } from 'react'
import { Box } from '@mui/material'
import MarkdownContent from '../../../components/MarkdownContent'
import { useUiLanguage } from '../../../lib/i18n'
import { analysisCopy } from '../lib/analysisUiCopy'
import { displayMathAt } from './markdownDisplayMath'

export function NotebookMarkdownFormulaBlock({
  source,
  readOnly,
  startEditing = false,
  onBodyChange,
  onExitBelow
}: {
  source: string
  readOnly: boolean
  startEditing?: boolean
  onBodyChange: (body: string, selectionStart: number, selectionEnd: number) => void
  onExitBelow: () => void
}): React.JSX.Element {
  useUiLanguage()
  const formula = displayMathAt(source, 0)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [editing, setEditing] = useState(startEditing)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  return (
    <Box
      data-phi-notebook-formula-block="true"
      sx={{
        position: 'relative',
        boxSizing: 'border-box',
        height: 112,
        overflow: 'hidden',
        borderRadius: 2,
        bgcolor: 'transparent',
        px: 1.5,
        py: 1,
        textAlign: 'center'
      }}
    >
      <Box
        role={readOnly ? undefined : 'button'}
        tabIndex={readOnly ? undefined : 0}
        aria-label={readOnly ? undefined : analysisCopy.editMarkdownFormula}
        onClick={() => {
          if (!readOnly) setEditing(true)
        }}
        onKeyDown={(event) => {
          if (!readOnly && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            setEditing(true)
          }
        }}
        sx={{ height: 72, overflow: 'hidden', cursor: readOnly ? 'default' : 'text' }}
      >
        <MarkdownContent text={source.slice(0, formula?.closingEnd)} enableMath />
      </Box>
      {editing ? (
        <Box
          component="textarea"
          ref={inputRef}
          data-phi-notebook-formula-input="true"
          aria-label={analysisCopy.markdownFormulaInput}
          value={formula?.body ?? ''}
          readOnly={readOnly}
          rows={Math.max(2, (formula?.body ?? '').split('\n').length)}
          spellCheck={false}
          onChange={(event) =>
            onBodyChange(event.target.value, event.target.selectionStart, event.target.selectionEnd)
          }
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setEditing(false)
            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              onExitBelow()
            }
          }}
          sx={{
            boxSizing: 'border-box',
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: 8,
            width: 'calc(100% - 24px)',
            height: 32,
            resize: 'none',
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            outlineColor: 'primary.main',
            bgcolor: 'background.paper',
            color: 'text.primary',
            px: 1,
            py: 0.4,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.84rem',
            lineHeight: 1.5
          }}
        />
      ) : null}
    </Box>
  )
}
