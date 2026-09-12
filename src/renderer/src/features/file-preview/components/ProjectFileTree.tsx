import { Box, InputAdornment, TextField } from '@mui/material'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { PhiIcons } from '../../../icons'
import type { DirectoryListing, FileTreeEntry } from '../../../types'
import { FileTreeRootRow } from './FileTreeRootRow'
import { FileTreeRow } from './FileTreeRow'
import {
  FileTreeEmptyRow,
  FileTreeErrorRow,
  FileTreeLoadingRow,
  FileTreeTruncatedRow
} from './FileTreeStatusRows'

const SearchIcon = PhiIcons.action.search

type DirectoryLoadState =
  | { status: 'loading' }
  | { status: 'ready'; listing: DirectoryListing }
  | { status: 'error'; message: string }

type ProjectFileTreeProps = {
  rootPath: string
  activePath: string
  onOpenFile: (path: string) => void
  onListDirectory: (path: string) => Promise<DirectoryListing>
  initialListing?: DirectoryListing
  variant?: 'sidebar' | 'standalone'
}

function fileNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function ProjectFileTree({
  rootPath,
  activePath,
  onOpenFile,
  onListDirectory,
  initialListing,
  variant = 'sidebar'
}: ProjectFileTreeProps): React.JSX.Element {
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
      return [<FileTreeLoadingRow key={`${path}-loading`} path={path} />]
    }
    if (state.status === 'error') {
      return [<FileTreeErrorRow key={`${path}-error`} path={path} message={state.message} />]
    }

    const entries = visibleEntries(state.listing.entries)
    if (entries.length === 0) {
      return [
        <FileTreeEmptyRow
          key={`${path}-empty`}
          path={path}
          depth={depth}
          isEmpty={state.listing.entries.length === 0}
        />
      ]
    }

    const rows = entries.flatMap((entry) => {
      const isDirectory = entry.kind === 'directory'
      const isExpanded = expandedPaths.has(entry.path)
      const isActive = entry.path === activePath
      return [
        <FileTreeRow
          key={entry.path}
          entry={entry}
          depth={depth}
          isExpanded={isExpanded}
          isActive={isActive}
          onClick={() => {
            if (isDirectory) {
              toggleDirectory(entry.path)
            } else {
              onOpenFile(entry.path)
            }
          }}
        />,
        ...(isDirectory && isExpanded ? renderDirectoryRows(entry.path, depth + 1) : [])
      ]
    })

    if (state.listing.truncated) {
      rows.push(<FileTreeTruncatedRow key={`${path}-truncated`} path={path} />)
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
        <FileTreeRootRow
          rootPath={rootPath}
          rootName={rootName}
          rootDisplayPath={rootDisplayPath}
          isExpanded={rootExpanded}
          isActive={rootActive}
          onToggle={() => toggleDirectory(rootPath)}
        />
        {rootExpanded ? renderDirectoryRows(rootPath, 1) : null}
      </Box>
    </Box>
  )
}
