import { chatCopy } from '../features/chat/lib/chatCopy'
import { nestedFoldChevronRevealSx } from '../features/chat/lib/nestedFoldChevronStyles'
import { useUiLanguage } from '../lib/i18n'
import { Box, Collapse, Typography } from '@mui/material'
import { memo, useMemo, useState, type ReactNode } from 'react'
import { PhiIcons } from '../icons'
import { ToolActionIcon } from './ToolActionIcon'
import ToolCallCard, { StatusIndicator, ToolCallDetail } from './ToolCallCard'
import { diffStat } from '../lib/toolOutput'
import { toolActionKind } from '../lib/toolActions'
import type { NotebookCellJumpTarget, ToolCallItem } from '../types'
import {
  useCollapseResizeNotifier,
  type ChatContentResizeHandler
} from './chat/useCollapseResizeNotifier'
import { TimelineRail } from './chat/TimelineRail'

const ChevronRightIcon = PhiIcons.action.back

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
  return chatCopy.moreFiles(shown, files.length - MAX_FILES_SHOWN)
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)]
}

function capitalize(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text
}

type AggregateToolStatus = 'running' | 'done'

function commandPhrase(count: number, status: AggregateToolStatus): string {
  if (status === 'running')
    return count === 1 ? chatCopy.executeCommand : chatCopy.executeValueCommands(count)
  return count === 1 ? chatCopy.commandExecuted : chatCopy.valueCommandsExecuted(count)
}

function pythonPhrase(count: number, status: AggregateToolStatus): string {
  if (status === 'running')
    return count === 1 ? chatCopy.executePythonCode : chatCopy.executeValuePythonSnippets(count)
  return count === 1 ? chatCopy.pythonCodeExecuted : chatCopy.valuePythonSnippetsExecuted(count)
}

function notebookPhrase(count: number, status: AggregateToolStatus): string {
  if (status === 'running')
    return count === 1 ? chatCopy.notebookOperation : chatCopy.performValueNotebookOperations(count)
  return count === 1
    ? chatCopy.notebookOperationCompleted
    : chatCopy.valueNotebookOperationsCompleted(count)
}

