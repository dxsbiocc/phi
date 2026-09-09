import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { FILE_TYPE_ICON_META, PhiIcons, fileIconForPath, type FileIconMeta } from '../icons'
import { highlightLine, languageForPath, type SyntaxTokenKind } from '../lib/syntaxHighlight'
import { formatBytes } from '../lib/toolOutputPresentation'
import type { DirectoryListing, FilePreview, FileTreeEntry } from '../types'

const CloseIcon = PhiIcons.action.close
const CollapseIcon = PhiIcons.action.expand
const BreadcrumbSeparatorIcon = PhiIcons.action.back
const DefaultOpenIcon = PhiIcons.action.openDefault
const DirectoryTreeIcon = PhiIcons.entity.directoryTree
const ExpandIcon = PhiIcons.action.back
const FolderIcon = PhiIcons.entity.folder
const SearchIcon = PhiIcons.action.search
const filePreviewPaneLayoutSx = {
  width: '66.666%',
  flexBasis: '66.666%',
  maxWidth: 'calc(100% - 320px)',
  minWidth: 320,
  flexShrink: 0
} as const
const SPREADSHEET_ROW_LIMIT = 250
const SPREADSHEET_COLUMN_LIMIT = 60
const pathTooltipSlotProps = {
  tooltip: {
    sx: {
      bgcolor: 'background.paper',
      border: 1,
      borderColor: 'divider',
      boxShadow: 3,
      color: 'text.primary',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.75rem',
      lineHeight: 1.45,
      maxWidth: 420,
      overflowWrap: 'anywhere'
    }
  },
  arrow: {
    sx: {
      color: 'background.paper',
      '&::before': {
        border: '1px solid',
        borderColor: 'divider',
        boxSizing: 'border-box'
      }
    }
  }
} as const

export type FilePreviewPanelState =
  | { status: 'loading'; path: string; pathKind?: 'file' | 'directory' }
  | { status: 'ready'; file: FilePreview }
  | { status: 'directory'; directory: DirectoryListing }
  | { status: 'error'; path: string; message: string; pathKind?: 'file' | 'directory' }

type DirectoryLoadState =
  | { status: 'loading' }
  | { status: 'ready'; listing: DirectoryListing }
  | { status: 'error'; message: string }

type FilePreviewPanelProps = {
  state: FilePreviewPanelState
  onOpenFile: (path: string) => void
  onOpenDefaultPath: (path: string) => void
  onRevealPath: (path: string) => void
  onListDirectory: (path: string) => Promise<DirectoryListing>
}

function fileNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf('/')
  if (index <= 0) return '/'
  return path.slice(0, index)
}

function previewTitle(state: FilePreviewPanelState): string {
  if (state.status === 'ready') return state.file.name
  if (state.status === 'directory') return state.directory.name
  return fileNameFromPath(state.path)
}

function previewFullPath(state: FilePreviewPanelState): string {
  if (state.status === 'directory') return state.directory.path
  return state.status === 'ready' ? state.file.path : state.path
}

function previewDisplayPath(state: FilePreviewPanelState): string {
  if (state.status === 'ready') return state.file.displayPath
  if (state.status === 'directory') return state.directory.displayPath
  return fileNameFromPath(state.path)
}

function previewRootPath(state: FilePreviewPanelState): string {
  if (state.status === 'ready') return state.file.rootPath
  if (state.status === 'directory') return state.directory.rootPath
  return parentDirectory(state.path)
}

function previewTreeRootPath(state: FilePreviewPanelState): string {
  if (state.status === 'directory') return state.directory.path
  return previewRootPath(state)
}

function previewRootLabel(state: FilePreviewPanelState): string {
  if (state.status === 'ready') return state.file.rootLabel
  if (state.status === 'directory') return state.directory.rootLabel
  return fileNameFromPath(previewRootPath(state))
}

