import type { DirectoryListing, FileTreeEntry } from '../../../types'

export type DirectoryLoadState =
  | { status: 'loading' }
  | { status: 'ready'; listing: DirectoryListing }
  | { status: 'error'; message: string }

export type FileTreeRowDescriptor =
  | { id: string; kind: 'entry'; entry: FileTreeEntry; depth: number }
  | { id: string; kind: 'error'; path: string; message: string }
  | { id: string; kind: 'empty'; path: string; depth: number; isEmpty: boolean }
  | { id: string; kind: 'truncated'; path: string }

export function fileNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function matchesQuery(entry: FileTreeEntry, normalizedQuery: string): boolean {
  return (
    entry.name.toLowerCase().includes(normalizedQuery) ||
    entry.displayPath.toLowerCase().includes(normalizedQuery)
  )
}

// Flattens the (recursively expandable) directory tree into a single list of
// row descriptors — data, not JSX — so the list can be windowed the same way
// the chat and notebook lists are: only rows near the viewport get rendered,
// with spacer boxes preserving the scrollable height for the rest.
export function flattenDirectoryRows(
  path: string,
  depth: number,
  directories: Record<string, DirectoryLoadState>,
  expandedPaths: Set<string>,
  normalizedQuery: string
): FileTreeRowDescriptor[] {
  const state = directories[path]
  if (!state || state.status === 'loading') {
    return []
  }
  if (state.status === 'error') {
    return [{ id: `${path}-error`, kind: 'error', path, message: state.message }]
  }

  const entries = normalizedQuery
    ? state.listing.entries.filter((entry) => matchesQuery(entry, normalizedQuery))
    : state.listing.entries
  if (entries.length === 0) {
    return [
      {
        id: `${path}-empty`,
        kind: 'empty',
        path,
        depth,
        isEmpty: state.listing.entries.length === 0
      }
    ]
  }

  const rows: FileTreeRowDescriptor[] = []
  for (const entry of entries) {
    rows.push({ id: entry.path, kind: 'entry', entry, depth })
    if (entry.kind === 'directory' && expandedPaths.has(entry.path)) {
      rows.push(
        ...flattenDirectoryRows(entry.path, depth + 1, directories, expandedPaths, normalizedQuery)
      )
    }
  }

  if (state.listing.truncated) {
    rows.push({ id: `${path}-truncated`, kind: 'truncated', path })
  }

  return rows
}
