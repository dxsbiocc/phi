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
  memo,
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  type Ref
} from 'react'
import type { IconType } from 'react-icons'
import {
  SiAnthropic,
  SiClaude,
  SiDeepseek,
  SiGithubcopilot,
  SiGoogle,
  SiGooglegemini,
  SiMetaai,
  SiMistralai,
  SiMoonshotai,
  SiOllama,
  SiOpenrouter,
  SiPerplexity,
  SiQwen,
  SiX
} from 'react-icons/si'
import { TbBrandOpenai } from 'react-icons/tb'
import MarkdownContent, { type LocalPathKind } from './MarkdownContent'
import ToolCallCard, { StatusIndicator } from './ToolCallCard'
import ToolGroupCard from './ToolGroupCard'
import ToolApprovalDialog from './ToolApprovalDialog'
import { PERMISSION_MODE_ICON_META, PhiIcons } from '../icons'
import {
  nextPromptHistoryCursor,
  promptHistoryFromMessages,
  type PromptHistoryDirection
} from '../lib/promptHistory'
import {
  appendInputReference,
  formatInputFileReferences,
  formatPromptAgentReference,
  formatPluginPromptReference,
  formatSkillPromptReference
} from '../lib/inputReferences'
import { getProviderErrorDisplay } from '../lib/providerErrors'
import type {
  ChatItem,
  ChatMessage,
  ModelOption,
  PermissionMode,
  PluginCatalogItem,
  PromptAgentSummary,
  RunLifecycleItem,
  SkillSummary,
  ThinkingLevel,
  ToolApprovalRequest,
  ToolCallItem
} from '../types'

const AddIcon = PhiIcons.action.add
const BoltIcon = PhiIcons.action.quick
const CheckIcon = PhiIcons.state.check
const ChevronRightIcon = PhiIcons.action.back
const ExpandLessIcon = PhiIcons.action.collapse
const InputAgentIcon = PhiIcons.entity.agent
const InputFileIcon = PhiIcons.tool.read
const InputPluginIcon = PhiIcons.entity.plugin
const InputSkillIcon = PhiIcons.entity.skill
const PsychologyIcon = PhiIcons.state.thinking
const SendIcon = PhiIcons.action.send
const StopIcon = PhiIcons.action.stop
const COMPACT_COMPOSER_CONTROL_SIZE = 32
const REGULAR_COMPOSER_ACTION_SIZE = 40
const compactComposerIconButtonSx = {
  width: COMPACT_COMPOSER_CONTROL_SIZE,
  height: COMPACT_COMPOSER_CONTROL_SIZE,
  minWidth: COMPACT_COMPOSER_CONTROL_SIZE,
  minHeight: COMPACT_COMPOSER_CONTROL_SIZE,
  flexShrink: 0
} as const

type ProviderIconMeta = {
  key: string
  label: string
  color: string
  Icon?: IconType
}