function previewIconForState(state: FilePreviewPanelState): FileIconMeta {
  if (state.status === 'directory') return FILE_TYPE_ICON_META.directory
  if (state.status !== 'ready' && state.pathKind === 'directory')
    return FILE_TYPE_ICON_META.directory
  return fileIconForPath(previewFullPath(state))
}

function fileManagerLabel(): string {
  if (typeof window !== 'undefined' && window.platform === 'darwin') return 'Finder 中显示'
  if (typeof window !== 'undefined' && window.platform === 'win32') return '资源管理器中显示'
  return '文件管理器中显示'
}

export function FilePreviewTitleTab({
  state,
  onClose
}: {
  state: FilePreviewPanelState
  onClose: () => void
}): React.JSX.Element {
  const title = previewTitle(state)
  const path = previewFullPath(state)
  const previewIcon = previewIconForState(state)
  const PreviewFileIcon = previewIcon.Icon
  const ariaLabel = previewIcon.kind === 'directory' ? '当前目录' : '当前文件'

  return (
    <Box
      sx={{
        ...filePreviewPaneLayoutSx,
        height: '100%',
        borderLeft: 1,
        borderColor: 'divider',
        display: 'flex',
        alignItems: 'center',
        px: 1.25,
        WebkitAppRegion: 'drag'
      }}
    >
      <Tooltip title={path} placement="top-start" arrow slotProps={pathTooltipSlotProps}>
        <Box
          role="tab"
          aria-selected="true"
          aria-label={`${ariaLabel}：${title}`}
          data-phi-file-kind={previewIcon.kind}
          sx={{
            height: 32,
            maxWidth: 'min(360px, 100%)',
            minWidth: 0,
            px: 1.15,
            borderRadius: 2,
            bgcolor: (theme) => alpha(theme.palette.text.primary, 0.055),
            color: 'text.primary',
            display: 'flex',
            alignItems: 'center',
            gap: 0.9,
            WebkitAppRegion: 'no-drag'
          }}
        >
          <PreviewFileIcon fontSize="small" sx={{ color: previewIcon.color, flexShrink: 0 }} />
          <Typography
            variant="subtitle2"
            sx={{
              flex: 1,
              minWidth: 0,
              fontWeight: 700,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {title}
          </Typography>
          <IconButton
            size="small"
            aria-label="关闭文件预览"
            onClick={onClose}
            sx={{ ml: 0.25, p: 0.35, flexShrink: 0 }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>
      </Tooltip>
    </Box>
  )
}

function FilePathBreadcrumb({
  rootLabel,
  displayPath,
  fullPath
}: {
  rootLabel: string
  displayPath: string
  fullPath: string
}): React.JSX.Element {
  const rawSegments = displayPath.split('/').filter(Boolean)
  const segments = rawSegments[0] === rootLabel ? rawSegments.slice(1) : rawSegments
  const items = [rootLabel, ...segments]
  const shownItems = items.length > 4 ? [items[0], '...', ...items.slice(-2)] : items

  return (
    <Tooltip title={fullPath} placement="top-start" arrow slotProps={pathTooltipSlotProps}>
      <Box
        aria-label={`文件路径：${items.join(' / ')}`}
        sx={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 0.65,
          color: 'text.secondary',
          overflow: 'hidden'
        }}
      >
        {shownItems.map((item, index) => (
          <Box
            key={`${item}-${index}`}
            component="span"
            sx={{
              minWidth: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.65,
              flexShrink: index === shownItems.length - 1 ? 1 : 0
            }}
          >
            {index > 0 ? (
              <BreadcrumbSeparatorIcon
                sx={{ fontSize: 16, color: 'text.disabled', flexShrink: 0 }}
              />
            ) : null}
            <Typography
              component="span"
              variant="caption"
              sx={{
                minWidth: 0,
                maxWidth: index === shownItems.length - 1 ? '100%' : 140,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: index === shownItems.length - 1 ? 'text.primary' : 'text.secondary',
                fontWeight: index === shownItems.length - 1 ? 700 : 500
              }}
            >
              {item}
            </Typography>
          </Box>
        ))}
      </Box>
    </Tooltip>
  )
}

function OpenWithMenu({
  path,
  onOpenDefaultPath,
  onRevealPath
}: {
  path: string
  onOpenDefaultPath: (path: string) => void
  onRevealPath: (path: string) => void
}): React.JSX.Element {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const isOpen = Boolean(anchorEl)
  const revealLabel = fileManagerLabel()

  const close = (): void => setAnchorEl(null)
  const runAction = (action: (path: string) => void): void => {
    close()
    action(path)
  }

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<DefaultOpenIcon sx={{ fontSize: 16 }} />}
        endIcon={<CollapseIcon sx={{ fontSize: 15 }} />}
        aria-label="打开方式"
        aria-haspopup="menu"
        aria-expanded={isOpen ? 'true' : undefined}
        onClick={(event) => setAnchorEl(event.currentTarget)}
        sx={{ minHeight: 30, px: 1.1, whiteSpace: 'nowrap' }}
      >
        打开
      </Button>
      <Menu anchorEl={anchorEl} open={isOpen} onClose={close} keepMounted>
        <MenuItem onClick={() => runAction(onOpenDefaultPath)}>
          <DefaultOpenIcon fontSize="small" sx={{ mr: 1 }} />
          默认应用
        </MenuItem>
        <MenuItem onClick={() => runAction(onRevealPath)}>
          <FolderIcon fontSize="small" sx={{ mr: 1 }} />
          {revealLabel}
        </MenuItem>
      </Menu>
    </>
  )
}

