import {
  Alert,
  AlertTitle,
  Box,
  Button,
  ListItemIcon,
  Collapse,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Popover,
  Slider,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import MarkdownContent from './MarkdownContent'
import ToolCallCard, { StatusIndicator } from './ToolCallCard'
import ToolGroupCard from './ToolGroupCard'
import ToolApprovalDialog from './ToolApprovalDialog'
import { PERMISSION_MODE_ICON_META, PhiIcons } from '../icons'
import { getProviderErrorDisplay } from '../lib/providerErrors'
import type {
  ChatItem,
  ChatMessage,
  ModelOption,
  PermissionMode,
  RunLifecycleItem,
  ThinkingLevel,
  ToolApprovalRequest,
  ToolCallItem
} from '../types'

const BoltIcon = PhiIcons.action.quick
const CheckIcon = PhiIcons.state.check
const ChevronRightIcon = PhiIcons.action.back
const ExpandLessIcon = PhiIcons.action.collapse
const PsychologyIcon = PhiIcons.state.thinking
const SendIcon = PhiIcons.action.send
const StopIcon = PhiIcons.action.stop

type VisibleChatItem = ChatMessage | ToolCallItem

type RenderGroup =
  | { kind: 'tool-group'; key: string; items: ToolCallItem[] }
  | {
      kind: 'processing-group'
      key: string
      items: ProcessingItem[]
      startedAtMs?: number
      completedAtMs?: number
      durationMs?: number
    }
  | { kind: 'single'; key: string; item: VisibleChatItem }

type ProcessingItem =
  ToolCallItem | (ChatMessage & { role: 'assistant' | 'error' | 'warning' | 'thinking' })

function isRunLifecycleItem(message: ChatItem): message is RunLifecycleItem {
  return message.role === 'run'
}

function isVisibleChatItem(message: ChatItem): message is VisibleChatItem {
  return !isRunLifecycleItem(message)
}

function groupConsecutiveTools(messages: ChatItem[]): RenderGroup[] {
  const groups: RenderGroup[] = []
  let run: ToolCallItem[] = []

  const flushRun = (): void => {
    if (run.length === 0) return
    if (run.length === 1) {
      groups.push({ kind: 'single', key: run[0].id, item: run[0] })
    } else {
      groups.push({ kind: 'tool-group', key: run[0].id, items: run })
    }
    run = []
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      run.push(message)
    } else if (isVisibleChatItem(message)) {
      flushRun()
      groups.push({ kind: 'single', key: message.id, item: message })
    }
  }
  flushRun()

  return groups
}

function isProcessingItem(message: ChatItem): message is ProcessingItem {
  return message.role !== 'user' && message.role !== 'run'
}

function isProcessingArtifact(message: ChatItem): boolean {
  return message.role === 'tool' || message.role === 'thinking'
}

function timestampMs(value?: string): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function itemStartedAtMs(item: ChatItem): number | null {
  if (isRunLifecycleItem(item)) return timestampMs(item.createdAt)

  const createdAt = timestampMs(item.createdAt)
  const completedAt = timestampMs(item.completedAt)
  const durationStart =
    completedAt !== null && typeof item.durationMs === 'number'
      ? Math.max(0, completedAt - item.durationMs)
      : null

  if (createdAt !== null && durationStart !== null) return Math.min(createdAt, durationStart)
  if (createdAt !== null) return createdAt
  return durationStart
}

function firstRunStartedAtMs(items: ChatItem[]): number | undefined {
  const timestamps = items
    .filter(
      (item): item is RunLifecycleItem => isRunLifecycleItem(item) && item.event === 'started'
    )
    .map((item) => timestampMs(item.createdAt))
    .filter((value): value is number => value !== null)
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined
}

function lastRunTerminalAtMs(items: ChatItem[]): number | undefined {
  const timestamps = items
    .filter(
      (item): item is RunLifecycleItem => isRunLifecycleItem(item) && item.event !== 'started'
    )
    .map((item) => timestampMs(item.createdAt))
    .filter((value): value is number => value !== null)
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined
}