const PROVIDER_ICON_RULES: Array<ProviderIconMeta & { matches: string[] }> = [
  {
    key: 'openai',
    label: 'OpenAI',
    color: '#10A37F',
    Icon: TbBrandOpenai,
    matches: ['openai', 'codex', 'chatgpt']
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    color: '#4D6BFE',
    Icon: SiDeepseek,
    matches: ['deepseek']
  },
  {
    key: 'moonshot',
    label: 'Moonshot',
    color: '#6D5DF6',
    Icon: SiMoonshotai,
    matches: ['moonshot', 'kimi']
  },
  {
    key: 'anthropic',
    label: 'Anthropic',
    color: '#D97757',
    Icon: SiAnthropic,
    matches: ['anthropic']
  },
  {
    key: 'claude',
    label: 'Claude',
    color: '#D97757',
    Icon: SiClaude,
    matches: ['claude']
  },
  {
    key: 'gemini',
    label: 'Gemini',
    color: '#4285F4',
    Icon: SiGooglegemini,
    matches: ['gemini']
  },
  {
    key: 'google',
    label: 'Google',
    color: '#4285F4',
    Icon: SiGoogle,
    matches: ['google']
  },
  {
    key: 'qwen',
    label: 'Qwen',
    color: '#615CED',
    Icon: SiQwen,
    matches: ['qwen', 'dashscope', 'alibaba']
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    color: '#6C5CE7',
    Icon: SiOpenrouter,
    matches: ['openrouter']
  },
  {
    key: 'ollama',
    label: 'Ollama',
    color: '#111827',
    Icon: SiOllama,
    matches: ['ollama']
  },
  {
    key: 'mistral',
    label: 'Mistral',
    color: '#FA520F',
    Icon: SiMistralai,
    matches: ['mistral']
  },
  {
    key: 'meta',
    label: 'Meta',
    color: '#0668E1',
    Icon: SiMetaai,
    matches: ['meta', 'llama']
  },
  {
    key: 'perplexity',
    label: 'Perplexity',
    color: '#1FB8CD',
    Icon: SiPerplexity,
    matches: ['perplexity']
  },
  {
    key: 'xai',
    label: 'xAI',
    color: '#111827',
    Icon: SiX,
    matches: ['xai', 'grok']
  },
  {
    key: 'copilot',
    label: 'GitHub Copilot',
    color: '#6E5494',
    Icon: SiGithubcopilot,
    matches: ['copilot', 'github']
  }
]

function providerIconMeta(providerId?: string): ProviderIconMeta {
  const normalizedProviderId = providerId?.toLowerCase() ?? ''
  const matched = PROVIDER_ICON_RULES.find((rule) =>
    rule.matches.some((match) => normalizedProviderId.includes(match))
  )
  if (matched) {
    return {
      key: matched.key,
      label: matched.label,
      color: matched.color,
      Icon: matched.Icon
    }
  }
  return {
    key: 'generic',
    label: 'Model Provider',
    color: 'text.secondary'
  }
}

function textInputFromEventTarget(
  target: EventTarget | null
): HTMLInputElement | HTMLTextAreaElement | null {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return target
  }
  return null
}

function isTextInputAtHistoryBoundary(
  inputElement: HTMLInputElement | HTMLTextAreaElement,
  direction: PromptHistoryDirection
): boolean {
  const { selectionStart, selectionEnd, value } = inputElement
  if (selectionStart === null || selectionEnd === null) return true
  if (selectionStart !== selectionEnd) return false
  if (value.length === 0) return true

  if (direction === 'previous') {
    return value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) === -1
  }
  return value.indexOf('\n', selectionEnd) === -1
}

function ProviderModelIcon({
  providerId,
  disabled = false
}: {
  providerId?: string
  disabled?: boolean
}): React.JSX.Element {
  const meta = providerIconMeta(providerId)
  const color = disabled ? 'action.disabled' : meta.color

  if (meta.Icon) {
    const BrandIcon = meta.Icon
    return (
      <Box
        component="span"
        data-phi-provider-icon={meta.key}
        aria-label={meta.label}
        title={meta.label}
        sx={{
          alignItems: 'center',
          color,
          display: 'inline-flex',
          flexShrink: 0,
          fontSize: '1.2rem',
          height: '1em',
          justifyContent: 'center',
          lineHeight: 0,
          width: '1em'
        }}
      >
        <BrandIcon color="currentColor" focusable="false" size="1em" />
      </Box>
    )
  }

  return (
    <PsychologyIcon
      data-phi-provider-icon={meta.key}
      aria-label={meta.label}
      htmlColor={undefined}
      size="1.2rem"
      sx={{ color }}
    />
  )
}

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
        if (visibleItems.length > 0 || groups.length > 0) {
          groups.push({
            kind: 'processing-group',
            key: `processing-${turnItems[0].id}`,
            items: [],
            startedAtMs: runStartedAtMs,
            completedAtMs: runCompletedAtMs ?? maxTimestamp(visibleItems),
            durationMs: runDurationMs
          })
        }
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