function syntaxTokenColor(theme: Theme, kind: SyntaxTokenKind): string {
  const isDark = theme.palette.mode === 'dark'
  const colors: Record<SyntaxTokenKind, string> = isDark
    ? {
        boolean: '#569CD6',
        comment: '#6A9955',
        function: '#DCDCAA',
        keyword: '#C586C0',
        number: '#B5CEA8',
        operator: '#D4D4D4',
        plain: theme.palette.text.primary,
        property: '#9CDCFE',
        punctuation: '#D4D4D4',
        string: '#CE9178',
        type: '#4EC9B0'
      }
    : {
        boolean: '#0000FF',
        comment: '#008000',
        function: '#795E26',
        keyword: '#AF00DB',
        number: '#098658',
        operator: '#000000',
        plain: theme.palette.text.primary,
        property: '#001080',
        punctuation: '#000000',
        string: '#A31515',
        type: '#267F99'
      }

  return colors[kind]
}

type SpreadsheetFormat = 'csv' | 'tsv'

type SpreadsheetPreviewModel = {
  format: SpreadsheetFormat
  rows: string[][]
  columnCount: number
  rowsTruncated: boolean
  columnsTruncated: boolean
}

function spreadsheetFormatForPath(path: string): SpreadsheetFormat | null {
  const name = path.split('/').pop()?.toLowerCase() ?? path.toLowerCase()
  if (name.endsWith('.csv')) return 'csv'
  if (name.endsWith('.tsv') || name.endsWith('.tab')) return 'tsv'
  return null
}

function spreadsheetDelimiter(format: SpreadsheetFormat): string {
  return format === 'tsv' ? '\t' : ','
}

function parseDelimitedText(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  const pushCell = (): void => {
    row.push(cell)
    cell = ''
  }

  const pushRow = (): void => {
    pushCell()
    rows.push(row)
    row = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (inQuotes) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        inQuotes = false
      } else {
        cell += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === delimiter) {
      pushCell()
      continue
    }
    if (char === '\n') {
      pushRow()
      continue
    }
    if (char === '\r') {
      if (text[index + 1] === '\n') index += 1
      pushRow()
      continue
    }

    cell += char
  }

  if (cell.length > 0 || row.length > 0 || text.endsWith(delimiter)) pushRow()
  return rows
}

function spreadsheetColumnLabel(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}