function lastRunTerminalDurationMs(items: ChatItem[]): number | undefined {
  const durations = items
    .filter(
      (item): item is RunLifecycleItem => isRunLifecycleItem(item) && item.event !== 'started'
    )
    .map((item) => item.durationMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return durations.length > 0 ? durations[durations.length - 1] : undefined
}

function itemCompletedAtMs(item: ChatItem): number | null {
  if (isRunLifecycleItem(item)) return timestampMs(item.createdAt)

  return timestampMs(item.completedAt) ?? timestampMs(item.createdAt)
}

function minTimestamp(items: ChatItem[]): number | undefined {
  const timestamps = items
    .map(itemStartedAtMs)
    .filter((value): value is number => typeof value === 'number')
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined
}

function maxTimestamp(items: ChatItem[]): number | undefined {
  const timestamps = items
    .map(itemCompletedAtMs)
    .filter((value): value is number => typeof value === 'number')
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined
}

function groupMessages(messages: ChatItem[]): RenderGroup[] {
  const groups: RenderGroup[] = []
  let turnItems: ChatItem[] = []

  const flushTurn = (): void => {
    if (turnItems.length === 0) return

    const runStartedAtMs = firstRunStartedAtMs(turnItems)
    const runCompletedAtMs = lastRunTerminalAtMs(turnItems)
    const runDurationMs = lastRunTerminalDurationMs(turnItems)
    const lastProcessingIndex = turnItems.findLastIndex(isProcessingArtifact)
    if (lastProcessingIndex < 0) {
      if (runStartedAtMs !== undefined) {
        const visibleItems = turnItems.filter(isVisibleChatItem)
        groups.push({
          kind: 'processing-group',
          key: `processing-${turnItems[0].id}`,
          items: [],
          startedAtMs: runStartedAtMs,
          completedAtMs: runCompletedAtMs ?? maxTimestamp(visibleItems),
          durationMs: runDurationMs
        })
      }
      groups.push(
        ...turnItems
          .filter(isVisibleChatItem)
          .map((item) => ({ kind: 'single' as const, key: item.id, item }))
      )
      turnItems = []
      return
    }

    const processingItems = turnItems.slice(0, lastProcessingIndex + 1).filter(isProcessingItem)
    const trailingItems = turnItems.slice(lastProcessingIndex + 1).filter(isVisibleChatItem)
    if (processingItems.length > 0 || runStartedAtMs !== undefined) {
      groups.push({
        kind: 'processing-group',
        key: `processing-${processingItems[0]?.id ?? turnItems[0].id}`,
        items: processingItems,
        startedAtMs: runStartedAtMs ?? minTimestamp(processingItems),
        completedAtMs: runCompletedAtMs ?? maxTimestamp([...processingItems, ...trailingItems]),
        durationMs: runDurationMs
      })
    }

    groups.push(...trailingItems.map((item) => ({ kind: 'single' as const, key: item.id, item })))
    turnItems = []
  }

  for (const message of messages) {
    if (message.role === 'user') {
      flushTurn()
      groups.push({ kind: 'single', key: message.id, item: message })
      continue
    }

    turnItems.push(message)
  }

  flushTurn()
  return groups
}

const THINKING_LEVEL_ORDER: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max'
}

