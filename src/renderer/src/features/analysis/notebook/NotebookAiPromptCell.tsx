import { useEffect, useRef, useState, type DragEvent } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  IconButton,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import { TbGripVertical, TbSparkles } from 'react-icons/tb'

import { ModelSelectorControl } from '../../../components/chat/ChatComposerControls'
import { PhiIcons } from '../../../icons'
import { getProviderErrorDisplay } from '../../../lib/providerErrors'
import { notebookContextKindLabel } from '../lib/notebookViewModel'
import { type SyntaxLanguage } from '../../../lib/syntaxHighlight'
import type { AnalysisNotebookContextReference, ModelOption } from '../../../types'
import {
  notebookAccentBoxShadow,
  notebookAccentColor,
  notebookCaretColor
} from './notebookCellStyles'
import { notebookInsertCodeAction } from './notebookInsertCodeAction'

const CloseIcon = PhiIcons.action.close
const FileIcon = PhiIcons.tool.read
const SendIcon = PhiIcons.action.send
const MarkdownIcon = PhiIcons.file.markdown

export type NotebookAiPromptCellProps = {
  language: SyntaxLanguage
  codeLanguage: SyntaxLanguage
  prompt: string
  references: AnalysisNotebookContextReference[]
  contextOptions: AnalysisNotebookContextReference[]
  modelOptions: ModelOption[]
  selectedModel: ModelOption | null
  isGenerating: boolean
  error?: string | null
  errorDetail?: string | null
  canPickContextFiles?: boolean
  onSelect: () => void
  onPromptChange: (prompt: string) => void
  onLanguageChange: (language: SyntaxLanguage) => void
  onModelChange: (model: ModelOption | null) => void
  onReferenceAdd: (reference: AnalysisNotebookContextReference) => void
  onPickContextFiles: () => void
  onSubmit: () => void
  onCancel: () => void
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void
}

function comparableAiErrorText(value: string): string {
  return value
    .replace(/请换一种更具体的描述后重试/g, '')
    .replace(/[。.,，\s]/g, '')
    .trim()
}

function shouldShowAiErrorSummary(error: string | null | undefined, detail: string): boolean {
  if (!error || !detail) return false
  const comparableError = comparableAiErrorText(error)
  const comparableDetail = comparableAiErrorText(detail)
  if (!comparableError || !comparableDetail) return false
  return comparableError !== comparableDetail
}

function NotebookContextPreviewField({
  label,
  value,
  pre,
  dataAttribute
}: {
  label: string
  value?: string
  pre?: boolean
  dataAttribute?: string
}): React.JSX.Element | null {
  if (!value) return null

  return (
    <Box sx={{ mt: 1 }}>
      <Typography sx={{ mb: 0.45, color: 'text.secondary', fontSize: '0.72rem', fontWeight: 800 }}>
        {label}
      </Typography>
      <Typography
        component={pre ? 'pre' : 'div'}
        data-phi-notebook-ai-context-preview-code={dataAttribute === 'code' ? 'true' : undefined}
        data-phi-notebook-ai-context-preview-output={
          dataAttribute === 'output' ? 'true' : undefined
        }
        sx={{
          m: 0,
          px: 1,
          py: 0.75,
          borderRadius: 1,
          bgcolor: 'action.hover',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8rem',
          lineHeight: 1.45,
          overflow: 'hidden',
          overflowWrap: 'anywhere',
          whiteSpace: pre ? 'pre-wrap' : 'normal'
        }}
      >
        {value}
      </Typography>
    </Box>
  )
}