function spreadsheetPreviewModel(
  file: Extract<FilePreview, { kind: 'text' }>
): SpreadsheetPreviewModel | null {
  const format = spreadsheetFormatForPath(file.path)
  if (!format) return null

  const parsedRows = parseDelimitedText(file.content, spreadsheetDelimiter(format))
  const rows = parsedRows.slice(0, SPREADSHEET_ROW_LIMIT)
  const sourceColumnCount = Math.max(1, ...parsedRows.map((row) => row.length))
  const columnCount = Math.min(sourceColumnCount, SPREADSHEET_COLUMN_LIMIT)

  return {
    format,
    rows: rows.map((row) => row.slice(0, columnCount)),
    columnCount,
    rowsTruncated: parsedRows.length > rows.length,
    columnsTruncated: sourceColumnCount > columnCount
  }
}

function SpreadsheetPreview({ model }: { model: SpreadsheetPreviewModel }): React.JSX.Element {
  const firstCell = model.rows[0]?.[0] ?? ''
  const columns = Array.from({ length: model.columnCount }, (_, index) =>
    spreadsheetColumnLabel(index)
  )
  const gridTemplateColumns = `48px repeat(${model.columnCount}, minmax(108px, 180px))`

  return (
    <Box
      data-phi-spreadsheet-preview="true"
      data-phi-spreadsheet-format={model.format}
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default'
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1,
          py: 0.75,
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0
        }}
      >
        <Box
          component="span"
          data-phi-spreadsheet-name-box="true"
          sx={{
            flex: '0 0 64px',
            minWidth: 0,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            px: 1,
            py: 0.35,
            bgcolor: 'background.paper',
            color: 'text.secondary',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.78rem',
            textAlign: 'center'
          }}
        >
          A1
        </Box>
        <Box
          component="span"
          data-phi-spreadsheet-formula-bar="true"
          title={firstCell}
          sx={{
            flex: 1,
            minWidth: 0,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            px: 1,
            py: 0.35,
            bgcolor: 'background.paper',
            color: 'text.primary',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.78rem',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {firstCell}
        </Box>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns,
            minWidth: 'max-content',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.82rem',
            lineHeight: 1.45
          }}
        >
          <Box
            data-phi-spreadsheet-corner="true"
            sx={{
              position: 'sticky',
              top: 0,
              left: 0,
              zIndex: 4,
              height: 30,
              borderRight: 1,
              borderBottom: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper'
            }}
          />
          {columns.map((column) => (
            <Box
              key={column}
              data-phi-spreadsheet-column={column}
              sx={{
                position: 'sticky',
                top: 0,
                zIndex: 3,
                height: 30,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRight: 1,
                borderBottom: 1,
                borderColor: 'divider',
                bgcolor: 'background.paper',
                color: 'text.secondary',
                userSelect: 'none'
              }}
            >
              {column}
            </Box>
          ))}
          {model.rows.map((row, rowIndex) => (
            <Fragment key={`row-${rowIndex}`}>
              <Box
                component="span"
                data-phi-spreadsheet-row={rowIndex + 1}
                sx={{
                  position: 'sticky',
                  left: 0,
                  zIndex: 2,
                  height: 30,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  pr: 1,
                  borderRight: 1,
                  borderBottom: 1,
                  borderColor: 'divider',
                  bgcolor: 'background.paper',
                  color: 'text.secondary',
                  userSelect: 'none'
                }}
              >
                {rowIndex + 1}
              </Box>
              {columns.map((_, columnIndex) => {
                const value = row[columnIndex] ?? ''
                const isActive = rowIndex === 0 && columnIndex === 0

                return (
                  <Box
                    key={`${rowIndex}-${columnIndex}`}
                    component="span"
                    data-phi-spreadsheet-cell={`${spreadsheetColumnLabel(columnIndex)}${rowIndex + 1}`}
                    title={value}
                    sx={{
                      height: 30,
                      minWidth: 0,
                      display: 'flex',
                      alignItems: 'center',
                      px: 1,
                      borderRight: 1,
                      borderBottom: 1,
                      borderColor: 'divider',
                      bgcolor: 'background.default',
                      color: 'text.primary',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      boxShadow: isActive
                        ? (theme) => `inset 0 0 0 2px ${theme.palette.primary.main}`
                        : 'none'
                    }}
                  >
                    {value}
                  </Box>
                )
              })}
            </Fragment>
          ))}
        </Box>
      </Box>
      {model.rowsTruncated || model.columnsTruncated ? (
        <Typography
          data-phi-spreadsheet-truncated="true"
          variant="caption"
          color="text.secondary"
          sx={{ px: 1.25, py: 0.6, borderTop: 1, borderColor: 'divider', flexShrink: 0 }}
        >
          已显示前 {model.rows.length} 行、{model.columnCount} 列
        </Typography>
      ) : null}
    </Box>
  )
}