function ThinkingLevelControl({
  thinkingLevel,
  onSelectThinkingLevel,
  supportedLevels,
  disabled: disabledBySession = false
}: {
  thinkingLevel: ThinkingLevel
  onSelectThinkingLevel: (level: ThinkingLevel) => void
  supportedLevels: ThinkingLevel[] | null
  disabled?: boolean
}): ReactNode {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const popoverId = useId()

  // supportedLevels is null when no model is explicitly selected (unknown until
  // the SDK resolves a default) — in that case don't constrain the slider.
  const modelDisabled = supportedLevels !== null && supportedLevels.length === 0
  const minIndex = supportedLevels?.length ? THINKING_LEVEL_ORDER.indexOf(supportedLevels[0]) : 0
  const maxIndex = supportedLevels?.length
    ? THINKING_LEVEL_ORDER.indexOf(supportedLevels[supportedLevels.length - 1])
    : THINKING_LEVEL_ORDER.length - 1
  const currentIndex = Math.min(
    Math.max(THINKING_LEVEL_ORDER.indexOf(thinkingLevel), minIndex),
    maxIndex
  )
  const disabled = disabledBySession || modelDisabled

  return (
    <>
      <Button
        size="small"
        onClick={(event) => setAnchorEl(event.currentTarget)}
        disabled={disabled}
        aria-describedby={popoverId}
        startIcon={<BoltIcon sx={{ fontSize: 16 }} />}
        sx={{
          textTransform: 'none',
          color: 'text.secondary',
          fontSize: '0.85rem',
          minHeight: 32,
          // Fixed width so the button (and therefore the popover's anchor point)
          // never shifts as the label text changes length between levels.
          width: 104,
          justifyContent: 'flex-start',
          px: 1
        }}
      >
        {modelDisabled ? 'Off' : THINKING_LEVEL_LABELS[THINKING_LEVEL_ORDER[currentIndex]]}
      </Button>
      <Popover
        id={popoverId}
        open={!disabled && Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { py: 3, px: 3.5, width: 320 } } }}
      >
        <Slider
          value={currentIndex}
          min={minIndex}
          max={maxIndex}
          step={1}
          sx={{ mx: 1, width: 'calc(100% - 16px)' }}
          marks={THINKING_LEVEL_ORDER.map((level, index) => ({
            value: index,
            label: (
              <Typography variant="caption" sx={{ fontSize: '0.7rem' }}>
                {THINKING_LEVEL_LABELS[level]}
              </Typography>
            )
          }))}
          onChange={(_, value) => {
            const index = Array.isArray(value) ? value[0] : value
            onSelectThinkingLevel(THINKING_LEVEL_ORDER[index])
          }}
          disabled={disabled}
          aria-label="Thinking level"
        />
      </Popover>
    </>
  )
}

function ModelSelectorControl({
  models,
  selectedModel,
  onSelectModel,
  disabled = false
}: {
  models: ModelOption[]
  selectedModel: ModelOption | null
  onSelectModel: (model: ModelOption | null) => void
  disabled?: boolean
}): ReactNode {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const popoverId = useId()

  const grouped = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const filtered = normalizedQuery
      ? models.filter((option) =>
          `${option.name} ${option.providerId} ${option.modelId}`
            .toLowerCase()
            .includes(normalizedQuery)
        )
      : models

    const byProvider = new Map<string, ModelOption[]>()
    for (const option of filtered) {
      const group = byProvider.get(option.providerId) ?? []
      group.push(option)
      byProvider.set(option.providerId, group)
    }
    return [...byProvider.entries()]
  }, [models, query])

  const handleClose = (): void => {
    setAnchorEl(null)
    setQuery('')
  }

  return (
    <>
      <Button
        size="small"
        onClick={(event) => setAnchorEl(event.currentTarget)}
        disabled={disabled}
        aria-describedby={popoverId}
        aria-label="选择模型"
        sx={{
          textTransform: 'none',
          color: 'text.secondary',
          fontSize: '0.85rem',
          minHeight: 32,
          maxWidth: 160,
          justifyContent: 'flex-start',
          px: 1
        }}
      >
        <Box
          component="span"
          sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {selectedModel ? selectedModel.name : '自动选择'}
        </Box>
      </Button>
      {/* A plain search field + list rendered directly in the Popover's own Paper —
          not a nested Autocomplete, whose own floating listbox would position itself
          independently of this Popover and could visually overlap it near screen edges. */}
      <Popover
        id={popoverId}
        open={!disabled && Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        slotProps={{
          paper: { sx: { width: 280, maxHeight: 360, display: 'flex', flexDirection: 'column' } }
        }}
      >
        <Box sx={{ p: 1, flexShrink: 0 }}>
          <TextField
            autoFocus
            fullWidth
            size="small"
            placeholder="搜索模型"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Box>
        <List dense sx={{ overflowY: 'auto', flex: 1, minHeight: 0, pt: 0 }}>
          {models.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1 }}>
              无可用模型 — 请先在设置中配置 Provider
            </Typography>
          ) : (
            grouped.map(([providerId, options]) => (
              <Box key={providerId}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ px: 2, pt: 1, display: 'block' }}
                >
                  {providerId}
                </Typography>
                {options.map((option) => (
                  <ListItemButton
                    key={`${option.providerId}/${option.modelId}`}
                    selected={
                      selectedModel?.providerId === option.providerId &&
                      selectedModel?.modelId === option.modelId
                    }
                    onClick={() => {
                      onSelectModel(option)
                      handleClose()
                    }}
                  >
                    <ListItemText primary={option.name} />
                  </ListItemButton>
                ))}
              </Box>
            ))
          )}
        </List>
      </Popover>
    </>
  )
}