function fileToolPhrase(
  action: 'read' | 'edit' | 'read-edit',
  files: string,
  status: AggregateToolStatus
): string {
  const phrases = {
    read: {
      running: chatCopy.readValue(files),
      done: chatCopy.readValue2(files)
    },
    edit: {
      running: chatCopy.editValue(files),
      done: chatCopy.editedValue(files)
    },
    'read-edit': {
      running: chatCopy.readAndEditValue(files),
      done: chatCopy.readAndEditedValue(files)
    }
  } satisfies Record<typeof action, Record<AggregateToolStatus, string>>

  return phrases[action][status]
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

function summarize(items: ToolCallItem[]): string {
  const status = summarizeStatus(items)
  const nonFileReadItems = items.filter(
    (item) => !FILE_TOOLS.has(item.toolName) && item.toolName !== 'read'
  )
  const pythonItems = nonFileReadItems.filter(
    (item) => toolActionKind(item.toolName, item.argsPreview, item.argsJson) === 'python'
  )
  const notebookItems = nonFileReadItems.filter(
    (item) => toolActionKind(item.toolName, item.argsPreview, item.argsJson) === 'notebook'
  )
  const commandItems = nonFileReadItems.filter((item) => {
    const action = toolActionKind(item.toolName, item.argsPreview, item.argsJson)
    return action !== 'python' && action !== 'notebook'
  })
  const editedFiles = uniqueInOrder(
    items.filter((item) => FILE_TOOLS.has(item.toolName)).map((item) => basename(item.argsPreview))
  )
  // Not deduped against editedFiles here: a file that was both read and edited
  // should still trigger the "read and edited" verb clause below, matching it
  // once in the joined file list rather than silently losing the "read" verb.
  const readFiles = uniqueInOrder(
    items.filter((item) => item.toolName === 'read').map((item) => basename(item.argsPreview))
  )

  const clauses: string[] = []
  if (pythonItems.length > 0) {
    clauses.push(pythonPhrase(pythonItems.length, status))
  }
  if (notebookItems.length > 0) {
    clauses.push(notebookPhrase(notebookItems.length, status))
  }
  if (commandItems.length > 0) {
    clauses.push(commandPhrase(commandItems.length, status))
  }
  if (readFiles.length > 0 && editedFiles.length > 0) {
    clauses.push(
      fileToolPhrase('read-edit', joinFiles(uniqueInOrder([...readFiles, ...editedFiles])), status)
    )
  } else if (editedFiles.length > 0) {
    clauses.push(fileToolPhrase('edit', joinFiles(editedFiles), status))
  } else if (readFiles.length > 0) {
    clauses.push(fileToolPhrase('read', joinFiles(readFiles), status))
  }

  const headline =
    clauses.length > 0
      ? capitalize(clauses.join(', '))
      : status === 'running'
        ? chatCopy.valueToolCalls(items.length)
        : chatCopy.valueToolCallsCompleted(items.length)

  return headline
}

function summarizeStatus(items: ToolCallItem[]): AggregateToolStatus {
  if (items.some((item) => item.status === 'running')) return 'running'
  return 'done'
}

function groupIndicatorStatus(items: ToolCallItem[]): ToolCallItem['status'] | null {
  if (items.some((item) => item.status === 'running')) return 'running'
  if (items.every((item) => item.status === 'error')) return 'error'
  if (items.every((item) => item.status === 'done')) return 'done'
  return null
}

type ToolGroupCardProps = {
  items: ToolCallItem[]
  cwd?: string
  onJumpToNotebookCell?: (target: NotebookCellJumpTarget) => void
  onContentResize?: ChatContentResizeHandler
}

function ToolGroupCard({
  items,
  cwd,
  onJumpToNotebookCell,
  onContentResize
}: ToolGroupCardProps): ReactNode {
  useUiLanguage()
  const [expanded, setExpanded] = useState(false)
  const notifyContentResize = useCollapseResizeNotifier(onContentResize)
  const toggle = (): void => {
    setExpanded((value) => !value)
    notifyContentResize()
  }
  const headline = summarize(items)
  const stat = useMemo(() => aggregateStat(items), [items])
  const indicatorStatus = useMemo(() => groupIndicatorStatus(items), [items])

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
          transition: 'color 150ms',
          ...nestedFoldChevronRevealSx,
          '&:hover': { color: 'text.primary' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        {indicatorStatus ? (
          <Box
            sx={{
              width: 18,
              height: 18,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <StatusIndicator status={indicatorStatus} />
          </Box>
        ) : (
          <ToolActionIcon action="generic" />
        )}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flex: 1, minWidth: 0 }}>
          <Typography
            component="span"
            variant="body2"
            noWrap
            sx={{ flex: '0 1 auto', minWidth: 0 }}
          >
            {headline}
          </Typography>
          <ChevronRightIcon
            className="phi-nested-fold-chevron"
            aria-hidden
            sx={{
              fontSize: 16,
              flexShrink: 0,
              transform: expanded ? 'rotate(90deg)' : 'none'
            }}
          />
        </Box>
        {stat ? (
          <Typography
            component="span"
            variant="caption"
            title={chatCopy.diffLineCountsValue(stat.added, stat.removed)}
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
      </Box>
      <Collapse
        in={expanded}
        unmountOnExit
        onEnter={notifyContentResize}
        onEntering={notifyContentResize}
        onEntered={notifyContentResize}
        onExit={notifyContentResize}
        onExiting={notifyContentResize}
        onExited={notifyContentResize}
      >
        {items.length === 1 ? (
          // A single call: show its args/output directly under this row instead
          // of nesting another independently-collapsible ToolCallCard inside it
          // (that would need two clicks to reach the same detail).
          <ToolCallDetail item={items[0]} cwd={cwd} />
        ) : (
          <TimelineRail>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, py: 0.5 }}>
              {items.map((item) => (
                <ToolCallCard
                  key={item.id}
                  item={item}
                  cwd={cwd}
                  onJumpToNotebookCell={onJumpToNotebookCell}
                  onContentResize={onContentResize}
                />
              ))}
            </Box>
          </TimelineRail>
        )}
      </Collapse>
    </Box>
  )
}

function sameItemsByReference(a: ToolCallItem[], b: ToolCallItem[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// groupMessages rebuilds each group's `items` array on every call even when
// the underlying ToolCallItem objects are unchanged, so compare by element
// reference rather than array identity to avoid re-rendering (and re-running
// diffStat/summarize over) tool groups unrelated to the message currently
// streaming in.
function toolGroupCardPropsEqual(prev: ToolGroupCardProps, next: ToolGroupCardProps): boolean {
  return sameItemsByReference(prev.items, next.items) && prev.cwd === next.cwd
}

export default memo(ToolGroupCard, toolGroupCardPropsEqual)