function CodePreview({
  file
}: {
  file: Extract<FilePreview, { kind: 'text' }>
}): React.JSX.Element {
  const lines = file.content.length > 0 ? file.content.split('\n') : ['']
  const language = languageForPath(file.path)

  return (
    <Box
      data-phi-syntax-language={language}
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: 'auto',
        bgcolor: 'background.default',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.82rem',
        lineHeight: 1.55
      }}
    >
      {lines.map((line, index) => (
        <Box
          key={index}
          sx={{
            display: 'grid',
            gridTemplateColumns: '48px minmax(0, 1fr)',
            minWidth: 'max-content'
          }}
        >
          <Box
            component="span"
            sx={{
              color: 'text.disabled',
              textAlign: 'right',
              pr: 1.5,
              userSelect: 'none',
              borderRight: 1,
              borderColor: 'divider'
            }}
          >
            {index + 1}
          </Box>
          <Box
            component="code"
            sx={{
              display: 'block',
              whiteSpace: 'pre',
              px: 1.5,
              color: 'text.primary'
            }}
          >
            {highlightLine(line, language).map((token, tokenIndex) => (
              <Box
                key={`${index}-${tokenIndex}`}
                component="span"
                data-phi-syntax-token={token.kind}
                sx={{ color: (theme) => syntaxTokenColor(theme, token.kind) }}
              >
                {token.value}
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

function MediaPreview({
  file
}: {
  file: Extract<FilePreview, { kind: 'image' | 'pdf' }>
}): React.JSX.Element {
  if (file.kind === 'image') {
    return (
      <Box
        data-phi-media-preview="image"
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: 'auto',
          p: 2,
          bgcolor: 'background.default',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <Box
          component="img"
          src={file.dataUrl}
          alt={file.name}
          sx={{
            display: 'block',
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            borderRadius: 1,
            boxShadow: (theme) => `0 0 0 1px ${theme.palette.divider}`
          }}
        />
      </Box>
    )
  }

  return (
    <Box
      data-phi-media-preview="pdf"
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        bgcolor: 'background.default',
        display: 'flex'
      }}
    >
      <Box
        component="iframe"
        src={file.dataUrl}
        title={file.name}
        aria-label={`PDF 预览：${file.name}`}
        sx={{
          flex: 1,
          width: '100%',
          height: '100%',
          border: 0,
          bgcolor: 'background.default'
        }}
      />
    </Box>
  )
}

export function ProjectFileTree({
  rootPath,
  activePath,
  onOpenFile,
  onListDirectory,
  initialListing,
  variant = 'sidebar'
}: {
  rootPath: string
  activePath: string
  onOpenFile: (path: string) => void
  onListDirectory: (path: string) => Promise<DirectoryListing>
  initialListing?: DirectoryListing
  variant?: 'sidebar' | 'standalone'
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set([rootPath]))
  const [directories, setDirectories] = useState<Record<string, DirectoryLoadState>>(() => ({
    [rootPath]:
      initialListing && initialListing.path === rootPath
        ? { status: 'ready', listing: initialListing }
        : { status: 'loading' }
  }))
  const normalizedQuery = query.trim().toLowerCase()
  const isStandalone = variant === 'standalone'

  const loadDirectory = useCallback(
    (path: string): void => {
      void onListDirectory(path)
        .then((listing) => {
          setDirectories((prev) => ({ ...prev, [path]: { status: 'ready', listing } }))
        })
        .catch((error) => {
          setDirectories((prev) => ({
            ...prev,
            [path]: {
              status: 'error',
              message: error instanceof Error ? error.message : '无法读取目录'
            }
          }))
        })
    },
    [onListDirectory]
  )

  const ensureDirectoryLoaded = useCallback(
    (path: string): void => {
      if (directories[path]) return
      setDirectories((prev) => ({ ...prev, [path]: { status: 'loading' } }))
      loadDirectory(path)
    },
    [directories, loadDirectory]
  )

  useEffect(() => {
    const rootState = directories[rootPath]
    if (rootState && rootState.status !== 'loading') return
    loadDirectory(rootPath)
  }, [directories, loadDirectory, rootPath])

  const toggleDirectory = (path: string): void => {
    const isExpanded = expandedPaths.has(path)
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (isExpanded) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
    if (!isExpanded) ensureDirectoryLoaded(path)
  }

  const visibleEntries = useCallback(
    (entries: FileTreeEntry[]): FileTreeEntry[] => {
      if (!normalizedQuery) return entries
      return entries.filter(
        (entry) =>
          entry.name.toLowerCase().includes(normalizedQuery) ||
          entry.displayPath.toLowerCase().includes(normalizedQuery)
      )
    },
    [normalizedQuery]
  )

  const renderDirectoryRows = (path: string, depth: number): ReactNode[] => {
    const state = directories[path]
    if (!state || state.status === 'loading') {
      return [
        <Box key={`${path}-loading`} sx={{ px: 1.5, py: 0.75, color: 'text.secondary' }}>
          <Typography variant="caption">正在读取目录</Typography>
        </Box>
      ]
    }
    if (state.status === 'error') {
      return [
        <Box key={`${path}-error`} sx={{ px: 1.5, py: 0.75 }}>
          <Alert severity="error" variant="outlined">
            {state.message}
          </Alert>
        </Box>
      ]
    }

    const entries = visibleEntries(state.listing.entries)
    if (entries.length === 0) {
      return [
        <Typography
          key={`${path}-empty`}
          data-phi-file-tree-empty="true"
          variant="caption"
          color="text.secondary"
          sx={{
            display: 'block',
            px: 1,
            py: 0.75,
            pl: 1 + depth * 1.75 + 2.5
          }}
        >
          {state.listing.entries.length === 0 ? '文件夹为空' : '没有匹配文件'}
        </Typography>
      ]
    }

    const rows = entries.flatMap((entry) => {
      const isDirectory = entry.kind === 'directory'
      const isExpanded = expandedPaths.has(entry.path)
      const isActive = entry.path === activePath
      const entryIcon = isDirectory ? FILE_TYPE_ICON_META.directory : fileIconForPath(entry.path)
      const EntryIcon = entryIcon.Icon
      const ChevronIcon = isExpanded ? CollapseIcon : ExpandIcon
      return [
        <Box
          key={entry.path}
          component="button"
          type="button"
          data-phi-file-kind={entryIcon.kind}
          title={entry.displayPath}
          onClick={() => {
            if (isDirectory) {
              toggleDirectory(entry.path)
            } else {
              onOpenFile(entry.path)
            }
          }}
          sx={{
            width: '100%',
            minHeight: 32,
            px: 1,
            py: 0.45,
            pl: 1 + depth * 1.75,
            border: 0,
            borderRadius: 1,
            bgcolor: (theme) => (isActive ? alpha(theme.palette.primary.main, 0.1) : 'transparent'),
            color: isActive ? 'primary.main' : 'text.primary',
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            '&:hover': {
              bgcolor: (theme) =>
                isActive
                  ? alpha(theme.palette.primary.main, 0.13)
                  : alpha(theme.palette.text.primary, 0.055)
            },
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: -2
            }
          }}
        >
          {isDirectory ? (
            <ChevronIcon fontSize="small" sx={{ color: 'text.secondary' }} />
          ) : (
            <Box sx={{ width: '1.25rem', flexShrink: 0 }} />
          )}
          <EntryIcon
            fontSize="small"
            sx={{ color: entryIcon.color, opacity: isDirectory ? 0.9 : 1 }}
          />
          <Typography
            variant="body2"
            sx={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: entry.name.startsWith('.') ? 'var(--font-mono)' : undefined
            }}
          >
            {entry.name}
          </Typography>
        </Box>,
        ...(isDirectory && isExpanded ? renderDirectoryRows(entry.path, depth + 1) : [])
      ]
    })

    if (state.listing.truncated) {
      rows.push(
        <Typography
          key={`${path}-truncated`}
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', px: 1.5, py: 0.75 }}
        >
          已显示前 400 项
        </Typography>
      )
    }

    return rows
  }

  const rootState = directories[rootPath]
  const rootName = useMemo(() => {
    if (rootState?.status === 'ready') return rootState.listing.name
    return fileNameFromPath(rootPath)
  }, [rootPath, rootState])
  const rootDisplayPath = rootState?.status === 'ready' ? rootState.listing.displayPath : rootPath
  const rootExpanded = expandedPaths.has(rootPath)
  const RootChevronIcon = rootExpanded ? CollapseIcon : ExpandIcon
  const rootActive = activePath === rootPath

  return (
    <Box
      aria-label="项目目录树"
      sx={{
        height: '100%',
        minHeight: 0,
        flex: isStandalone ? '1 1 auto' : '0 0 clamp(240px, 30%, 320px)',
        maxWidth: isStandalone ? 'none' : '42%',
        borderLeft: isStandalone ? 0 : 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0
      }}
    >
      <Box sx={{ px: 1.5, pt: 1.25, pb: 1 }}>
        <TextField
          size="small"
          fullWidth
          placeholder="筛选文件..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" color="action" />
                </InputAdornment>
              )
            }
          }}
        />
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0.75, pb: 0.75 }}>
        <Box
          component="button"
          type="button"
          data-phi-file-tree-root="true"
          data-phi-file-kind="directory"
          title={rootDisplayPath}
          aria-expanded={rootExpanded}
          onClick={() => toggleDirectory(rootPath)}
          sx={{
            width: '100%',
            minHeight: 34,
            px: 1,
            py: 0.45,
            border: 0,
            borderRadius: 1,
            bgcolor: (theme) =>
              rootActive ? alpha(theme.palette.primary.main, 0.1) : 'transparent',
            color: rootActive ? 'primary.main' : 'text.primary',
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            '&:hover': {
              bgcolor: (theme) =>
                rootActive
                  ? alpha(theme.palette.primary.main, 0.13)
                  : alpha(theme.palette.text.primary, 0.055)
            },
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: -2
            }
          }}
        >
          <RootChevronIcon fontSize="small" sx={{ color: 'text.secondary' }} />
          <FolderIcon fontSize="small" sx={{ color: FILE_TYPE_ICON_META.directory.color }} />
          <Typography
            variant="body2"
            sx={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: rootActive ? 700 : 500
            }}
          >
            {rootName}
          </Typography>
        </Box>
        {rootExpanded ? renderDirectoryRows(rootPath, 1) : null}
      </Box>
    </Box>
  )
}