function formatThinkingDuration(durationMs?: number): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return '思考'
  if (durationMs < 1000) return '思考了 1 s'

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  if (totalSeconds < 60) return `思考了 ${totalSeconds} s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `思考了 ${minutes} m ${seconds} s` : `思考了 ${minutes} m`
}

export function ThinkingBlock({
  content,
  durationMs
}: {
  content: string
  durationMs?: number
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const toggle = (): void => setExpanded((value) => !value)
  const label = formatThinkingDuration(durationMs)

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
        <ThinkingIcon />
        <Typography component="span" variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {label}
        </Typography>
      </Box>
      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ ml: 2.5, pl: 1.5, py: 1, minWidth: 0, borderLeft: 2, borderColor: 'grey.800' }}>
          <Typography
            variant="body2"
            sx={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontStyle: 'italic',
              color: 'text.secondary'
            }}
          >
            {content}
          </Typography>
        </Box>
      </Collapse>
    </Box>
  )
}

function ThinkingIcon({ size = 16 }: { size?: number }): ReactNode {
  return (
    <Tooltip title="思考" enterDelay={500}>
      <Box
        component="span"
        role="img"
        aria-label="思考"
        sx={{
          width: size + 2,
          height: size + 2,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.secondary'
        }}
      >
        <PsychologyIcon sx={{ fontSize: size }} />
      </Box>
    </Tooltip>
  )
}

function groupProcessingItems(items: ProcessingItem[]): RenderGroup[] {
  return groupConsecutiveTools(items)
}

function processingGroupStatus(
  items: ProcessingItem[],
  isActive: boolean
): ToolCallItem['status'] | null {
  const tools = items.filter((item): item is ToolCallItem => item.role === 'tool')
  if (isActive || tools.some((item) => item.status === 'running')) return 'running'
  return null
}

function formatProcessingDuration(durationMs: number): string {
  const totalSeconds =
    durationMs > 0 && durationMs < 1000 ? 1 : Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours} 小时 ${minutes} 分钟 ${seconds} 秒`
  if (minutes > 0) return `${minutes} 分钟 ${seconds} 秒`
  return `${seconds} 秒`
}

function fallbackDurationMs(items: ProcessingItem[]): number | null {
  const durations = items
    .map((item) => item.durationMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) : null
}

function processingElapsedMs({
  items,
  isActive,
  nowMs,
  fallbackStartedAtMs,
  startedAtMs,
  completedAtMs,
  durationMs
}: {
  items: ProcessingItem[]
  isActive: boolean
  nowMs: number
  fallbackStartedAtMs: number
  startedAtMs?: number
  completedAtMs?: number
  durationMs?: number
}): number {
  if (!isActive && typeof durationMs === 'number' && Number.isFinite(durationMs)) {
    return Math.max(0, durationMs)
  }

  const start = startedAtMs ?? minTimestamp(items) ?? (isActive ? fallbackStartedAtMs : undefined)
  const end = isActive ? nowMs : (completedAtMs ?? maxTimestamp(items))

  if (start !== undefined && end !== undefined) {
    return Math.max(0, end - start)
  }

  return fallbackDurationMs(items) ?? 0
}

