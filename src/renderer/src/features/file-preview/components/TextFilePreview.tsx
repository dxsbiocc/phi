import { filePreviewCopy } from '../lib/filePreviewUiCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Alert,
  Box,
  Button,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  CircularProgress,
  IconButton,
  InputBase,
  Paper,
  ToggleButton,
  Tooltip,
  Typography
} from '@mui/material'
import { PhiIcons } from '../../../icons'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import type { FilePreview } from '../../../types'
import type { FileTreeActions } from '../lib/fileTreeActions'
import { textFileDraftIsDirty, useTextFileDrafts } from '../lib/textFileDrafts'
import { findTextFileMatches, nextTextFileMatch, type TextFileMatch } from '../lib/textFileSearch'
import { readableErrorMessage } from '../../../lib/sessionNotifications'
import { WORKSPACE_TEXT_MAX_BYTES } from '../../../../../shared/workspaceFileOperations'
import { SourceTextEditor } from './SourceTextEditor'
import { FilePreviewActionsContext } from '../lib/filePreviewActionsContext'
import { molecularStructureFormatForPath } from '../lib/molecularStructureFiles'
import { spreadsheetFormatForPath } from '../../../lib/spreadsheetPreview'

export type TextPreviewFile = Extract<FilePreview, { kind: 'text' | 'html' }>
const Search = PhiIcons.action.search
const ChevronUp = PhiIcons.action.collapse
const ChevronDown = PhiIcons.action.expand
const Close = PhiIcons.action.close

