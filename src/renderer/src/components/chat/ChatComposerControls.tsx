import { chatCopy } from '../../features/chat/lib/chatCopy'
import { useUiLanguage } from '../../lib/i18n'
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
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { useId, useMemo, useState, type ReactNode } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { SparklesIcon } from '@hugeicons/core-free-icons'
import { PhiIcons } from '../../icons'
import type { ModelOption, ThinkingLevel } from '../../types'
import { ThinkingLevelSlider } from './ComposerThinkingSlider'
import { resolveThinkingSelection, thinkingLevelAccent } from './composerThinkingLevel'
import { ProviderModelIcon } from './ProviderModelIcon'
import { COMPOSER_ICON_SIZE, compactComposerIconButtonSx } from './composerControlStyles'

const BoltIcon = PhiIcons.action.quick
const ExpandIcon = PhiIcons.action.expand

function modelMatchesQuery(option: ModelOption, query: string): boolean {
  return `${option.name} ${option.providerId} ${option.modelId}`.toLowerCase().includes(query)
}

export function ModelSelectorControl({
  models,
  selectedModel,
  onSelectModel,
  disabled = false,
  compact = false,
  thinkingLevel,
  supportedThinkingLevels,
  onSelectThinkingLevel,
  onPreviewThinkingLevel
}: {
  models: ModelOption[]
  selectedModel: ModelOption | null
  onSelectModel: (model: ModelOption | null) => void
  disabled?: boolean
  compact?: boolean
  thinkingLevel?: ThinkingLevel
  supportedThinkingLevels?: ThinkingLevel[] | null
  onSelectThinkingLevel?: (level: ThinkingLevel) => void | Promise<void>
  onPreviewThinkingLevel?: (level: ThinkingLevel) => void
}): ReactNode {
  useUiLanguage()
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null)
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | null>(null)
  const [menuBottom, setMenuBottom] = useState<number | null>(null)
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
    const anchorRect = event.currentTarget.getBoundingClientRect()
    setMenuMaxHeight(Math.max(0, Math.floor(anchorRect.top - 16)))
    setMenuBottom(Math.max(0, Math.floor(window.innerHeight - anchorRect.top)))
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
  const label = selectedModel ? selectedModel.name : chatCopy.automatic
  const showThinking = thinkingLevel !== undefined && onSelectThinkingLevel !== undefined
  const thinkingSelection = showThinking
    ? resolveThinkingSelection(thinkingLevel, supportedThinkingLevels ?? null)
    : null
  const thinkingColor =
    thinkingSelection && !disabled && !thinkingSelection.modelDisabled && thinkingSelection.level
      ? thinkingLevelAccent(thinkingSelection.level).to
      : undefined
  const triggerLabel = thinkingSelection
    ? chatCopy.chooseModelAndThinkingValue(label, thinkingSelection.label)
    : compact
      ? chatCopy.chooseModelValue(label)
      : chatCopy.chooseModel

  return (
    <>
      <Tooltip
        title={thinkingSelection ? triggerLabel : chatCopy.modelValue(label)}
        enterDelay={400}
      >
        {compact ? (
          <IconButton
            size="small"
            disableRipple
            onClick={handleOpen}
            disabled={disabled}
            aria-describedby={popoverId}
            aria-label={triggerLabel}
            data-phi-model-thinking={showThinking ? 'true' : undefined}
            sx={{
              ...compactComposerIconButtonSx,
              ...(showThinking ? { width: 'auto', px: 0.75, gap: 0.25 } : {}),
              color: 'text.secondary',
              '&.Mui-focusVisible': {
                outline: '2px solid',
                outlineColor: 'primary.main',
                outlineOffset: 2
              }
            }}
          >
            <ProviderModelIcon providerId={selectedModel?.providerId} disabled={disabled} />
            {showThinking ? (
              <Box
                component="span"
                sx={{ display: 'inline-flex', color: thinkingColor ?? 'inherit' }}
              >
                {thinkingSelection?.level === 'max' ? (
                  <HugeiconsIcon icon={SparklesIcon} size={COMPOSER_ICON_SIZE} />
                ) : (
                  <BoltIcon size={COMPOSER_ICON_SIZE} />
                )}
              </Box>
            ) : null}
          </IconButton>
        ) : (
          <Button
            size="small"
            disableRipple
            onClick={handleOpen}
            disabled={disabled}
            aria-describedby={popoverId}
            aria-label={triggerLabel}
            data-phi-model-thinking={showThinking ? 'true' : undefined}
            startIcon={
              <ProviderModelIcon providerId={selectedModel?.providerId} disabled={disabled} />
            }
            sx={{
              textTransform: 'none',
              color: 'text.secondary',
              fontSize: '0.85rem',
              minHeight: 32,
              maxWidth: showThinking ? 240 : 160,
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
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 1,
                minWidth: 0,
                maxWidth: '100%'
              }}
            >
              <Box
                component="span"
                sx={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'text.secondary'
                }}
              >
                {label}
              </Box>
              {thinkingSelection ? (
                <Box
                  component="span"
                  data-phi-thinking-level={thinkingLevel}
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.25,
                    flexShrink: 0,
                    color: disabled
                      ? 'inherit'
                      : thinkingSelection.modelDisabled
                        ? 'text.disabled'
                        : (thinkingColor ?? 'primary.main'),
                    fontWeight: 700
                  }}
                >
                  {thinkingSelection.level === 'max' ? (
                    <HugeiconsIcon icon={SparklesIcon} size={14} />
                  ) : (
                    <BoltIcon size={14} />
                  )}
                  {thinkingSelection.label}
                </Box>
              ) : null}
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
        elevation={8}
        marginThreshold={showThinking ? 0 : undefined}
        slotProps={{
          paper: {
            sx: showThinking
              ? {
                  width: 280,
                  top: 'auto !important',
                  bottom: menuBottom ?? 0,
                  maxHeight: menuMaxHeight ?? undefined,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden'
                }
              : {
                  width: 280,
                  height: 'min(360px, calc(100vh - 32px))',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden'
                }
          }
        }}
      >
        <Box sx={{ p: 1, pb: 0.5, flexShrink: 0 }}>
          <TextField
            autoFocus
            fullWidth
            size="small"
            placeholder={chatCopy.searchModels}
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
          />
        </Box>
        <Box
          sx={{
            overflowY: 'auto',
            flex: showThinking ? '1 1 auto' : 1,
            minHeight: 0
          }}
        >
          {models.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1 }}>
              {chatCopy.noModelsAvailableConfigureAProviderInSettingsFirst}
            </Typography>
          ) : grouped.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1 }}>
              {chatCopy.noMatchingModels}
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
                  border: 0,
                  bgcolor: 'transparent'
                }}
              >
                <AccordionSummary
                  expandIcon={<ExpandIcon fontSize="small" />}
                  sx={{
                    minHeight: 36,
                    px: 1,
                    '&.Mui-expanded': { minHeight: 36 },
                    '& .MuiAccordionSummary-content': { my: 0.5 },
                    '& .MuiAccordionSummary-content.Mui-expanded': { my: 0.5 }
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
                    sx={{
                      maxHeight: 180,
                      overflowY: 'auto',
                      overscrollBehavior: 'contain'
                    }}
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
                          if (!showThinking) handleClose()
                        }}
                        sx={{ pl: 2.5, pr: 1 }}
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
        {showThinking && onSelectThinkingLevel ? (
          <ThinkingLevelSlider
            thinkingLevel={thinkingLevel}
            supportedLevels={supportedThinkingLevels ?? null}
            disabled={disabled}
            onSelectThinkingLevel={onSelectThinkingLevel}
            onPreviewThinkingLevel={onPreviewThinkingLevel}
          />
        ) : null}
      </Popover>
    </>
  )
}