function PreviewBody({
  state,
  onOpenFile,
  onListDirectory
}: {
  state: FilePreviewPanelState
  onOpenFile: (path: string) => void
  onListDirectory: (path: string) => Promise<DirectoryListing>
}): React.JSX.Element {
  if (state.status === 'loading') {
    return (
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          color: 'text.secondary'
        }}
      >
        <CircularProgress size={18} />
        <Typography variant="body2">
          {state.pathKind === 'directory' ? '正在读取目录' : '正在读取文件'}
        </Typography>
      </Box>
    )
  }

  if (state.status === 'error') {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error" variant="outlined">
          {state.message}
        </Alert>
      </Box>
    )
  }

  if (state.status === 'directory') {
    return (
      <ProjectFileTree
        key={state.directory.path}
        rootPath={state.directory.path}
        activePath={state.directory.path}
        initialListing={state.directory}
        variant="standalone"
        onOpenFile={onOpenFile}
        onListDirectory={onListDirectory}
      />
    )
  }

  if (state.file.kind === 'image' || state.file.kind === 'pdf') {
    return <MediaPreview file={state.file} />
  }

  const spreadsheetModel = spreadsheetPreviewModel(state.file)

  return (
    <>
      {state.file.truncated ? (
        <Alert severity="info" variant="outlined" sx={{ m: 1.5, mb: 0 }}>
          文件较大，已预览前 {formatBytes(state.file.previewBytes)} /{' '}
          {formatBytes(state.file.bytes)}
        </Alert>
      ) : null}
      {spreadsheetModel ? (
        <SpreadsheetPreview model={spreadsheetModel} />
      ) : (
        <CodePreview file={state.file} />
      )}
    </>
  )
}

