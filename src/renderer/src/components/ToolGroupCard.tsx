import { ChevronRight as ChevronRightIcon } from '@mui/icons-material'
import { Box, Collapse, Typography } from '@mui/material'
import { useState, type ReactNode } from 'react'
import ToolCallCard, { StatusIndicator, ToolCallDetail, diffStat } from './ToolCallCard'
import type { ToolCallItem } from '../types'

const FILE_TOOLS = new Set(['edit', 'write'])
const MAX_FILES_SHOWN = 2

function basename(path: string): string {
  const trimmed = path.trim()
  const segments = trimmed.split('/')
  return segments[segments.length - 1] || trimmed
}

function joinFiles(files: string[]): string {
  if (files.length <= MAX_FILES_SHOWN) return files.join(', ')
  const shown = files.slice(0, MAX_FILES_SHOWN).join(', ')
  return `${shown}, and ${files.length - MAX_FILES_SHOWN} more`
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)]
}

function capitalize(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text
}

function pluralCommands(count: number): string {
  return count === 1 ? 'Ran a command' : `Ran ${count} commands`
}

function aggregateStat(items: ToolCallItem[]): { added: number; removed: number } | null {
  return items.reduce<{ added: number; removed: number } | null>((acc, item) => {
    const itemStat = item.output ? diffStat(item.output) : null
    if (!itemStat) return acc
    return {
      added: (acc?.added ?? 0) + itemStat.added,
      removed: (acc?.removed ?? 0) + itemStat.removed
    }
  }, null)
}

function summarize(items: ToolCallItem[]): {
  headline: string
  stat: { added: number; removed: number } | null
} {
  const commandItems = items.filter(
    (item) => !FILE_TOOLS.has(item.toolName) && item.toolName !== 'read'
  )
  const editedFiles = uniqueInOrder(
    items.filter((item) => FILE_TOOLS.has(item.toolName)).map((item) => basename(item.argsPreview))
  )
  // Not deduped against editedFiles here: a file that was both read and edited
  // should still trigger the "read and edited" verb clause below, matching it
  // once in the joined file list rather than silently losing the "read" verb.
  const readFiles = uniqueInOrder(
    items.filter((item) => item.toolName === 'read').map((item) => basename(item.argsPreview))
  )

  // A single, file-less command call is more useful shown verbatim (it's
  // already specific) than folded into the generic "Ran a command" phrasing.
  if (
    items.length === 1 &&
    commandItems.length === 1 &&
    editedFiles.length === 0 &&
    readFiles.length === 0
  ) {
    return { headline: items[0].argsPreview || items[0].toolName, stat: aggregateStat(items) }
  }

  const clauses: string[] = []
  if (commandItems.length > 0) {
    clauses.push(pluralCommands(commandItems.length))
  }
  if (readFiles.length > 0 && editedFiles.length > 0) {
    clauses.push(`read and edited ${joinFiles(uniqueInOrder([...readFiles, ...editedFiles]))}`)
  } else if (editedFiles.length > 0) {
    clauses.push(`edited ${joinFiles(editedFiles)}`)
  } else if (readFiles.length > 0) {
    clauses.push(`read ${joinFiles(readFiles)}`)
  }

  const headline =
    clauses.length > 0 ? capitalize(clauses.join(', ')) : `Ran ${items.length} tool calls`

  return { headline, stat: aggregateStat(items) }
}

function groupStatus(items: ToolCallItem[]): ToolCallItem['status'] {
  if (items.some((item) => item.status === 'running')) return 'running'
  if (items.some((item) => item.status === 'error')) return 'error'
  return 'done'
}

function ToolGroupCard({ items }: { items: ToolCallItem[] }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const toggle = (): void => setExpanded((value) => !value)
  const { headline, stat } = summarize(items)

  return (
    <Box sx={{ alignSelf: 'stretch', minWidth: 0 }}>
      <Box
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggle()
          }
        }}
        aria-expanded={expanded}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          minWidth: 0,
          py: 0.5,
          px: 0.5,
          borderRadius: 1,
          cursor: 'pointer',
          color: 'text.secondary',
          transition: 'background-color 150ms',
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        <ChevronRightIcon
          sx={{
            fontSize: 16,
            flexShrink: 0,
            transition: 'transform 150ms',
            transform: expanded ? 'rotate(90deg)' : 'none'
          }}
        />
        <Typography component="span" variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {headline}
        </Typography>
        {stat ? (
          <Typography
            component="span"
            variant="caption"
            sx={{ flexShrink: 0, fontFamily: 'var(--font-mono)' }}
          >
            {stat.added ? (
              <Box component="span" sx={{ color: 'success.main' }}>
                +{stat.added}{' '}
              </Box>
            ) : null}
            {stat.removed ? (
              <Box component="span" sx={{ color: 'error.main' }}>
                -{stat.removed}
              </Box>
            ) : null}
          </Typography>
        ) : null}
        <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          <StatusIndicator status={groupStatus(items)} />
        </Box>
      </Box>
      <Collapse in={expanded} unmountOnExit>
        {items.length === 1 ? (
          // A single call: show its args/output directly under this row instead
          // of nesting another independently-collapsible ToolCallCard inside it
          // (that would need two clicks to reach the same detail).
          <ToolCallDetail item={items[0]} />
        ) : (
          <Box sx={{ ml: 2.5, pl: 1.5, minWidth: 0, borderLeft: 2, borderColor: 'grey.800' }}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, py: 0.5 }}>
              {items.map((item) => (
                <ToolCallCard key={item.id} item={item} />
              ))}
            </Box>
          </Box>
        )}
      </Collapse>
    </Box>
  )
}

export default ToolGroupCard
