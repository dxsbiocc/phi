import { Box, Collapse, Typography } from '@mui/material'
import { useState, type ReactNode } from 'react'
import { PhiIcons } from '../icons'
import { ToolActionIcon } from './ToolActionIcon'
import ToolCallCard, { StatusIndicator, ToolCallDetail } from './ToolCallCard'
import { diffStat } from '../lib/toolOutput'
import { toolActionKind, type ToolActionKind } from '../lib/toolActions'
import type { NotebookCellJumpTarget, ToolCallItem } from '../types'
import {
  useCollapseResizeNotifier,
  type ChatContentResizeHandler
} from './chat/useCollapseResizeNotifier'

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
  return `${shown}, and ${files.length - MAX_FILES_SHOWN} more`
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)]
}

function uniqueActions(items: ToolCallItem[]): ToolActionKind[] {
  return uniqueInOrder(
    items.map((item) => toolActionKind(item.toolName, item.argsPreview, item.argsJson))
  ) as ToolActionKind[]
}

function capitalize(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text
}

type AggregateToolStatus = 'running' | 'done'

function commandPhrase(count: number, status: AggregateToolStatus): string {
  if (status === 'running') return count === 1 ? '执行命令' : `执行 ${count} 条命令`
  return count === 1 ? '已执行命令' : `已执行 ${count} 条命令`
}

function pythonPhrase(count: number, status: AggregateToolStatus): string {
  if (status === 'running') return count === 1 ? '执行 Python 代码' : `执行 ${count} 段 Python 代码`
  return count === 1 ? '已执行 Python 代码' : `已执行 ${count} 段 Python 代码`
}

function notebookPhrase(count: number, status: AggregateToolStatus): string {
  if (status === 'running') return count === 1 ? '操作 Notebook' : `操作 ${count} 次 Notebook`
  return count === 1 ? '已操作 Notebook' : `已操作 ${count} 次 Notebook`
}

function fileToolPhrase(
  action: 'read' | 'edit' | 'read-edit',
  files: string,
  status: AggregateToolStatus
): string {
  const phrases = {
    read: {
      running: `读取 ${files}`,
      done: `已读取 ${files}`
    },
    edit: {
      running: `编辑 ${files}`,
      done: `已编辑 ${files}`
    },
    'read-edit': {
      running: `读取和编辑 ${files}`,
      done: `已读取和编辑 ${files}`
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

function summarize(items: ToolCallItem[]): {
  headline: string
  stat: { added: number; removed: number } | null
} {
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
        ? `${items.length} 个工具调用`
        : `已运行 ${items.length} 个工具调用`

  return { headline, stat: aggregateStat(items) }
}

function summarizeStatus(items: ToolCallItem[]): AggregateToolStatus {
  if (items.some((item) => item.status === 'running')) return 'running'
  return 'done'
}

function groupIndicatorStatus(items: ToolCallItem[]): ToolCallItem['status'] | null {
  if (items.some((item) => item.status === 'running')) return 'running'
  if (items.every((item) => item.status === 'done')) return 'done'
  return null
}

function ToolGroupCard({
  items,
  cwd,
  onJumpToNotebookCell,
  onContentResize
}: {
  items: ToolCallItem[]
  cwd?: string
  onJumpToNotebookCell?: (target: NotebookCellJumpTarget) => void
  onContentResize?: ChatContentResizeHandler
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const notifyContentResize = useCollapseResizeNotifier(onContentResize)
  const toggle = (): void => {
    setExpanded((value) => !value)
    notifyContentResize()
  }
  const { headline, stat } = summarize(items)
  const indicatorStatus = groupIndicatorStatus(items)
  const actions = uniqueActions(items)

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
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, flexShrink: 0 }}>
          {actions.map((action) => (
            <ToolActionIcon key={action} action={action} />
          ))}
        </Box>
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
        {indicatorStatus ? (
          <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <StatusIndicator status={indicatorStatus} />
          </Box>
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
          <Box sx={{ ml: 2.5, pl: 1.5, minWidth: 0, borderLeft: 2, borderColor: 'grey.800' }}>
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
          </Box>
        )}
      </Collapse>
    </Box>
  )
}

export default ToolGroupCard