function NotebookContextPreview({
  reference
}: {
  reference: AnalysisNotebookContextReference
}): React.JSX.Element {
  const preview = reference.preview
  const kindLabel = notebookContextKindLabel(reference.kind)

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
        <Typography
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.95rem',
            fontWeight: 800
          }}
        >
          {reference.name}
        </Typography>
        <Chip
          size="small"
          label={kindLabel}
          sx={{
            height: 22,
            borderRadius: 999,
            bgcolor: (theme) => alpha(notebookAccentColor(theme, 'ai'), 0.12),
            color: (theme) => notebookAccentColor(theme, 'ai'),
            fontSize: '0.72rem',
            fontWeight: 800
          }}
        />
      </Box>

      {reference.kind === 'cell_output' ? (
        <>
          <NotebookContextPreviewField
            label="Code:"
            value={preview?.code}
            pre
            dataAttribute="code"
          />
          <NotebookContextPreviewField
            label="Output Preview:"
            value={preview?.output}
            pre
            dataAttribute="output"
          />
        </>
      ) : null}

      {reference.kind === 'dataframe' ? (
        <>
          <NotebookContextPreviewField
            label="Source:"
            value={preview?.source ?? reference.detail}
            pre
          />
          <NotebookContextPreviewField label="Shape:" value={preview?.shape} />
          {preview?.columns?.length ? (
            <Box sx={{ mt: 1, overflow: 'hidden', border: 1, borderColor: 'divider' }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
                <Typography sx={{ px: 0.8, py: 0.55, fontWeight: 800 }}>Column</Typography>
                <Typography sx={{ px: 0.8, py: 0.55, fontWeight: 800 }}>Type</Typography>
              </Box>
              {preview.columns.map((column) => (
                <Box
                  key={column.name}
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    borderTop: 1,
                    borderColor: 'divider'
                  }}
                >
                  <Typography sx={{ px: 0.8, py: 0.55, fontFamily: 'var(--font-mono)' }}>
                    {column.name}
                  </Typography>
                  <Typography
                    sx={{
                      px: 0.8,
                      py: 0.55,
                      color: 'text.secondary',
                      fontFamily: 'var(--font-mono)'
                    }}
                  >
                    {column.type ?? ''}
                  </Typography>
                </Box>
              ))}
            </Box>
          ) : null}
        </>
      ) : null}

      {reference.kind === 'variable' ? (
        <>
          <NotebookContextPreviewField label="Type:" value={reference.detail} />
          <NotebookContextPreviewField label="Value:" value={preview?.value} pre />
        </>
      ) : null}

      {reference.kind === 'data_source' ? (
        <NotebookContextPreviewField label="Path:" value={preview?.source ?? reference.name} pre />
      ) : null}
    </>
  )
}

