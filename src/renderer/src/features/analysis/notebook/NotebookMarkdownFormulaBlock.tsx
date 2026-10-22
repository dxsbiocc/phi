import { useEffect, useRef, useState } from 'react'
import { Box, IconButton, Tooltip, alpha } from '@mui/material'
import MarkdownContent from '../../../components/MarkdownContent'
import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import { analysisCopy } from '../lib/analysisUiCopy'
import { displayMathAt } from './markdownDisplayMath'

export function NotebookMarkdownFormulaBlock({
  source,
  readOnly,
  startEditing = false,
  onBodyChange,
  onDelete,
  onExitBelow
}: {
  source: string
  readOnly: boolean
  startEditing?: boolean
  onBodyChange: (body: string, selectionStart: number, selectionEnd: number) => void
  onDelete: () => void
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
      onClick={(event) => {
        if (!readOnly && !(event.target as Element).closest('button, textarea')) setEditing(true)
      }}
      sx={{
        position: 'relative',
        boxSizing: 'border-box',
        height: 168,
        overflow: 'hidden',
        borderRadius: 2,
        bgcolor: (theme) =>
          editing
            ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.14 : 0.07)
            : 'transparent',
        px: 1.5,
        py: 0.5,
        textAlign: 'center',
        cursor: readOnly ? 'default' : 'text',
        transition: 'background-color 120ms ease',
        '&:focus-within': {
          bgcolor: (theme) =>
            alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.14 : 0.07)
        },
        '& .phi-formula-delete': { opacity: 0 },
        '&:hover .phi-formula-delete, &:focus-within .phi-formula-delete': { opacity: 1 }
      }}
    >
      {!readOnly ? (
        <Tooltip title={analysisCopy.deleteMarkdownFormula}>
          <IconButton
            className="phi-formula-delete"
            size="small"
            aria-label={analysisCopy.deleteMarkdownFormula}
            onClick={onDelete}
            sx={{ position: 'absolute', top: 4, right: 4, zIndex: 1, color: 'text.secondary' }}
          >
            <PhiIcons.action.delete sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      ) : null}
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
        sx={{
          height: 112,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          cursor: readOnly ? 'default' : 'text',
          '& .katex-display': { margin: 0 }
        }}
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
            } else if (
              event.key === 'Backspace' &&
              !formula?.body &&
              event.currentTarget.selectionStart === 0 &&
              event.currentTarget.selectionEnd === 0
            ) {
              event.preventDefault()
              onDelete()
            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              onExitBelow()
            } else if (
              event.key === 'ArrowDown' &&
              event.currentTarget.selectionStart === (formula?.body ?? '').length &&
              event.currentTarget.selectionEnd === (formula?.body ?? '').length
            ) {
              event.preventDefault()
              onExitBelow()
            }
          }}
          sx={{
            boxSizing: 'border-box',
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: 10,
            width: 'calc(100% - 24px)',
            height: 42,
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