export function TextFilePreview({
  file,
  fileActions,
  renderPreview,
  renderMarkdownBlock,
  markdown = false
}: {
  file: TextPreviewFile
  fileActions?: FileTreeActions
  renderPreview: (content: string) => ReactNode
  renderMarkdownBlock?: (content: string) => ReactNode
  markdown?: boolean
}): React.JSX.Element {
  useUiLanguage()
  const [sourceMode, setSourceMode] = useState(false)
  const actionsHost = useContext(FilePreviewActionsContext)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [activeMatch, setActiveMatch] = useState(-1)
  const [selection, setSelection] = useState<(TextFileMatch & { requestId: number }) | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const sourceContainer = useRef<HTMLDivElement>(null)
  const requestId = useRef(0)
  const draft = useTextFileDrafts((state) => state.drafts[file.path])
  const persistenceError = useTextFileDrafts((state) => state.persistenceError)
  const content = draft?.content ?? file.content
  const searchContent = useMemo(() => content.replace(/\r\n?/g, '\n'), [content])
  const search = useMemo(
    () => findTextFileMatches(searchContent, query, caseSensitive),
    [searchContent, query, caseSensitive]
  )
  const dirty = textFileDraftIsDirty(draft)
  const saving = draft?.saving ?? false
  const onSave =
    fileActions?.onSaveTextFile ?? (markdown ? fileActions?.onSaveMarkdownFile : undefined)
  const onDirtyChange = fileActions?.onTextDirtyChange ?? fileActions?.onMarkdownDirtyChange
  const editable =
    !file.truncated &&
    file.bytes <= WORKSPACE_TEXT_MAX_BYTES &&
    Boolean(onSave) &&
    (fileActions?.canModifyFile?.(file.path) ?? false)
  const structured =
    file.kind === 'html' ||
    Boolean(spreadsheetFormatForPath(file.path)) ||
    Boolean(molecularStructureFormatForPath(file.path))
  const directEdit = editable && !structured
  const sourceVisible = directEdit || sourceMode || searchOpen
  const inlineMarkdown = markdown && directEdit && !searchOpen
  const currentMatch = search.matches.length
    ? Math.min(Math.max(activeMatch, 0), search.matches.length - 1)
    : -1

  useEffect(() => {
    if (!file.truncated && file.bytes <= WORKSPACE_TEXT_MAX_BYTES)
      useTextFileDrafts.getState().sync(file.path, file.content)
  }, [file.path, file.content, file.truncated, file.bytes])
  useEffect(() => () => useTextFileDrafts.getState().release(file.path), [file.path])
  useEffect(() => {
    onDirtyChange?.(file.path, dirty || saving)
  }, [onDirtyChange, file.path, dirty, saving])
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus()
  }, [searchOpen])

  const selectMatch = (matches: TextFileMatch[], index: number): void => {
    setActiveMatch(index)
    const id = ++requestId.current
    setSelection((previous) =>
      index < 0
        ? previous
          ? { from: previous.from, to: previous.from, requestId: id }
          : null
        : { ...matches[index], requestId: id }
    )
  }
  const navigate = (direction: 1 | -1): void => {
    selectMatch(search.matches, nextTextFileMatch(search.matches.length, currentMatch, direction))
  }
  const openSearch = (): void => {
    setSearchOpen(true)
    selectMatch(search.matches, search.matches.length ? Math.max(currentMatch, 0) : -1)
    searchInput.current?.focus()
    searchInput.current?.select()
  }
  const closeSearch = (): void => {
    setSearchOpen(false)
    if (directEdit || sourceMode)
      sourceContainer.current?.querySelector<HTMLElement>('.cm-content')?.focus()
    else container.current?.focus({ preventScroll: true })
  }
  const save = async (): Promise<void> => {
    if (!editable || !onSave) return
    const submitted = useTextFileDrafts.getState().beginSave(file.path)
    if (!submitted) return
    try {
      const result = await onSave(file.path, submitted.content, submitted.baseContent)
      useTextFileDrafts.getState().saved(file.path, submitted.content, result.content)
    } catch (error) {
      useTextFileDrafts
        .getState()
        .failed(file.path, readableErrorMessage(error, filePreviewCopy.saveFailed))
    } finally {
      const latest = useTextFileDrafts.getState().drafts[file.path]
      onDirtyChange?.(file.path, Boolean(latest?.saving || textFileDraftIsDirty(latest)))
    }
  }
  const actions = (
    <Box
      data-phi-text-file-actions="true"
      sx={{ display: 'flex', alignItems: 'center', gap: 0.35 }}
    >
      <Tooltip title={filePreviewCopy.searchContentShortcut}>
        <IconButton
          size="small"
          aria-label={filePreviewCopy.searchContent}
          aria-pressed={searchOpen}
          onClick={openSearch}
        >
          <Search sx={{ fontSize: 17 }} />
        </IconButton>
      </Tooltip>
      {structured && (
        <Tooltip title={sourceMode ? filePreviewCopy.showPreview : filePreviewCopy.editSource}>
          <IconButton
            size="small"
            aria-label={sourceMode ? filePreviewCopy.showPreview : filePreviewCopy.editSource}
            aria-pressed={sourceMode}
            onClick={() => setSourceMode(!sourceMode)}
          >
            <PhiIcons.action.edit sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
      )}
      {dirty && (
        <Tooltip title={filePreviewCopy.discardChanges}>
          <span>
            <IconButton
              size="small"
              aria-label={filePreviewCopy.discardChanges}
              disabled={saving}
              onClick={() => setConfirmDiscard(true)}
            >
              <PhiIcons.action.refresh sx={{ fontSize: 17 }} />
            </IconButton>
          </span>
        </Tooltip>
      )}
      {editable && (
        <Tooltip title={saving ? filePreviewCopy.saving : filePreviewCopy.saveShortcut}>
          <span>
            <IconButton
              size="small"
              aria-label={filePreviewCopy.saveFile}
              disabled={!dirty || saving}
              data-phi-file-save-button="true"
              onClick={() => void save()}
            >
              {saving ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <PhiIcons.action.save sx={{ fontSize: 17 }} />
              )}
            </IconButton>
          </span>
        </Tooltip>
      )}
    </Box>
  )

  const searchPanel = searchOpen && (
    <Paper
      elevation={3}
      role="search"
      aria-label={filePreviewCopy.findInFile}
      data-phi-text-file-search="true"
      sx={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 3,
        width: 360,
        maxWidth: 'calc(100% - 16px)',
        boxSizing: 'border-box',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1.5,
        '&:focus-within': { borderColor: 'primary.main' },
        display: 'flex',
        alignItems: 'center',
        gap: 0.25,
        px: 0.75,
        py: 0.5,
        flexWrap: 'wrap'
      }}
    >
      <InputBase
        placeholder={filePreviewCopy.searchSource}
        value={query}
        inputRef={searchInput}
        inputProps={{ 'aria-label': filePreviewCopy.searchText, spellCheck: false }}
        onChange={(event) => {
          const value = event.target.value
          setQuery(value)
          const matches = findTextFileMatches(searchContent, value, caseSensitive).matches
          selectMatch(matches, matches.length ? 0 : -1)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            navigate(event.shiftKey ? -1 : 1)
          }
        }}
        sx={{ flex: '1 1 0', minWidth: 0, height: 28, px: 0.5, fontSize: '0.8125rem' }}
      />
      <Typography
        variant="caption"
        color="text.secondary"
        aria-live="polite"
        data-phi-search-count="true"
        sx={{ minWidth: 34, textAlign: 'center', whiteSpace: 'nowrap' }}
      >
        {!query
          ? filePreviewCopy.enterSearch
          : search.matches.length
            ? `${currentMatch + 1} / ${search.matches.length}${search.limited ? '+' : ''}`
            : filePreviewCopy.noMatches}
      </Typography>
      <Tooltip title={filePreviewCopy.matchCase}>
        <ToggleButton
          size="small"
          value="case"
          selected={caseSensitive}
          aria-label={filePreviewCopy.matchCase}
          onChange={() => {
            const value = !caseSensitive
            setCaseSensitive(value)
            const matches = findTextFileMatches(searchContent, query, value).matches
            selectMatch(matches, matches.length ? 0 : -1)
          }}
          sx={{
            p: 0.25,
            minWidth: 26,
            height: 26,
            border: 0,
            borderRadius: 1,
            fontSize: '0.75rem'
          }}
        >
          Aa
        </ToggleButton>
      </Tooltip>
      <IconButton
        size="small"
        sx={{ p: 0.5, width: 26, height: 26 }}
        aria-label={filePreviewCopy.previousMatch}
        disabled={!search.matches.length}
        onClick={() => navigate(-1)}
      >
        <ChevronUp sx={{ fontSize: 17 }} />
      </IconButton>
      <IconButton
        size="small"
        sx={{ p: 0.5, width: 26, height: 26 }}
        aria-label={filePreviewCopy.nextMatch}
        disabled={!search.matches.length}
        onClick={() => navigate(1)}
      >
        <ChevronDown sx={{ fontSize: 17 }} />
      </IconButton>
      <IconButton
        size="small"
        sx={{ p: 0.5, width: 26, height: 26 }}
        aria-label={filePreviewCopy.closeSearch}
        onClick={closeSearch}
      >
        <Close sx={{ fontSize: 17 }} />
      </IconButton>
      {(file.truncated || search.limited) && (
        <Typography variant="caption" color="text.secondary" sx={{ width: '100%' }}>
          {file.truncated ? filePreviewCopy.searchTruncated : ''}
          {search.limited ? filePreviewCopy.searchLimited : ''}
        </Typography>
      )}
    </Paper>
  )

  return (
    <Box
      ref={container}
      data-phi-text-file="true"
      data-phi-markdown-file={markdown ? 'true' : undefined}
      tabIndex={0}
      onMouseDown={(event) => {
        if (!(event.target as HTMLElement).closest('button, input, textarea, a, .cm-editor'))
          event.currentTarget.focus({ preventScroll: true })
      }}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || confirmDiscard) return
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault()
          event.stopPropagation()
          openSearch()
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          event.stopPropagation()
          void save()
        } else if (event.key === 'Escape' && searchOpen) {
          event.preventDefault()
          event.stopPropagation()
          closeSearch()
        }
      }}
      sx={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        containerType: 'inline-size',
        containerName: 'text-file'
      }}
    >
      {actionsHost.target
        ? createPortal(actions, actionsHost.target)
        : !actionsHost.inHeader
          ? actions
          : null}
      {draft?.error && (
        <Alert
          severity="error"
          sx={{ m: 1.5, mb: 0 }}
          action={
            fileActions?.onReloadFile ? (
              <Button color="inherit" size="small" onClick={() => setConfirmDiscard(true)}>
                {filePreviewCopy.reload}
              </Button>
            ) : undefined
          }
        >
          {draft.error}
        </Alert>
      )}
      {persistenceError && (
        <Alert severity="warning" sx={{ m: 1.5, mb: 0 }}>
          {persistenceError}
        </Alert>
      )}
      {file.bytes > WORKSPACE_TEXT_MAX_BYTES && !file.truncated && (
        <Alert severity="info" sx={{ m: 1.5, mb: 0 }}>
          {filePreviewCopy.textEditingLimit}
        </Alert>
      )}
      {sourceVisible ? (
        <Box
          ref={sourceContainer}
          sx={{
            position: 'relative',
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          {searchPanel}
          <SourceTextEditor
            path={file.path}
            value={content}
            readOnly={!editable}
            ariaLabel={markdown ? filePreviewCopy.markdownDocument : filePreviewCopy.textContent}
            query={searchOpen ? query : ''}
            caseSensitive={caseSensitive}
            selection={selection}
            inlineMarkdown={inlineMarkdown}
            renderMarkdown={renderMarkdownBlock}
            onChange={(value) => useTextFileDrafts.getState().edit(file.path, file.content, value)}
          />
        </Box>
      ) : (
        renderPreview(content)
      )}
      <ConfirmationDialog open={confirmDiscard} onClose={() => setConfirmDiscard(false)}>
        <DialogTitle>{filePreviewCopy.confirmDiscard}</DialogTitle>
        <DialogContent>
          <DialogContentText>{filePreviewCopy.discardExplanation}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDiscard(false)}>{filePreviewCopy.cancel}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              useTextFileDrafts.getState().discard(file.path, file.content)
              onDirtyChange?.(file.path, false)
              setConfirmDiscard(false)
              fileActions?.onReloadFile?.(file.path)
            }}
          >
            {filePreviewCopy.discardChanges}
          </Button>
        </DialogActions>
      </ConfirmationDialog>
    </Box>
  )
}