export default function NotebookAiPromptCell({
  language,
  codeLanguage,
  prompt,
  references,
  contextOptions,
  modelOptions,
  selectedModel,
  isGenerating,
  error,
  errorDetail,
  canPickContextFiles = true,
  onSelect,
  onPromptChange,
  onLanguageChange,
  onModelChange,
  onReferenceAdd,
  onPickContextFiles,
  onSubmit,
  onCancel,
  onDragStart
}: NotebookAiPromptCellProps): React.JSX.Element {
  const isMarkdownTarget = language === 'markdown'
  const codeAction = notebookInsertCodeAction(codeLanguage)
  const targetAction = isMarkdownTarget
    ? {
        label: 'Markdown',
        renderIcon: (disabled: boolean) => (
          <MarkdownIcon sx={{ fontSize: 18, opacity: disabled ? 0.58 : 1 }} />
        )
      }
    : codeAction
  const errorOutputText = (errorDetail ?? error ?? '').trim()
  const showErrorSummary = shouldShowAiErrorSummary(error, errorOutputText)
  const errorDisplay = errorOutputText ? getProviderErrorDisplay(errorOutputText) : null
  const canSubmit = prompt.trim().length > 0 && !isGenerating
  const submitTooltip = isGenerating ? '正在生成代码' : canSubmit ? '生成代码' : '输入需求后生成'
  const promptCellRef = useRef<HTMLDivElement | null>(null)
  const contextOptionListRef = useRef<HTMLDivElement | null>(null)
  const contextOptionRefs = useRef(new Map<string, HTMLDivElement>())
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [languageMenuAnchor, setLanguageMenuAnchor] = useState<HTMLElement | null>(null)
  const [activeContextOptionId, setActiveContextOptionId] = useState<string | null>(null)
  const showContextMenu = contextMenuOpen
  const selectedReferenceIds = new Set(references.map((reference) => reference.id))
  const groupedContextOptions = contextOptions.reduce((groups, option) => {
    const label = notebookContextKindLabel(option.kind)
    groups.set(label, [...(groups.get(label) ?? []), option])
    return groups
  }, new Map<string, AnalysisNotebookContextReference[]>())
  const visibleContextOptions = Array.from(groupedContextOptions.values()).flat()
  const activeContextOption =
    visibleContextOptions.find((option) => option.id === activeContextOptionId) ??
    visibleContextOptions[0] ??
    null
  const moveActiveContextOption = (direction: 1 | -1): void => {
    if (visibleContextOptions.length === 0) return
    const currentIndex = activeContextOption
      ? visibleContextOptions.findIndex((option) => option.id === activeContextOption.id)
      : -1
    const nextIndex =
      currentIndex >= 0
        ? (currentIndex + direction + visibleContextOptions.length) % visibleContextOptions.length
        : direction > 0
          ? 0
          : visibleContextOptions.length - 1
    setActiveContextOptionId(visibleContextOptions[nextIndex].id)
  }
  const selectActiveContextOption = (): void => {
    if (!activeContextOption) return
    onReferenceAdd(activeContextOption)
    setActiveContextOptionId(activeContextOption.id)
    setContextMenuOpen(false)
  }
  useEffect(() => {
    if (!showContextMenu) return

    const closeContextMenuOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!promptCellRef.current?.contains(target)) {
        setContextMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', closeContextMenuOnOutsidePointer, true)
    return () => {
      document.removeEventListener('pointerdown', closeContextMenuOnOutsidePointer, true)
    }
  }, [showContextMenu])
  useEffect(() => {
    if (!showContextMenu || !activeContextOption?.id) return
    const list = contextOptionListRef.current
    const option = contextOptionRefs.current.get(activeContextOption.id)
    if (!list || !option) return

    const listRect = list.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    if (optionRect.bottom > listRect.bottom) {
      list.scrollTop += optionRect.bottom - listRect.bottom
    } else if (optionRect.top < listRect.top) {
      list.scrollTop -= listRect.top - optionRect.top
    }
  }, [activeContextOption?.id, showContextMenu])

  return (
    <Box
      ref={promptCellRef}
      data-phi-notebook-ai-prompt-cell="true"
      data-phi-notebook-ai-accent="ai"
      onPointerDown={onSelect}
      onFocusCapture={onSelect}
      sx={{
        display: 'grid',
        gridTemplateColumns: '32px minmax(0, 1fr) 32px',
        gap: 0.5,
        py: 0.45,
        '&:hover .ai-prompt-drag-handle': {
          opacity: 1
        },
        '&:focus-within .ai-prompt-drag-handle': {
          opacity: 1
        }
      }}
    >
      <Box />
      <Box
        sx={{
          position: 'relative',
          border: 1,
          borderColor: (theme) => alpha(notebookAccentColor(theme, 'ai'), 0.22),
          borderRadius: 1.4,
          bgcolor: (theme) => alpha(theme.palette.background.paper, 0.96),
          boxShadow: (theme) => notebookAccentBoxShadow(theme, 'ai'),
          overflow: 'visible'
        }}
      >
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: '32px minmax(0, 1fr) 34px',
            alignItems: 'start',
            gap: 1.2,
            px: 1.2,
            pt: 1.1
          }}
        >
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              pt: 0.55,
              color: (theme) => notebookAccentColor(theme, 'ai')
            }}
          >
            <TbSparkles size={19} />
          </Box>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={2}
            value={prompt}
            disabled={isGenerating}
            placeholder="Generate with AI, @ to include context"
            variant="standard"
            data-phi-notebook-ai-prompt-input="true"
            onChange={(event) => {
              const nextPrompt = event.target.value
              onPromptChange(nextPrompt)
              setContextMenuOpen(/(?:^|\s)@$/.test(nextPrompt))
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                if (canSubmit) onSubmit()
                return
              }
              if (showContextMenu && contextOptions.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  moveActiveContextOption(1)
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  moveActiveContextOption(-1)
                  return
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault()
                  selectActiveContextOption()
                  return
                }
              }
              if (event.key === 'Escape') {
                setContextMenuOpen(false)
              }
            }}
            slotProps={{
              input: {
                disableUnderline: true,
                sx: {
                  alignItems: 'flex-start',
                  color: 'text.primary',
                  caretColor: (theme: Theme) => notebookCaretColor(theme),
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.9rem',
                  lineHeight: 1.6,
                  p: 0.2
                }
              }
            }}
          />
          {showContextMenu ? (
            <Box
              data-phi-notebook-ai-context-menu="true"
              data-phi-notebook-ai-context-menu-placement="above"
              sx={{
                position: 'absolute',
                bottom: 'calc(100% + 8px)',
                left: 56,
                zIndex: 8,
                width: 'min(500px, calc(100% - 88px))',
                maxHeight: 'min(300px, calc(100vh - 220px))',
                overflow: 'hidden',
                border: 1,
                borderColor: (theme) => alpha(theme.palette.text.primary, 0.14),
                borderRadius: 1.5,
                bgcolor: 'background.paper',
                boxShadow: (theme) => `0 18px 42px ${alpha(theme.palette.common.black, 0.2)}`
              }}
            >
              {contextOptions.length === 0 ? (
                <Typography sx={{ px: 1.2, py: 1, color: 'text.secondary', fontSize: '0.82rem' }}>
                  暂无可引用上下文
                </Typography>
              ) : (
                <Box
                  data-phi-notebook-ai-context-layout="compact-preview"
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 210px) minmax(0, 1fr)',
                    minHeight: 0,
                    maxHeight: 'inherit'
                  }}
                >
                  <Box
                    ref={contextOptionListRef}
                    sx={{ minWidth: 0, maxHeight: 'inherit', overflowY: 'auto' }}
                  >
                    {Array.from(groupedContextOptions.entries()).map(([group, options]) => (
                      <Box key={group} data-phi-notebook-ai-context-group={group}>
                        <Typography
                          sx={{
                            px: 1.1,
                            py: 0.45,
                            color: 'text.secondary',
                            bgcolor: 'action.hover',
                            fontSize: '0.72rem',
                            fontWeight: 800,
                            letterSpacing: 0
                          }}
                        >
                          {group}
                        </Typography>
                        {options.map((option) => (
                          <ListItemButton
                            key={option.id}
                            ref={(element) => {
                              if (element) {
                                contextOptionRefs.current.set(option.id, element)
                              } else {
                                contextOptionRefs.current.delete(option.id)
                              }
                            }}
                            dense
                            data-phi-notebook-ai-context-option={option.kind}
                            data-phi-notebook-ai-context-added={
                              selectedReferenceIds.has(option.id) ? 'true' : undefined
                            }
                            selected={activeContextOption?.id === option.id}
                            onMouseEnter={() => setActiveContextOptionId(option.id)}
                            onFocus={() => setActiveContextOptionId(option.id)}
                            onClick={() => {
                              onReferenceAdd(option)
                              setContextMenuOpen(false)
                            }}
                            sx={{
                              minHeight: 32,
                              px: 1.1,
                              gap: 1,
                              '&.Mui-selected': {
                                bgcolor: (theme) => alpha(notebookAccentColor(theme, 'ai'), 0.12)
                              }
                            }}
                          >
                            <Typography
                              component="span"
                              sx={{
                                minWidth: 0,
                                flex: 1,
                                fontFamily: 'var(--font-mono)',
                                fontSize: '0.82rem',
                                fontWeight: 700,
                                lineHeight: 1.25,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                              }}
                            >
                              {option.name}
                            </Typography>
                            <Typography
                              component="span"
                              sx={{
                                color: 'text.secondary',
                                flexShrink: 0,
                                maxWidth: 82,
                                fontSize: '0.72rem',
                                fontFamily: 'var(--font-mono)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                              }}
                            >
                              {option.detail ?? notebookContextKindLabel(option.kind)}
                            </Typography>
                          </ListItemButton>
                        ))}
                      </Box>
                    ))}
                  </Box>
                  <Box
                    data-phi-notebook-ai-context-preview="true"
                    sx={{
                      minWidth: 0,
                      borderLeft: 1,
                      borderColor: (theme) => alpha(theme.palette.text.primary, 0.1),
                      p: 1.25,
                      bgcolor: (theme) => alpha(theme.palette.background.default, 0.42)
                    }}
                  >
                    {activeContextOption ? (
                      <NotebookContextPreview reference={activeContextOption} />
                    ) : null}
                  </Box>
                </Box>
              )}
            </Box>
          ) : null}
          <Tooltip title="关闭">
            <IconButton
              size="small"
              aria-label="关闭 AI 生成"
              onClick={onCancel}
              sx={{ width: 28, height: 28, color: 'text.secondary' }}
            >
              <CloseIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        </Box>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.8,
            px: 1.2,
            pb: 1,
            pt: 0.4
          }}
        >
          <Button
            size="small"
            variant="outlined"
            disabled={isGenerating}
            data-phi-notebook-ai-target-language={
              isMarkdownTarget ? 'markdown' : codeAction.language
            }
            startIcon={targetAction.renderIcon(false)}
            onClick={(event) => setLanguageMenuAnchor(event.currentTarget)}
            sx={{
              height: 32,
              minWidth: 112,
              borderRadius: 1,
              justifyContent: 'flex-start',
              color: 'text.secondary',
              textTransform: 'none',
              fontWeight: 700,
              '&.Mui-disabled': {
                borderColor: (theme) => alpha(theme.palette.text.primary, 0.12),
                color: 'text.secondary'
              }
            }}
          >
            {targetAction.label}
          </Button>
          <Menu
            anchorEl={languageMenuAnchor}
            open={Boolean(languageMenuAnchor)}
            onClose={() => setLanguageMenuAnchor(null)}
            data-phi-notebook-ai-target-language-menu="true"
          >
            <MenuItem
              selected={!isMarkdownTarget}
              onClick={() => {
                onLanguageChange(codeLanguage)
                setLanguageMenuAnchor(null)
              }}
            >
              <ListItemIcon>{codeAction.renderIcon(false)}</ListItemIcon>
              <ListItemText primary={codeAction.label} secondary="按 notebook kernel 生成代码" />
            </MenuItem>
            <MenuItem
              selected={isMarkdownTarget}
              onClick={() => {
                onLanguageChange('markdown')
                setLanguageMenuAnchor(null)
              }}
            >
              <ListItemIcon>
                <MarkdownIcon sx={{ fontSize: 18 }} />
              </ListItemIcon>
              <ListItemText primary="Markdown" secondary="生成说明文字，不生成代码" />
            </MenuItem>
          </Menu>
          <Box data-phi-notebook-ai-model-selector="true" sx={{ minWidth: 0 }}>
            <ModelSelectorControl
              models={modelOptions}
              selectedModel={selectedModel}
              onSelectModel={onModelChange}
              disabled={isGenerating}
            />
          </Box>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="@ 引用上下文">
            <IconButton
              size="small"
              aria-label="@ 引用上下文"
              disabled={isGenerating}
              onClick={() => setContextMenuOpen((open) => !open)}
              sx={{ width: 30, height: 30 }}
            >
              <Typography sx={{ fontWeight: 900, lineHeight: 1 }}>@</Typography>
            </IconButton>
          </Tooltip>
          <Tooltip title="附加文件">
            <span>
              <IconButton
                size="small"
                aria-label="附加文件"
                disabled={isGenerating || !canPickContextFiles}
                onClick={onPickContextFiles}
                sx={{ width: 30, height: 30 }}
              >
                <FileIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={submitTooltip}>
            <span>
              <IconButton
                size="small"
                aria-label="提交 AI 生成"
                disabled={!canSubmit}
                onClick={onSubmit}
                sx={{
                  width: 32,
                  height: 32,
                  color: (theme) =>
                    canSubmit ? notebookAccentColor(theme, 'ai') : theme.palette.text.disabled
                }}
              >
                <SendIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
        {error && errorOutputText && errorDisplay ? (
          <Box
            data-phi-notebook-ai-error-output="true"
            sx={{
              mx: 1.2,
              mb: 1.1,
              pt: 1,
              borderTop: 1,
              borderColor: (theme) => alpha(theme.palette.error.main, 0.22)
            }}
          >
            <Alert severity="error" variant="outlined" data-phi-notebook-ai-error-alert="true">
              <AlertTitle>{errorDisplay.title}</AlertTitle>
              <Typography
                data-phi-notebook-ai-error-description="true"
                variant="body2"
                sx={{
                  color: 'inherit',
                  mb: errorDisplay.showRawMessage || showErrorSummary ? 0.75 : 0
                }}
              >
                {errorDisplay.description}
              </Typography>
              {errorDisplay.showRawMessage ? (
                <Typography
                  variant="body2"
                  data-phi-notebook-ai-error-raw="true"
                  sx={{ color: 'inherit', whiteSpace: 'pre-wrap' }}
                >
                  原始错误：{errorDisplay.rawMessage}
                </Typography>
              ) : null}
              {showErrorSummary ? (
                <Typography
                  data-phi-notebook-ai-error-summary="true"
                  variant="body2"
                  sx={{ color: 'inherit', mt: errorDisplay.showRawMessage ? 0.75 : 0 }}
                >
                  {error}
                </Typography>
              ) : null}
            </Alert>
          </Box>
        ) : null}
      </Box>
      <Box
        sx={{
          minHeight: 54,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'flex-end',
          flexDirection: 'column',
          py: 0.25
        }}
      >
        <Tooltip title="拖动 AI cell">
          <IconButton
            className="ai-prompt-drag-handle"
            size="small"
            aria-label="拖动 AI cell"
            draggable
            data-phi-notebook-ai-drag-handle="true"
            onDragStart={onDragStart}
            sx={{
              width: 22,
              height: 30,
              borderRadius: 0.75,
              opacity: 0,
              color: 'text.disabled',
              cursor: 'grab',
              transition: 'opacity 140ms ease, color 140ms ease',
              '&:active': { cursor: 'grabbing' },
              '&:hover': {
                color: 'text.secondary',
                bgcolor: 'transparent'
              }
            }}
          >
            <TbGripVertical size={18} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  )
}