function processingStatusText({
  items,
  isActive,
  nowMs,
  fallbackStartedAtMs,
  startedAtMs,
  completedAtMs,
  durationMs
}: {
  items: ProcessingItem[]
  isActive: boolean
  nowMs: number
  fallbackStartedAtMs: number
  startedAtMs?: number
  completedAtMs?: number
  durationMs?: number
}): string {
  const elapsed = formatProcessingDuration(
    processingElapsedMs({
      items,
      isActive,
      nowMs,
      fallbackStartedAtMs,
      startedAtMs,
      completedAtMs,
      durationMs
    })
  )

  return isActive ? `正在处理，已花费 ${elapsed}` : `已完成，总共用时 ${elapsed}`
}

function ProcessingGroup({
  items,
  onGoSettings,
  cwd = '',
  isActive = false,
  startedAtMs,
  completedAtMs,
  durationMs
}: {
  items: ProcessingItem[]
  onGoSettings: () => void
  cwd?: string
  isActive?: boolean
  startedAtMs?: number
  completedAtMs?: number
  durationMs?: number
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [fallbackStartedAtMs] = useState(() => Date.now())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const toggle = (): void => setExpanded((value) => !value)
  const groupedItems = groupProcessingItems(items)
  const status = processingGroupStatus(items, isActive)
  const isProcessingActive = status === 'running'
  const summary = processingStatusText({
    items,
    isActive: isProcessingActive,
    nowMs,
    fallbackStartedAtMs,
    startedAtMs,
    completedAtMs,
    durationMs
  })

  useEffect(() => {
    if (!isProcessingActive) return undefined
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isProcessingActive])

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
        aria-label={expanded ? '折叠处理过程' : '展开处理过程'}
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
          {summary}
        </Typography>
        {status ? (
          <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <StatusIndicator status={status} />
          </Box>
        ) : null}
      </Box>
      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ ml: 2.5, pl: 1.5, minWidth: 0, borderLeft: 2, borderColor: 'grey.800' }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, py: 0.5 }}>
            {groupedItems.map((group) => {
              if (group.kind === 'tool-group') {
                return <ToolGroupCard key={group.key} items={group.items} cwd={cwd} />
              }
              if (group.kind === 'processing-group') {
                return (
                  <ProcessingGroup
                    key={group.key}
                    items={group.items}
                    onGoSettings={onGoSettings}
                    cwd={cwd}
                    isActive={false}
                    startedAtMs={group.startedAtMs}
                    completedAtMs={group.completedAtMs}
                    durationMs={group.durationMs}
                  />
                )
              }
              return group.item.role === 'tool' ? (
                <ToolCallCard key={group.key} item={group.item} cwd={cwd} />
              ) : (
                <ChatBubble
                  key={group.key}
                  message={group.item}
                  onGoSettings={onGoSettings}
                  cwd={cwd}
                />
              )
            })}
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'flex-start', pb: 0.5 }}>
            <IconButton
              size="small"
              aria-label="折叠处理过程"
              title="折叠处理过程"
              onClick={toggle}
              sx={{
                width: 28,
                height: 28,
                color: 'text.secondary'
              }}
            >
              <ExpandLessIcon fontSize="small" />
            </IconButton>
          </Box>
        </Box>
      </Collapse>
    </Box>
  )
}