function InputAddGroup({
  title,
  children
}: {
  title: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <Box
      sx={{
        '& + &': { mt: 1.25 }
      }}
    >
      <Typography
        variant="body2"
        sx={{
          color: 'text.secondary',
          display: 'block',
          fontSize: '0.95rem',
          fontWeight: 800,
          letterSpacing: 0,
          lineHeight: 1.35,
          px: 1.75,
          pt: 1,
          pb: 0.5
        }}
      >
        {title}
      </Typography>
      <Box sx={{ px: 0.75, pb: 0.75 }}>{children}</Box>
    </Box>
  )
}

function InputAddEmptyState({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Typography
      variant="body2"
      color="text.secondary"
      sx={{
        px: 1,
        py: 0.75
      }}
    >
      {children}
    </Typography>
  )
}

function InputAddMenuRow({
  icon,
  primary,
  disabled = false,
  selected = false,
  onClick
}: {
  icon: ReactNode
  primary: string
  disabled?: boolean
  selected?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <ListItemButton
      dense
      role="menuitem"
      disabled={disabled}
      selected={selected}
      onClick={onClick}
      sx={{
        borderRadius: 1.5,
        gap: 0.5,
        minHeight: 40,
        px: 1,
        py: 0.5,
        '&.Mui-selected': {
          bgcolor: 'action.hover',
          '&:hover': { bgcolor: 'action.selected' }
        }
      }}
    >
      <ListItemIcon sx={{ color: 'primary.main', minWidth: 32 }}>{icon}</ListItemIcon>
      <ListItemText
        primary={primary}
        slotProps={{
          primary: { noWrap: true, sx: { fontSize: '0.9rem', fontWeight: 700 } }
        }}
      />
    </ListItemButton>
  )
}

function InputAddPanel({
  panelId,
  panelRef,
  skills,
  promptAgents,
  plugins,
  onPickFiles,
  onInsertReference,
  onClose
}: {
  panelId: string
  panelRef: Ref<HTMLDivElement>
  skills: SkillSummary[]
  promptAgents: PromptAgentSummary[]
  plugins: PluginCatalogItem[]
  onPickFiles?: () => Promise<string[]>
  onInsertReference: (reference: string) => void
  onClose: () => void
}): ReactNode {
  const enabledSkills = useMemo(() => skills.filter((skill) => !skill.disabled), [skills])
  const installedPlugins = useMemo(() => plugins.filter((plugin) => plugin.installed), [plugins])
  const insertReference = useCallback(
    (reference: string): void => {
      onClose()
      onInsertReference(reference)
    },
    [onClose, onInsertReference]
  )
  const pickFiles = useCallback(async (): Promise<void> => {
    onClose()
    const paths = (await onPickFiles?.()) ?? []
    const reference = formatInputFileReferences(paths)
    if (reference) {
      onInsertReference(reference)
    }
  }, [onClose, onInsertReference, onPickFiles])

  return (
    <Paper
      ref={panelRef}
      id={panelId}
      variant="outlined"
      role="menu"
      aria-label="添加上下文"
      sx={{
        width: '100%',
        mb: 1,
        borderRadius: 2,
        bgcolor: 'background.paper',
        maxHeight: 'min(420px, calc(100vh - 220px))',
        overflowY: 'auto',
        p: 1
      }}
    >
      <InputAddGroup title="添加">
        <InputAddMenuRow
          icon={<InputFileIcon fontSize="small" />}
          primary="文件和文件夹"
          selected
          disabled={!onPickFiles}
          onClick={() => void pickFiles()}
        />
      </InputAddGroup>

      <InputAddGroup title="智能体">
        {promptAgents.length > 0 ? (
          promptAgents.map((agent) => (
            <InputAddMenuRow
              key={agent.id}
              icon={<InputAgentIcon fontSize="small" />}
              primary={agent.name}
              onClick={() => insertReference(formatPromptAgentReference(agent))}
            />
          ))
        ) : (
          <InputAddEmptyState>暂无可指定智能体</InputAddEmptyState>
        )}
      </InputAddGroup>

      <InputAddGroup title="Skill">
        {enabledSkills.length > 0 ? (
          enabledSkills.map((skill) => (
            <InputAddMenuRow
              key={skill.id}
              icon={<InputSkillIcon fontSize="small" />}
              primary={skill.name}
              onClick={() => insertReference(formatSkillPromptReference(skill))}
            />
          ))
        ) : (
          <InputAddEmptyState>暂无可引用 Skill</InputAddEmptyState>
        )}
      </InputAddGroup>

      <InputAddGroup title="插件">
        {installedPlugins.length > 0 ? (
          installedPlugins.map((plugin) => (
            <InputAddMenuRow
              key={plugin.id}
              icon={<InputPluginIcon fontSize="small" />}
              primary={plugin.name}
              onClick={() => insertReference(formatPluginPromptReference(plugin))}
            />
          ))
        ) : (
          <InputAddEmptyState>暂无已安装插件</InputAddEmptyState>
        )}
      </InputAddGroup>
    </Paper>
  )
}

