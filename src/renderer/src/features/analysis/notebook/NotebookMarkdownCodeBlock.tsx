import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Box, IconButton, MenuItem, MenuList, Popover, TextField, Tooltip } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { EditorView } from '@codemirror/view'
import { FiChevronDown } from 'react-icons/fi'
import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import { markdownCopy } from '../../../components/markdown/markdownUiCopy'
import { analysisCopy } from '../lib/analysisUiCopy'
import { syntaxLanguageForMarkdownCode } from '../../../lib/markdownCodeLanguage'
import { fencedCodeAt } from './markdownFencedCode'
import { NotebookMarkdownCodeInput } from './NotebookMarkdownCodeInput'

const languages = [
  { id: '', label: 'Plain text' },
  { id: 'python', label: 'Python' },
  { id: 'r', label: 'R' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'bash', label: 'Bash' },
  { id: 'json', label: 'JSON' },
  { id: 'sql', label: 'SQL' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'julia', label: 'Julia' },
  { id: 'yaml', label: 'YAML' },
  { id: 'markdown', label: 'Markdown' }
] as const

export function NotebookMarkdownCodeBlock({
  source,
  readOnly,
  onBodyChange,
  onLanguageChange,
  onExitBelow
}: {
  source: string
  readOnly: boolean
  onBodyChange: (body: string) => void
  onLanguageChange: (language: string) => void
  onExitBelow: () => void
}): React.JSX.Element {
  useUiLanguage()
  const theme = useTheme()
  const code = fencedCodeAt(source, 0)
  const body = code?.body ?? ''
  const language = code?.language ?? ''
  const inputHostRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<HTMLLIElement | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [copied, setCopied] = useState(false)
  const options = languages.filter((entry) =>
    `${entry.id} ${entry.label}`.toLowerCase().includes(query.trim().toLowerCase())
  )
  const customId = query.trim().toLowerCase()
  const customOption =
    /^[a-z0-9+#.-]+$/.test(customId) && !languages.some((entry) => entry.id === customId)
      ? { id: customId, label: analysisCopy.useMarkdownCodeLanguage(customId) }
      : null
  const choices = customOption ? [...options, customOption] : options
  const label = languages.find((entry) => entry.id === language)?.label ?? language
  const syntaxLanguage = syntaxLanguageForMarkdownCode(language)

  const focusInput = (): void => {
    const dom = inputHostRef.current?.querySelector<HTMLElement>('.cm-editor')
    if (dom) EditorView.findFromDOM(dom)?.focus()
  }

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, anchor, query])

  const choose = (id: string): void => {
    onLanguageChange(id)
    setAnchor(null)
    setQuery('')
    requestAnimationFrame(focusInput)
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (choices.length)
        setActiveIndex(
          (index) =>
            (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
        )
    } else if (event.key === 'Enter' && choices[activeIndex]) {
      event.preventDefault()
      choose(choices[activeIndex].id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setAnchor(null)
      requestAnimationFrame(focusInput)
    }
    event.stopPropagation()
  }

  const copy = (): void => {
    void navigator.clipboard.writeText(body).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      },
      (error) => console.error('Failed to copy code block:', error)
    )
  }

  return (
    <Box
      data-phi-notebook-code-block="editable"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) requestAnimationFrame(focusInput)
      }}
      sx={{
        position: 'relative',
        borderRadius: 2,
        bgcolor: 'action.hover',
        '&:focus-within': {
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.14 : 0.07)
        },
        '& .phi-notebook-code-actions': { opacity: 0, pointerEvents: 'none' },
        '&:hover .phi-notebook-code-actions, &:focus-within .phi-notebook-code-actions': {
          opacity: 1,
          pointerEvents: 'auto'
        },
        ...(anchor ? { '& .phi-notebook-code-actions': { opacity: 1, pointerEvents: 'auto' } } : {})
      }}
    >
      <Box
        className="phi-notebook-code-actions"
        sx={{
          position: 'absolute',
          top: 7,
          right: 8,
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 0.4,
          transition: 'opacity 120ms ease'
        }}
      >
        <Box
          component="button"
          type="button"
          data-phi-notebook-code-language-button="true"
          aria-label={analysisCopy.chooseMarkdownCodeLanguage}
          disabled={readOnly}
          onClick={(event) => {
            setAnchor(event.currentTarget)
            setQuery('')
            setActiveIndex(0)
          }}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            border: 0,
            borderRadius: 1,
            px: 0.9,
            py: 0.4,
            color: 'text.secondary',
            bgcolor: 'background.paper',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '0.75rem',
            '&:hover': { color: 'text.primary' }
          }}
        >
          {language ? label : analysisCopy.markdownCodeLanguageDefault}
          <FiChevronDown size={13} />
        </Box>
        <Tooltip title={copied ? markdownCopy.copied : markdownCopy.copy}>
          <IconButton
            size="small"
            aria-label={markdownCopy.copy}
            onClick={copy}
            sx={{ width: 27, height: 27, color: 'text.secondary', bgcolor: 'background.paper' }}
          >
            <PhiIcons.action.copy sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      </Box>
      <Box ref={inputHostRef}>
        <NotebookMarkdownCodeInput
          value={body}
          language={syntaxLanguage}
          readOnly={readOnly}
          onChange={onBodyChange}
          onExitBelow={onExitBelow}
        />
      </Box>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 236, maxHeight: 320, p: 0.5 } } }}
      >
        <TextField
          autoFocus
          fullWidth
          size="small"
          placeholder={analysisCopy.searchMarkdownCodeLanguage}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={onSearchKeyDown}
          sx={{ mb: 0.5 }}
        />
        <MenuList dense role="listbox" aria-label={analysisCopy.chooseMarkdownCodeLanguage}>
          {choices.map((entry, index) => (
            <MenuItem
              key={entry.id}
              ref={index === activeIndex ? activeRef : undefined}
              role="option"
              aria-selected={index === activeIndex}
              selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(entry.id)}
            >
              {entry.id ? entry.label : analysisCopy.markdownCodePlainText}
            </MenuItem>
          ))}
        </MenuList>
      </Popover>
    </Box>
  )
}