function PermissionModeControl({
  permissionMode,
  disabled,
  onSelectPermissionMode
}: {
  permissionMode: PermissionMode
  disabled: boolean
  onSelectPermissionMode: (mode: PermissionMode) => void
}): ReactNode {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const popoverId = useId()
  const modes: Array<{
    mode: PermissionMode
    label: string
    compactLabel: string
    description: string
    danger?: boolean
  }> = [
    {
      mode: 'ask',
      label: '请求批准',
      compactLabel: 'Ask',
      description: '执行命令、写入或修改文件前先询问'
    },
    {
      mode: 'auto',
      label: '帮我批准',
      compactLabel: 'Auto',
      description: '自动执行允许的工具'
    },
    {
      mode: 'full',
      label: '完全访问权限',
      compactLabel: 'Full',
      description: '可不受限制地访问互联网和你电脑上的任何文件',
      danger: true
    }
  ]
  const selectedMode = modes.find((item) => item.mode === permissionMode) ?? modes[1]
  const selectedIcon = PERMISSION_MODE_ICON_META[selectedMode.mode]
  const SelectedPermissionIcon = selectedIcon.Icon

  const close = (): void => setAnchorEl(null)

  return (
    <>
      <Button
        size="small"
        aria-label="选择权限模式"
        aria-describedby={popoverId}
        disabled={disabled}
        onClick={(event) => setAnchorEl(event.currentTarget)}
        startIcon={<SelectedPermissionIcon sx={{ fontSize: 18 }} />}
        sx={{
          textTransform: 'none',
          color: selectedIcon.color ?? 'text.secondary',
          fontSize: '0.85rem',
          minHeight: 32,
          width: 116,
          justifyContent: 'flex-start',
          px: 1
        }}
      >
        权限 {selectedMode.compactLabel}
      </Button>
      <Popover
        id={popoverId}
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={close}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              width: { xs: 'calc(100vw - 32px)', sm: 390 },
              maxWidth: 'calc(100vw - 32px)'
            }
          }
        }}
      >
        <List dense disablePadding>
          {modes.map((item) => {
            const modeIcon = PERMISSION_MODE_ICON_META[item.mode]
            const ModeIcon = modeIcon.Icon

            return (
              <ListItemButton
                key={item.mode}
                selected={permissionMode === item.mode}
                onClick={() => {
                  onSelectPermissionMode(item.mode)
                  close()
                }}
                sx={{ height: 64, alignItems: 'center', px: 2 }}
              >
                <ListItemIcon sx={{ minWidth: 34, color: modeIcon.color }}>
                  <ModeIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText
                  primary={item.label}
                  secondary={item.description}
                  slotProps={{
                    primary: {
                      noWrap: true,
                      sx: {
                        color: item.danger ? 'error.main' : 'text.primary',
                        fontSize: '0.95rem',
                        fontWeight: item.danger ? 700 : 600,
                        lineHeight: 1.35
                      }
                    },
                    secondary: {
                      noWrap: true,
                      sx: {
                        color: item.danger ? 'error.main' : 'text.secondary',
                        fontSize: '0.84rem',
                        lineHeight: 1.4
                      }
                    }
                  }}
                  sx={{ minWidth: 0, my: 0 }}
                />
                {permissionMode === item.mode && (
                  <ListItemIcon
                    sx={{ minWidth: 28, color: item.danger ? 'error.main' : 'inherit' }}
                  >
                    <CheckIcon fontSize="small" />
                  </ListItemIcon>
                )}
              </ListItemButton>
            )
          })}
        </List>
      </Popover>
    </>
  )
}

type ViewProps = {
  messages: ChatItem[]
  input: string
  messagesContainerRef: (node: HTMLDivElement | null) => void
  canSend: boolean
  isGenerating: boolean
  currentRunStartedAt?: string
  models: ModelOption[]
  selectedModel: ModelOption | null
  onSelectModel: (model: ModelOption | null) => void
  thinkingLevel: ThinkingLevel
  onSelectThinkingLevel: (level: ThinkingLevel) => void
  onInputChange: (value: string) => void
  onChatSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onStopGeneration: () => Promise<void>
  onGoSettings: () => void
  permissionMode: PermissionMode
  onSelectPermissionMode: (mode: PermissionMode) => void
  disablePermissionModeSelect?: boolean
  disableModelControls?: boolean
  pendingApproval: ToolApprovalRequest | null
  onRespondApproval: (requestId: string, approved: boolean) => void
  onOpenApprovalSession: (path: string) => void
  cwd?: string
}