function InputAddControl({
  open,
  controls,
  buttonRef,
  onToggle
}: {
  open: boolean
  controls: string
  buttonRef: Ref<HTMLButtonElement>
  onToggle: () => void
}): ReactNode {
  return (
    <Tooltip title="添加文件、智能体、Skill 或插件" enterDelay={400}>
      <IconButton
        ref={buttonRef}
        size="small"
        type="button"
        aria-label="添加文件、智能体、Skill 或插件"
        aria-controls={open ? controls : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={onToggle}
        sx={{
          ...compactComposerIconButtonSx,
          color: open ? 'primary.main' : 'text.secondary',
          bgcolor: open ? 'action.hover' : 'transparent',
          '&:hover': { bgcolor: 'action.hover' }
        }}
      >
        <AddIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  )
}

function ThinkingLevelControl({
  thinkingLevel,
  onSelectThinkingLevel,
  supportedLevels,
  disabled: disabledBySession = false,
  compact = false
}: {
  thinkingLevel: ThinkingLevel
  onSelectThinkingLevel: (level: ThinkingLevel) => void
  supportedLevels: ThinkingLevel[] | null
  disabled?: boolean
  compact?: boolean
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
  const label = modelDisabled ? 'Off' : THINKING_LEVEL_LABELS[THINKING_LEVEL_ORDER[currentIndex]]

  return (
    <>
      <Tooltip title={`思考：${label}`} enterDelay={400}>
        {compact ? (
          <IconButton
            size="small"
            onClick={(event) => setAnchorEl(event.currentTarget)}
            disabled={disabled}
            aria-label={`选择思考等级：${label}`}
            aria-describedby={popoverId}
            sx={{ ...compactComposerIconButtonSx, color: 'text.secondary' }}
          >
            <BoltIcon fontSize="small" />
          </IconButton>
        ) : (
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
            {label}
          </Button>
        )}
      </Tooltip>
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
  disabled = false,
  compact = false
}: {
  models: ModelOption[]
  selectedModel: ModelOption | null
  onSelectModel: (model: ModelOption | null) => void
  disabled?: boolean
  compact?: boolean
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
  const label = selectedModel ? selectedModel.name : '自动选择'

  return (
    <>
      <Tooltip title={`模型：${label}`} enterDelay={400}>
        {compact ? (
          <IconButton
            size="small"
            onClick={(event) => setAnchorEl(event.currentTarget)}
            disabled={disabled}
            aria-describedby={popoverId}
            aria-label={`选择模型：${label}`}
            sx={{ ...compactComposerIconButtonSx, color: 'text.secondary' }}
          >
            <ProviderModelIcon providerId={selectedModel?.providerId} disabled={disabled} />
          </IconButton>
        ) : (
          <Button
            size="small"
            onClick={(event) => setAnchorEl(event.currentTarget)}
            disabled={disabled}
            aria-describedby={popoverId}
            aria-label="选择模型"
            startIcon={
              <ProviderModelIcon providerId={selectedModel?.providerId} disabled={disabled} />
            }
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
              {label}
            </Box>
          </Button>
        )}
      </Tooltip>
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
                    <ListItemIcon sx={{ minWidth: 30 }}>
                      <ProviderModelIcon providerId={option.providerId} />
                    </ListItemIcon>
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
  onOpenLocalPath,
  cwd = '',
  isActive = false,
  startedAtMs,
  completedAtMs,
  durationMs
}: {
  items: ProcessingItem[]
  onGoSettings: () => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
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
                    onOpenLocalPath={onOpenLocalPath}
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
                  onOpenLocalPath={onOpenLocalPath}
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
  onSelectPermissionMode,
  compact = false
}: {
  permissionMode: PermissionMode
  disabled: boolean
  onSelectPermissionMode: (mode: PermissionMode) => void
  compact?: boolean
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
      <Tooltip title={`权限：${selectedMode.compactLabel}`} enterDelay={400}>
        {compact ? (
          <IconButton
            size="small"
            aria-label={`选择权限模式：权限 ${selectedMode.compactLabel}`}
            aria-describedby={popoverId}
            disabled={disabled}
            onClick={(event) => setAnchorEl(event.currentTarget)}
            sx={{
              ...compactComposerIconButtonSx,
              color: selectedIcon.color ?? 'text.secondary'
            }}
          >
            <SelectedPermissionIcon fontSize="small" />
          </IconButton>
        ) : (
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
        )}
      </Tooltip>
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
  skills?: SkillSummary[]
  promptAgents?: PromptAgentSummary[]
  plugins?: PluginCatalogItem[]
  onSelectModel: (model: ModelOption | null) => void
  thinkingLevel: ThinkingLevel
  onSelectThinkingLevel: (level: ThinkingLevel) => void
  onInputChange: (value: string) => void
  onOpenInputAddMenu?: () => void
  onPickInputFiles?: () => Promise<string[]>
  onChatSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onStopGeneration: () => Promise<void>
  onGoSettings: () => void
  permissionMode: PermissionMode
  onSelectPermissionMode: (mode: PermissionMode) => void
  disablePermissionModeSelect?: boolean
  disableModelControls?: boolean
  compactComposerControls?: boolean
  pendingApproval: ToolApprovalRequest | null
  onRespondApproval: (requestId: string, approved: boolean) => void
  onOpenApprovalSession: (path: string) => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  cwd?: string
}

function ChatBubble({
  message,
  onGoSettings,
  onOpenLocalPath,
  cwd = ''
}: {
  message: ChatMessage
  onGoSettings: () => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
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
      <MarkdownContent text={message.content} cwd={cwd} onOpenLocalPath={onOpenLocalPath} />
    </Box>
  )
}

type ChatMessageListProps = {
  messages: ChatItem[]
  messagesContainerRef: (node: HTMLDivElement | null) => void
  isGenerating: boolean
  currentRunStartedAt?: string
  onGoSettings: () => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  cwd?: string
}

const ChatMessageList = memo(function ChatMessageList({
  messages,
  messagesContainerRef,
  isGenerating,
  currentRunStartedAt,
  onGoSettings,
  onOpenLocalPath,
  cwd = ''
}: ChatMessageListProps): React.JSX.Element {
  const renderGroups = useMemo(() => groupMessages(messages), [messages])

  return (
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
                onOpenLocalPath={onOpenLocalPath}
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
              onOpenLocalPath={onOpenLocalPath}
              cwd={cwd}
            />
          )
        })}
      </Box>
    </Box>
  )
})

