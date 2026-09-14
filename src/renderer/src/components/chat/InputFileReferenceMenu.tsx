import {
  Box,
  CircularProgress,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Typography
} from '@mui/material'
import type { ReactNode } from 'react'
import { directoryIconForPath, fileIconForPath } from '../../icons'
import type { FileTreeEntry } from '../../types'

export type InputFileReferenceMenuState =
  | { status: 'loading'; query: string; directoryPath: string }
  | { status: 'ready'; query: string; directoryPath: string; entries: FileTreeEntry[] }
  | { status: 'error'; query: string; directoryPath: string; message: string }

type InputFileReferenceMenuProps = {
  state: InputFileReferenceMenuState
  highlightedIndex: number
  onHighlight: (index: number) => void
  onSelect: (entry: FileTreeEntry) => void
}

function InputFileReferenceStatusRow({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Typography
      variant="body2"
      color="text.secondary"
      sx={{
        px: 1.25,
        py: 1,
        minHeight: 38,
        display: 'flex',
        alignItems: 'center',
        gap: 1
      }}
    >
      {children}
    </Typography>
  )
}

function InputFileReferenceRow({
  entry,
  highlighted,
  onHighlight,
  onSelect
}: {
  entry: FileTreeEntry
  highlighted: boolean
  onHighlight: () => void
  onSelect: () => void
}): React.JSX.Element {
  const iconMeta =
    entry.kind === 'directory'
      ? directoryIconForPath(entry.path, false)
      : fileIconForPath(entry.path)
  const EntryIcon = iconMeta.Icon

  return (
    <ListItemButton
      dense
      role="option"
      aria-selected={highlighted}
      selected={highlighted}
      title={entry.displayPath}
      onMouseEnter={onHighlight}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      sx={{
        borderRadius: 1.5,
        minHeight: 40,
        gap: 0.75,
        px: 1,
        py: 0.5,
        '&.Mui-selected': {
          bgcolor: 'action.hover',
          '&:hover': { bgcolor: 'action.selected' }
        }
      }}
    >
      <ListItemIcon sx={{ minWidth: 30, color: iconMeta.color }}>
        <EntryIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText
        primary={entry.name}
        secondary={entry.displayPath}
        slotProps={{
          primary: { noWrap: true, sx: { fontSize: '0.9rem', fontWeight: 750 } },
          secondary: { noWrap: true, sx: { fontSize: '0.78rem' } }
        }}
      />
    </ListItemButton>
  )
}

export function InputFileReferenceMenu({
  state,
  highlightedIndex,
  onHighlight,
  onSelect
}: InputFileReferenceMenuProps): React.JSX.Element {
  return (
    <Paper
      variant="outlined"
      role="listbox"
      aria-label="引用当前工作路径文件"
      sx={{
        width: '100%',
        mb: 1,
        borderRadius: 2,
        bgcolor: 'background.paper',
        maxHeight: 'min(300px, calc(100vh - 260px))',
        overflowY: 'auto',
        p: 0.75
      }}
    >
      <Box sx={{ px: 1, pt: 0.5, pb: 0.75 }}>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontSize: '0.8rem', fontWeight: 800, letterSpacing: 0 }}
        >
          @{state.query || '当前工作路径'}
        </Typography>
      </Box>
      {state.status === 'loading' ? (
        <InputFileReferenceStatusRow>
          <CircularProgress size={14} color="inherit" /> 正在读取文件
        </InputFileReferenceStatusRow>
      ) : null}
      {state.status === 'error' ? (
        <InputFileReferenceStatusRow>{state.message}</InputFileReferenceStatusRow>
      ) : null}
      {state.status === 'ready' && state.entries.length === 0 ? (
        <InputFileReferenceStatusRow>没有匹配文件</InputFileReferenceStatusRow>
      ) : null}
      {state.status === 'ready'
        ? state.entries.map((entry, index) => (
            <InputFileReferenceRow
              key={entry.path}
              entry={entry}
              highlighted={index === highlightedIndex}
              onHighlight={() => onHighlight(index)}
              onSelect={() => onSelect(entry)}
            />
          ))
        : null}
    </Paper>
  )
}
