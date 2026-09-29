import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Popover,
  Slider,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { useId, useMemo, useState, type ReactNode } from 'react'
import { PERMISSION_MODE_ICON_META, PhiIcons } from '../../icons'
import type { ModelOption, PermissionMode, ThinkingLevel } from '../../types'
import { ProviderModelIcon } from './ProviderModelIcon'
import { COMPOSER_ICON_SIZE, compactComposerIconButtonSx } from './composerControlStyles'

const BoltIcon = PhiIcons.action.quick
const CheckIcon = PhiIcons.state.check
const ExpandIcon = PhiIcons.action.expand

const THINKING_LEVEL_ORDER: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max'
}

function modelMatchesQuery(option: ModelOption, query: string): boolean {
  return `${option.name} ${option.providerId} ${option.modelId}`.toLowerCase().includes(query)
}

export function ThinkingLevelControl({
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
  // the SDK resolves a default) - in that case don't constrain the slider.
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
            <BoltIcon size={COMPOSER_ICON_SIZE} />
          </IconButton>
        ) : (
          <Button
            size="small"
            onClick={(event) => setAnchorEl(event.currentTarget)}
            disabled={disabled}
            aria-describedby={popoverId}
            startIcon={<BoltIcon size={COMPOSER_ICON_SIZE} />}
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

export function ModelSelectorControl({
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
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null)
  const popoverId = useId()
  const defaultProviderId = models.some((option) => option.providerId === selectedModel?.providerId)
    ? (selectedModel?.providerId ?? null)
    : (models[0]?.providerId ?? null)

  const grouped = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const filtered = normalizedQuery
      ? models.filter((option) => modelMatchesQuery(option, normalizedQuery))
      : models

    const byProvider = new Map<string, ModelOption[]>()
    for (const option of filtered) {
      const group = byProvider.get(option.providerId) ?? []
      group.push(option)
      byProvider.set(option.providerId, group)
    }
    return [...byProvider.entries()]
  }, [models, query])

  const handleOpen = (event: React.MouseEvent<HTMLElement>): void => {
    setExpandedProviderId(defaultProviderId)
    setAnchorEl(event.currentTarget)
  }

  const handleQueryChange = (value: string): void => {
    setQuery(value)
    const normalizedQuery = value.trim().toLowerCase()
    setExpandedProviderId(
      normalizedQuery
        ? (models.find((option) => modelMatchesQuery(option, normalizedQuery))?.providerId ?? null)
        : defaultProviderId
    )
  }

  const handleClose = (): void => {
    setAnchorEl(null)
    setQuery('')
    setExpandedProviderId(null)
  }
  const label = selectedModel ? selectedModel.name : '自动选择'

  return (
    <>
      <Tooltip title={`模型：${label}`} enterDelay={400}>
        {compact ? (
          <IconButton
            size="small"
            disableRipple
            onClick={handleOpen}
            disabled={disabled}
            aria-describedby={popoverId}
            aria-label={`选择模型：${label}`}
            sx={{
              ...compactComposerIconButtonSx,
              color: 'text.secondary',
              '&.Mui-focusVisible': {
                outline: '2px solid',
                outlineColor: 'primary.main',
                outlineOffset: 2
              }
            }}
          >
            <ProviderModelIcon providerId={selectedModel?.providerId} disabled={disabled} />
          </IconButton>
        ) : (
          <Button
            size="small"
            disableRipple
            onClick={handleOpen}
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
              px: 1,
              '&:hover': { bgcolor: 'action.hover' },
              '&.Mui-focusVisible': {
                outline: '2px solid',
                outlineColor: 'primary.main',
                outlineOffset: 2
              }
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
      {/* Search and provider groups stay inside the Popover's Paper. */}
      <Popover
        id={popoverId}
        open={!disabled && Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              width: 280,
              height: 'min(360px, calc(100vh - 32px))',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden'
            }
          }
        }}
      >
        <Box sx={{ p: 1, flexShrink: 0 }}>
          <TextField
            autoFocus
            fullWidth
            size="small"
            placeholder="搜索模型"
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
          />
        </Box>
        <Box sx={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {models.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1 }}>
              无可用模型 — 请先在设置中配置 Provider
            </Typography>
          ) : grouped.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1 }}>
              没有匹配的模型
            </Typography>
          ) : (
            grouped.map(([providerId, options]) => (
              <Accordion
                key={providerId}
                expanded={expandedProviderId === providerId}
                onChange={(_, expanded) => setExpandedProviderId(expanded ? providerId : null)}
                disableGutters
                elevation={0}
                square
                sx={{
                  '&:before': { display: 'none' },
                  '&.Mui-expanded': { m: 0 },
                  borderBottom: 1,
                  borderColor: 'divider'
                }}
              >
                <AccordionSummary
                  expandIcon={<ExpandIcon fontSize="small" />}
                  sx={{
                    minHeight: 38,
                    px: 1.5,
                    '&.Mui-expanded': { minHeight: 38 },
                    '& .MuiAccordionSummary-content': { my: 0.75 },
                    '& .MuiAccordionSummary-content.Mui-expanded': { my: 0.75 }
                  }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {providerId}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 0 }}>
                  <List
                    dense
                    disablePadding
                    sx={{ maxHeight: 180, overflowY: 'auto', overscrollBehavior: 'contain' }}
                  >
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
                  </List>
                </AccordionDetails>
              </Accordion>
            ))
          )}
        </Box>
      </Popover>
    </>
  )
}

const PERMISSION_MODES: Array<{
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

export function PermissionModeControl({
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
  const selectedMode =
    PERMISSION_MODES.find((item) => item.mode === permissionMode) ?? PERMISSION_MODES[1]
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
            <SelectedPermissionIcon size={COMPOSER_ICON_SIZE} />
          </IconButton>
        ) : (
          <Button
            size="small"
            aria-label="选择权限模式"
            aria-describedby={popoverId}
            disabled={disabled}
            onClick={(event) => setAnchorEl(event.currentTarget)}
            startIcon={<SelectedPermissionIcon size={COMPOSER_ICON_SIZE} />}
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
          {PERMISSION_MODES.map((item) => {
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