function ChatView({
  messages,
  input,
  messagesContainerRef,
  canSend,
  isGenerating,
  currentRunStartedAt,
  models,
  selectedModel,
  skills = [],
  promptAgents = [],
  plugins = [],
  onSelectModel,
  thinkingLevel,
  onSelectThinkingLevel,
  onInputChange,
  onOpenInputAddMenu,
  onPickInputFiles,
  onChatSubmit,
  onStopGeneration,
  onGoSettings,
  permissionMode,
  onSelectPermissionMode,
  disablePermissionModeSelect = false,
  disableModelControls = false,
  compactComposerControls = false,
  pendingApproval,
  onRespondApproval,
  onOpenApprovalSession,
  onOpenLocalPath,
  cwd = ''
}: ViewProps): React.JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  const promptHistory = useMemo(() => promptHistoryFromMessages(messages), [messages])
  const promptHistoryKey = useMemo(() => promptHistory.join('\u0000'), [promptHistory])
  const promptHistoryCursorRef = useRef<number | null>(null)
  const promptHistoryDraftRef = useRef('')
  const promptHistoryKeyRef = useRef(promptHistoryKey)
  const inputAddPanelId = useId()
  const [inputAddMenuOpen, setInputAddMenuOpen] = useState(false)
  const inputAddPanelRef = useRef<HTMLDivElement | null>(null)
  const inputAddButtonRef = useRef<HTMLButtonElement | null>(null)
  const actionControlSize = compactComposerControls
    ? COMPACT_COMPOSER_CONTROL_SIZE
    : REGULAR_COMPOSER_ACTION_SIZE

  const resetPromptHistoryNavigation = useCallback((): void => {
    promptHistoryKeyRef.current = promptHistoryKey
    promptHistoryCursorRef.current = null
    promptHistoryDraftRef.current = ''
  }, [promptHistoryKey])

  const syncPromptHistoryKey = useCallback((): void => {
    if (promptHistoryKeyRef.current !== promptHistoryKey) {
      resetPromptHistoryNavigation()
    }
  }, [promptHistoryKey, resetPromptHistoryNavigation])

  const focusInputFromComposerSurface = useCallback((event: MouseEvent<HTMLElement>): void => {
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
  }, [])

  const navigatePromptHistory = useCallback(
    (direction: PromptHistoryDirection): boolean => {
      syncPromptHistoryKey()
      if (promptHistory.length === 0) return false
      const currentCursor = promptHistoryCursorRef.current
      if (direction === 'next' && currentCursor === null) return false

      const nextCursor = nextPromptHistoryCursor(promptHistory.length, currentCursor, direction)
      if (currentCursor === null) {
        promptHistoryDraftRef.current = input
      }

      promptHistoryCursorRef.current = nextCursor
      const nextValue =
        nextCursor === null ? promptHistoryDraftRef.current : promptHistory[nextCursor]
      onInputChange(nextValue)

      window.requestAnimationFrame(() => {
        const inputElement = inputRef.current
        inputElement?.focus({ preventScroll: true })
        inputElement?.setSelectionRange(nextValue.length, nextValue.length)
      })

      return true
    },
    [input, onInputChange, promptHistory, syncPromptHistoryKey]
  )
  const closeInputAddMenu = useCallback((): void => {
    setInputAddMenuOpen(false)
  }, [])
  const toggleInputAddMenu = useCallback((): void => {
    setInputAddMenuOpen((open) => {
      const nextOpen = !open
      if (nextOpen) {
        onOpenInputAddMenu?.()
      }
      return nextOpen
    })
  }, [onOpenInputAddMenu])
  useEffect(() => {
    if (!inputAddMenuOpen) return undefined

    const handleDocumentMouseDown = (event: globalThis.MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (inputAddPanelRef.current?.contains(target)) return
      if (inputAddButtonRef.current?.contains(target)) return
      closeInputAddMenu()
    }

    document.addEventListener('mousedown', handleDocumentMouseDown, true)
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown, true)
    }
  }, [closeInputAddMenu, inputAddMenuOpen])
  const insertInputReference = useCallback(
    (reference: string): void => {
      resetPromptHistoryNavigation()
      const nextValue = appendInputReference(input, reference)
      promptHistoryDraftRef.current = nextValue
      onInputChange(nextValue)

      window.requestAnimationFrame(() => {
        const inputElement = inputRef.current
        inputElement?.focus({ preventScroll: true })
        inputElement?.setSelectionRange(nextValue.length, nextValue.length)
      })
    },
    [input, onInputChange, resetPromptHistoryNavigation]
  )
  const handleChatSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): Promise<void> => {
      closeInputAddMenu()
      return onChatSubmit(event)
    },
    [closeInputAddMenu, onChatSubmit]
  )

  return (
    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ChatMessageList
        messages={messages}
        messagesContainerRef={messagesContainerRef}
        isGenerating={isGenerating}
        currentRunStartedAt={currentRunStartedAt}
        onGoSettings={onGoSettings}
        onOpenLocalPath={onOpenLocalPath}
        cwd={cwd}
      />
      <Box
        sx={{
          px: 2,
          pt: 1.5,
          pb: 2,
          flexShrink: 0
        }}
      >
        <Box component="form" onSubmit={handleChatSubmit} sx={{ maxWidth: 892, mx: 'auto' }}>
          <ToolApprovalDialog
            request={pendingApproval}
            onRespond={onRespondApproval}
            onOpenSession={onOpenApprovalSession}
          />
          {inputAddMenuOpen && (
            <InputAddPanel
              panelId={inputAddPanelId}
              panelRef={inputAddPanelRef}
              skills={skills}
              promptAgents={promptAgents}
              plugins={plugins}
              onPickFiles={onPickInputFiles}
              onInsertReference={insertInputReference}
              onClose={closeInputAddMenu}
            />
          )}
          <Paper
            variant="outlined"
            onMouseDownCapture={focusInputFromComposerSurface}
            sx={{
              borderRadius: 2,
              px: compactComposerControls ? 1.25 : 2,
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
                resetPromptHistoryNavigation()
                promptHistoryDraftRef.current = event.target.value
                onInputChange(event.target.value)
              }}
              onKeyDown={(event) => {
                const historyDirection =
                  event.key === 'ArrowUp' ? 'previous' : event.key === 'ArrowDown' ? 'next' : null
                if (
                  historyDirection &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.nativeEvent.isComposing
                ) {
                  const inputElement = textInputFromEventTarget(event.target)
                  if (
                    inputElement &&
                    isTextInputAtHistoryBoundary(inputElement, historyDirection) &&
                    navigatePromptHistory(historyDirection)
                  ) {
                    event.preventDefault()
                    return
                  }
                }

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
              placeholder={
                compactComposerControls ? '输入消息' : '输入消息，Enter 发送，Shift+Enter 换行'
              }
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
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, minWidth: 0 }}>
                <InputAddControl
                  open={inputAddMenuOpen}
                  controls={inputAddPanelId}
                  buttonRef={inputAddButtonRef}
                  onToggle={toggleInputAddMenu}
                />
                <PermissionModeControl
                  permissionMode={permissionMode}
                  disabled={disablePermissionModeSelect}
                  onSelectPermissionMode={onSelectPermissionMode}
                  compact={compactComposerControls}
                />
              </Box>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: compactComposerControls ? 0.25 : 1,
                  minWidth: 0
                }}
              >
                <ThinkingLevelControl
                  thinkingLevel={thinkingLevel}
                  onSelectThinkingLevel={onSelectThinkingLevel}
                  supportedLevels={selectedModel?.thinkingLevels ?? null}
                  disabled={disableModelControls}
                  compact={compactComposerControls}
                />
                <ModelSelectorControl
                  models={models}
                  selectedModel={selectedModel}
                  onSelectModel={onSelectModel}
                  disabled={disableModelControls}
                  compact={compactComposerControls}
                />
                {!isGenerating ? (
                  <IconButton
                    type="submit"
                    disabled={!canSend || !input.trim()}
                    aria-label="发送消息"
                    data-phi-composer-action="send"
                    data-phi-composer-size={actionControlSize}
                    sx={{
                      width: actionControlSize,
                      height: actionControlSize,
                      minWidth: actionControlSize,
                      minHeight: actionControlSize,
                      flexShrink: 0,
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
                    data-phi-composer-action="stop"
                    data-phi-composer-size={actionControlSize}
                    sx={{
                      width: actionControlSize,
                      height: actionControlSize,
                      minWidth: actionControlSize,
                      minHeight: actionControlSize,
                      flexShrink: 0,
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