export default function FilePreviewPanel({
  state,
  onOpenFile,
  onOpenDefaultPath,
  onRevealPath,
  onListDirectory
}: FilePreviewPanelProps): React.JSX.Element {
  const [treeOpen, setTreeOpen] = useState(false)
  const path = previewFullPath(state)
  const displayPath = previewDisplayPath(state)
  const treeRootPath = previewTreeRootPath(state)
  const rootLabel = previewRootLabel(state)
  const previewIcon = previewIconForState(state)
  const isDirectoryState = state.status === 'directory'
  const treeToggleLabel = treeOpen ? '隐藏目录树' : '显示目录树'

  return (
    <Box
      component="aside"
      aria-label="文件预览"
      data-phi-file-kind={previewIcon.kind}
      sx={{
        ...filePreviewPaneLayoutSx,
        borderLeft: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0
      }}
    >
      <Box
        sx={{
          px: 1.5,
          py: 1,
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          flexShrink: 0
        }}
      >
        <FilePathBreadcrumb rootLabel={rootLabel} displayPath={displayPath} fullPath={path} />
        {isDirectoryState ? null : (
          <Tooltip title={treeToggleLabel} enterDelay={400}>
            <IconButton
              size="small"
              aria-label={treeToggleLabel}
              aria-pressed={treeOpen}
              onClick={() => setTreeOpen((open) => !open)}
              sx={(theme) => ({
                width: 34,
                height: 30,
                border: 1,
                borderColor: treeOpen ? 'primary.main' : 'divider',
                borderRadius: 2,
                color: treeOpen ? 'primary.main' : 'text.secondary',
                bgcolor: treeOpen
                  ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.1)
                  : 'transparent',
                '&:hover': {
                  borderColor: 'primary.main',
                  bgcolor: alpha(
                    theme.palette.primary.main,
                    theme.palette.mode === 'dark' ? 0.24 : 0.14
                  ),
                  color: 'primary.main'
                }
              })}
            >
              <DirectoryTreeIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        )}
        <OpenWithMenu
          path={path}
          onOpenDefaultPath={onOpenDefaultPath}
          onRevealPath={onRevealPath}
        />
      </Box>

      <Box
        data-phi-file-preview-content={isDirectoryState ? 'directory' : 'split'}
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex'
        }}
      >
        <Box
          data-phi-file-preview-pane={isDirectoryState ? 'directory' : 'file'}
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          <PreviewBody state={state} onOpenFile={onOpenFile} onListDirectory={onListDirectory} />
        </Box>
        {!isDirectoryState && treeOpen ? (
          <ProjectFileTree
            key={treeRootPath}
            rootPath={treeRootPath}
            activePath={path}
            onOpenFile={onOpenFile}
            onListDirectory={onListDirectory}
          />
        ) : null}
      </Box>
    </Box>
  )
}