function ChatBubble({
  message,
  onGoSettings,
  cwd = ''
}: {
  message: ChatMessage
  onGoSettings: () => void
  cwd?: string
}): ReactNode {
  if (message.role === 'error') {
    const display = getProviderErrorDisplay(message.content)
    return (
      <Alert
        severity="error"
        variant="outlined"
        action={
          display.action === 'providerSettings' ? (
            <Button size="small" color="inherit" onClick={onGoSettings} sx={{ minHeight: 44 }}>
              {display.actionLabel}
            </Button>
          ) : undefined
        }
      >
        <AlertTitle>{display.title}</AlertTitle>
        <Typography variant="body2" sx={{ color: 'inherit', mb: 0.75 }}>
          {display.description}
        </Typography>
        {display.showRawMessage ? (
          <Typography variant="body2" sx={{ color: 'inherit', whiteSpace: 'pre-wrap' }}>
            原始错误：{display.rawMessage}
          </Typography>
        ) : null}
      </Alert>
    )
  }

  if (message.role === 'warning') {
    return (
      <Alert severity="info" variant="outlined">
        <Typography variant="body2" sx={{ color: 'inherit', whiteSpace: 'pre-wrap' }}>
          {message.content}
        </Typography>
      </Alert>
    )
  }

  if (message.role === 'thinking') {
    return <ThinkingBlock content={message.content} durationMs={message.durationMs} />
  }

  if (message.role === 'user') {
    return (
      <Box
        sx={{
          alignSelf: 'flex-end',
          maxWidth: '75%',
          minWidth: 0,
          px: 2,
          py: 1.25,
          bgcolor: 'primary.main',
          color: 'background.default',
          borderRadius: '18px 18px 4px 18px'
        }}
      >
        <Typography
          variant="body1"
          sx={{
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            lineHeight: 1.6,
            fontSize: '0.95rem'
          }}
        >
          {message.content}
        </Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ alignSelf: 'stretch', minWidth: 0, px: 0.5 }}>
      <MarkdownContent text={message.content} cwd={cwd} />
    </Box>
  )
}

function ChatView({
  messages,
  input,
  messagesContainerRef,
  canSend,
  isGenerating,
  currentRunStartedAt,
  models,
  selectedModel,
  onSelectModel,
  thinkingLevel,
  onSelectThinkingLevel,
  onInputChange,
  onChatSubmit,
  onStopGeneration,
  onGoSettings,
  permissionMode,
  onSelectPermissionMode,
  disablePermissionModeSelect = false,
  disableModelControls = false,
  pendingApproval,
  onRespondApproval,
  onOpenApprovalSession,
  cwd = ''
}: ViewProps): React.JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  const renderGroups = useMemo(() => groupMessages(messages), [messages])

  const focusInputFromComposerSurface = (event: MouseEvent<HTMLElement>): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) {
      inputRef.current?.focus({ preventScroll: true })
      return
    }

    if (
      target.closest(
        'button, a, input, textarea, select, [role="button"], [role="menuitem"], [aria-haspopup="true"]'
      )
    ) {
      return
    }

    event.preventDefault()
    inputRef.current?.focus({ preventScroll: true })
  }

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box
        ref={messagesContainerRef}
        sx={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', overflowX: 'hidden' }}
      >
        <Box
          sx={{
            maxWidth: 860,
            mx: 'auto',
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            p: 3
          }}
        >
          {renderGroups.map((group, index) => {
            if (group.kind === 'tool-group') {
              return <ToolGroupCard key={group.key} items={group.items} cwd={cwd} />
            }
            if (group.kind === 'processing-group') {
              const isActiveProcessingGroup = isGenerating && index === renderGroups.length - 1
              return (
                <ProcessingGroup
                  key={group.key}
                  items={group.items}
                  onGoSettings={onGoSettings}
                  cwd={cwd}
                  isActive={isActiveProcessingGroup}
                  startedAtMs={
                    isActiveProcessingGroup
                      ? (timestampMs(currentRunStartedAt) ?? group.startedAtMs)
                      : group.startedAtMs
                  }
                  completedAtMs={group.completedAtMs}
                  durationMs={group.durationMs}
                />
              )
            }
            return group.item.role === 'tool' ? (
              <ToolCallCard key={group.key} item={group.item} cwd={cwd} />
            ) : (
              <ChatBubble
                key={group.key}
                message={group.item}
                onGoSettings={onGoSettings}
                cwd={cwd}
              />
            )
          })}
        </Box>
      </Box>
      <Box
        sx={{
          px: 2,
          pt: 1.5,
          pb: 2,
          flexShrink: 0
        }}
      >
        <Box component="form" onSubmit={onChatSubmit} sx={{ maxWidth: 892, mx: 'auto' }}>
          <ToolApprovalDialog
            request={pendingApproval}
            onRespond={onRespondApproval}
            onOpenSession={onOpenApprovalSession}
          />
          <Paper
            variant="outlined"
            onMouseDownCapture={focusInputFromComposerSurface}
            sx={{
              borderRadius: 2,
              px: 2,
              pt: 1.5,
              pb: 1,
              cursor: 'text',
              borderColor: (theme) =>
                theme.palette.mode === 'dark'
                  ? 'rgba(241, 246, 246, 0.18)'
                  : 'rgba(15, 42, 48, 0.14)',
              transition: 'border-color 200ms',
              '&:focus-within': { borderColor: 'primary.main' }
            }}
          >
            <TextField
              fullWidth
              multiline
              variant="standard"
              minRows={1}
              maxRows={8}
              inputRef={inputRef}
              value={input}
              onChange={(event) => {
                onInputChange(event.target.value)
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  canSend &&
                  input.trim()
                ) {
                  event.preventDefault()
                  event.currentTarget.closest('form')?.requestSubmit()
                }
              }}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              slotProps={{
                htmlInput: {
                  'data-phi-focus': 'chat-input'
                },
                input: {
                  disableUnderline: true,
                  sx: { fontSize: '0.95rem', lineHeight: 1.6 }
                }
              }}
            />
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1,
                mt: 1
              }}
            >
              <PermissionModeControl
                permissionMode={permissionMode}
                disabled={disablePermissionModeSelect}
                onSelectPermissionMode={onSelectPermissionMode}
              />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                <ThinkingLevelControl
                  thinkingLevel={thinkingLevel}
                  onSelectThinkingLevel={onSelectThinkingLevel}
                  supportedLevels={selectedModel?.thinkingLevels ?? null}
                  disabled={disableModelControls}
                />
                <ModelSelectorControl
                  models={models}
                  selectedModel={selectedModel}
                  onSelectModel={onSelectModel}
                  disabled={disableModelControls}
                />
                {!isGenerating ? (
                  <IconButton
                    type="submit"
                    disabled={!canSend || !input.trim()}
                    aria-label="发送消息"
                    sx={{
                      width: 40,
                      height: 40,
                      bgcolor: 'primary.main',
                      color: 'background.default',
                      transition: 'background-color 200ms',
                      '&:hover': { bgcolor: 'primary.dark' },
                      '&.Mui-disabled': {
                        bgcolor: 'action.disabledBackground',
                        color: 'action.disabled'
                      }
                    }}
                  >
                    <SendIcon fontSize="small" />
                  </IconButton>
                ) : (
                  <IconButton
                    type="button"
                    onClick={() => {
                      void onStopGeneration()
                    }}
                    aria-label="停止生成"
                    sx={{
                      width: 40,
                      height: 40,
                      bgcolor: 'error.main',
                      color: 'error.contrastText',
                      transition: 'background-color 200ms',
                      '&:hover': { bgcolor: 'error.dark' }
                    }}
                  >
                    <StopIcon fontSize="small" />
                  </IconButton>
                )}
              </Box>
            </Box>
          </Paper>
        </Box>
      </Box>
    </Box>
  )
}

export default ChatView
