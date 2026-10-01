import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject
} from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import MarkdownContent from '../../components/MarkdownContent'
import { PhiIcons } from '../../icons'
import type { SkillSourceCategory, SkillSummary } from '../../types'
import { skillMarkdownBody } from './lib/skillMarkdown'

const SkillIcon = PhiIcons.entity.skill
const SearchIcon = PhiIcons.action.search
const SystemBuiltInIcon = PhiIcons.state.verified
const DeleteIcon = PhiIcons.action.delete
const ExpandIcon = PhiIcons.action.expand

type SidebarWidth = number | string

export type SkillViewProps = {
  skills: SkillSummary[]
  isLoading: boolean
  activeSkillId: string | null
  sidebarWidth: number
  onSelectSkill: (id: string) => void
  onStartSidebarResize: (event: MouseEvent<HTMLDivElement>) => void
  busySkillId?: string | null
  onSetSkillDisabled?: (skill: SkillSummary, disabled: boolean) => Promise<void> | void
  onDeleteSkill?: (skill: SkillSummary) => Promise<void> | void
}

export type SkillSidebarProps = {
  skills: SkillSummary[]
  isLoading: boolean
  activeSkillId: string | null
  sidebarWidth?: SidebarWidth
  onSelectSkill: (skill: SkillSummary) => void
}

export type SkillDetailProps = {
  selectedSkill: SkillSummary | null
  busySkillId?: string | null
  onSetSkillDisabled?: (skill: SkillSummary, disabled: boolean) => Promise<void> | void
  onDeleteSkill?: (skill: SkillSummary) => Promise<void> | void
}

const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const macTitlebarHeight = 44
const contentTopGap = 8
const skillSourceCategoryOrder: SkillSourceCategory[] = [
  'system',
  'third-party',
  'user',
  'generated'
]
const skillSourceCategoryLabels: Record<SkillSourceCategory, string> = {
  system: 'System',
  'third-party': 'Plugin',
  user: 'User',
  generated: 'Agent'
}
const skillSourceCategoryMarkerColors: Record<SkillSourceCategory, string> = {
  system: 'info.main',
  'third-party': 'warning.main',
  user: 'success.main',
  generated: 'primary.main'
}
const skillScopeLabels: Record<SkillSummary['scope'], string> = {
  user: '用户',
  project: '项目',
  temporary: '临时'
}
const SKILL_ACCORDION_HEADER_HEIGHT = 34
const SKILL_LIST_VERTICAL_PADDING = 16
const SKILL_EXPANDED_BODY_MIN_HEIGHT = 96
const validSkillSourceCategories = new Set<SkillSourceCategory>(skillSourceCategoryOrder)
const plainSidebarRowSx = {
  alignItems: 'center',
  borderRadius: 1.5,
  mx: 1,
  my: 0.25,
  py: 1.25,
  backgroundColor: 'transparent !important',
  transition: 'background-color 120ms ease',
  '&:hover': {
    backgroundColor: (theme: Theme) =>
      `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.12 : 0.06)} !important`
  },
  '&.Mui-selected': {
    backgroundColor: (theme: Theme) =>
      `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.1)} !important`,
    boxShadow: 'none'
  },
  '&.Mui-selected:hover': {
    backgroundColor: (theme: Theme) =>
      `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.24 : 0.14)} !important`
  }
} as const

function normalizedSkillText(value: string | undefined): string {
  return value ? value.replaceAll('\\', '/').toLowerCase() : ''
}

function fallbackSkillSourceCategory(skill: SkillSummary): SkillSourceCategory {
  const filePath = normalizedSkillText(skill.filePath)
  const source = normalizedSkillText(skill.source)
  const haystack = `${filePath} ${source}`

  if (haystack.includes('/.agents/skills/') || source.startsWith('agents')) {
    return 'generated'
  }

  if (
    haystack.includes('/skills/.system/') ||
    haystack.includes('/openai-bundled/') ||
    haystack.includes('/openai-primary-runtime/') ||
    source.includes('system') ||
    source.includes('builtin')
  ) {
    return 'system'
  }

  if (
    haystack.includes('/plugins/cache/') ||
    haystack.includes('/plugins/') ||
    source.includes('plugin') ||
    source.includes('package') ||
    source.includes('npm')
  ) {
    return 'third-party'
  }

  return 'user'
}

function skillSourceCategory(skill: SkillSummary): SkillSourceCategory {
  return validSkillSourceCategories.has(skill.sourceCategory)
    ? skill.sourceCategory
    : fallbackSkillSourceCategory(skill)
}

function skillSourceCategoryLabel(skillOrCategory: SkillSummary | SkillSourceCategory): string {
  const category =
    typeof skillOrCategory === 'string' ? skillOrCategory : skillSourceCategory(skillOrCategory)
  return skillSourceCategoryLabels[category]
}

function skillToggleDisabledReason(skill: SkillSummary): string | null {
  return skillSourceCategory(skill) === 'system' ? '系统内置技能不可关闭' : null
}

function skillDeleteDisabledReason(skill: SkillSummary): string | null {
  const category = skillSourceCategory(skill)
  if (category === 'system') return '系统内置技能不可卸载'
  if (category === 'third-party') return '第三方技能请通过开发者扩展管理卸载'
  return null
}

function skillDirectory(filePath: string): string {
  const normalizedPath = filePath.replaceAll('\\', '/')
  const separatorIndex = normalizedPath.lastIndexOf('/')
  return separatorIndex > 0 ? filePath.slice(0, separatorIndex) : ''
}

function sourceLabel(skill: SkillSummary): string {
  if (skillSourceCategory(skill) === 'system') {
    return `${skillSourceCategoryLabel(skill)} · ${skill.source}`
  }
  return `${skillSourceCategoryLabel(skill)} · ${skillScopeLabels[skill.scope]} · ${skill.source}`
}

function groupedSkills(skills: SkillSummary[]): Array<{
  category: SkillSourceCategory
  label: string
  skills: SkillSummary[]
}> {
  return skillSourceCategoryOrder
    .map((category) => ({
      category,
      label: skillSourceCategoryLabel(category),
      skills: skills.filter((skill) => skillSourceCategory(skill) === category)
    }))
    .filter((section) => section.skills.length > 0)
}

function useExpandedSkillBodyMaxHeight(
  listRef: RefObject<HTMLUListElement | null>,
  groupCount: number
): number {
  const [listHeight, setListHeight] = useState(0)

  useEffect(() => {
    const node = listRef.current
    if (!node) return undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setListHeight(rect.height)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [listRef])

  return Math.max(
    SKILL_EXPANDED_BODY_MIN_HEIGHT,
    listHeight - groupCount * SKILL_ACCORDION_HEADER_HEIGHT - SKILL_LIST_VERTICAL_PADDING
  )
}

function selectedSkillFromList(
  skills: SkillSummary[],
  activeSkillId: string | null
): SkillSummary | null {
  return skills.find((skill) => skill.id === activeSkillId) ?? null
}

function stopSkillActionEvent(event: MouseEvent<HTMLElement>): void {
  event.stopPropagation()
}

function SkillManagementActions({
  skill,
  busySkillId,
  onSetSkillDisabled,
  onRequestDelete,
  variant = 'compact'
}: {
  skill: SkillSummary
  busySkillId?: string | null
  onSetSkillDisabled?: (skill: SkillSummary, disabled: boolean) => Promise<void> | void
  onRequestDelete?: (skill: SkillSummary) => void
  variant?: 'compact' | 'detail'
}): React.JSX.Element {
  const isBusy = busySkillId === skill.id
  const toggleReason = skillToggleDisabledReason(skill)
  const deleteReason = skillDeleteDisabledReason(skill)
  const toggleDisabled = isBusy || !onSetSkillDisabled || Boolean(toggleReason)
  const deleteDisabled = isBusy || !onRequestDelete || Boolean(deleteReason)
  const toggleTitle = toggleReason ?? (skill.disabled ? '启用技能' : '关闭技能')
  const deleteTitle = deleteReason ?? '卸载技能'

  const switchControl = (
    <Tooltip title={toggleTitle}>
      <span>
        <Switch
          size="small"
          checked={!skill.disabled}
          disabled={toggleDisabled}
          slotProps={{ input: { 'aria-label': skill.disabled ? '启用技能' : '关闭技能' } }}
          onClick={stopSkillActionEvent}
          onChange={(event) => {
            event.stopPropagation()
            void onSetSkillDisabled?.(skill, !event.target.checked)
          }}
        />
      </span>
    </Tooltip>
  )

  const deleteControl = (
    <Tooltip title={deleteTitle}>
      <span>
        <IconButton
          size="small"
          color="error"
          disabled={deleteDisabled}
          aria-label={`卸载技能 ${skill.name}`}
          onClick={(event) => {
            event.stopPropagation()
            onRequestDelete?.(skill)
          }}
        >
          <DeleteIcon fontSize="small" />
        </IconButton>
      </span>
    </Tooltip>
  )

  if (variant === 'detail') {
    return (
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', flexShrink: 0 }}
        onClick={stopSkillActionEvent}
      >
        {switchControl}
        {deleteControl}
      </Stack>
    )
  }

  return (
    <Stack
      direction="row"
      spacing={0.25}
      sx={{ alignItems: 'center', flexShrink: 0, ml: 0.75 }}
      onClick={stopSkillActionEvent}
    >
      {switchControl}
      {deleteControl}
    </Stack>
  )
}

function SkillDeleteDialog({
  skill,
  isDeleting,
  onClose,
  onConfirm
}: {
  skill: SkillSummary | null
  isDeleting: boolean
  onClose: () => void
  onConfirm: (skill: SkillSummary) => Promise<void>
}): React.JSX.Element {
  return (
    <Dialog
      open={Boolean(skill)}
      onClose={isDeleting ? undefined : onClose}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>卸载技能</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1 }}>
          确定卸载技能「{skill?.name}」吗？这个操作会删除它所在的技能目录。
        </Typography>
        <Typography
          component="code"
          sx={{
            display: 'block',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.78rem',
            color: 'text.secondary',
            overflowWrap: 'anywhere'
          }}
        >
          {skill ? skillDirectory(skill.filePath) : ''}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isDeleting}>
          取消
        </Button>
        <Button
          color="error"
          variant="contained"
          disabled={!skill || isDeleting}
          onClick={() => {
            if (skill) void onConfirm(skill)
          }}
        >
          卸载
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function ResizeSeparator({
  onMouseDown
}: {
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧边栏宽度"
      onMouseDown={onMouseDown}
      sx={{
        width: '1px',
        flexShrink: 0,
        position: 'relative',
        cursor: 'col-resize',
        bgcolor: (muiTheme) =>
          muiTheme.palette.mode === 'dark' ? 'rgba(241, 246, 246, 0.18)' : 'rgba(15, 42, 48, 0.18)',
        zIndex: 5,
        WebkitAppRegion: 'no-drag',
        '&::before': {
          content: '""',
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: -4,
          right: -4
        }
      }}
    />
  )
}

function DetailPage({
  title,
  children
}: {
  title: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <Box
      component="main"
      sx={{
        flex: 1,
        minWidth: 0,
        height: '100vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <Box
        sx={{
          height: macTitlebarHeight,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          px: 2,
          borderBottom: 1,
          borderColor: 'divider',
          backgroundColor: (muiTheme) =>
            muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
          WebkitAppRegion: 'drag',
          zIndex: 7
        }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      </Box>
      {children}
    </Box>
  )
}

export function SkillSidebar({
  skills,
  isLoading,
  activeSkillId,
  sidebarWidth = '100%',
  onSelectSkill
}: SkillSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredSkills = useMemo(() => {
    if (!normalizedQuery) return skills
    return skills.filter((skill) =>
      [
        skill.name,
        skill.description,
        skill.source,
        skill.filePath,
        skill.scope,
        skillSourceCategoryLabel(skill)
      ]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedQuery))
    )
  }, [normalizedQuery, skills])
  const skillSections = useMemo(() => groupedSkills(filteredSkills), [filteredSkills])
  const selectedSkill = selectedSkillFromList(filteredSkills, activeSkillId)
  const enabledCount = skills.filter((skill) => !skill.disabled).length
  const listRef = useRef<HTMLUListElement | null>(null)
  const selectedCategory = selectedSkill ? skillSourceCategory(selectedSkill) : null
  const [manualExpandedCategory, setManualExpandedCategory] = useState<
    SkillSourceCategory | null | undefined
  >(undefined)
  const [trackedSelectedCategory, setTrackedSelectedCategory] = useState(selectedCategory)
  if (selectedCategory !== trackedSelectedCategory) {
    setTrackedSelectedCategory(selectedCategory)
    if (selectedCategory) setManualExpandedCategory(selectedCategory)
  }
  const expandedCategory =
    manualExpandedCategory !== undefined
      ? manualExpandedCategory
      : (selectedCategory ?? skillSections[0]?.category ?? null)
  const expandedBodyMaxHeight = useExpandedSkillBodyMaxHeight(listRef, skillSections.length)
  const handleExpandedChange = useCallback(
    (category: SkillSourceCategory, isExpanded: boolean): void => {
      setManualExpandedCategory(isExpanded ? category : null)
    },
    []
  )

  return (
    <Box
      className="app-sidebar-surface"
      sx={{
        width: sidebarWidth,
        minWidth: 0,
        flexShrink: 0,
        backgroundColor: (muiTheme) =>
          muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        pt: isMac ? `${macTitlebarHeight + contentTopGap}px` : 2,
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box sx={{ px: 2, pb: 1.5, WebkitAppRegion: 'drag' }}>
        <Typography variant="subtitle1" sx={{ display: 'block', mb: 1.5, fontWeight: 700 }}>
          技能
        </Typography>
        <TextField
          size="small"
          fullWidth
          placeholder="搜索技能"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }
          }}
          sx={{ WebkitAppRegion: 'no-drag' }}
        />
      </Box>

      <Box sx={{ px: 2, pb: 1, WebkitAppRegion: 'no-drag' }}>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Chip size="small" variant="outlined" label={`${skills.length} 个技能`} />
          <Chip size="small" color="success" variant="outlined" label={`${enabledCount} 可用`} />
        </Stack>
      </Box>

      <Divider />

      <List
        ref={listRef}
        disablePadding
        sx={{
          overflow: 'hidden',
          flex: 1,
          py: 1,
          backgroundColor: 'transparent !important',
          WebkitAppRegion: 'no-drag'
        }}
      >
        {isLoading && skills.length === 0 ? (
          <Stack spacing={1.5} sx={{ py: 4, alignItems: 'center' }}>
            <CircularProgress size={22} />
            <Typography variant="body2" color="text.secondary">
              正在读取技能
            </Typography>
          </Stack>
        ) : skillSections.length > 0 ? (
          skillSections.map((section) => (
            <Accordion
              key={section.category}
              expanded={section.category === expandedCategory}
              onChange={(_event, isExpanded) => handleExpandedChange(section.category, isExpanded)}
              disableGutters
              elevation={0}
              slotProps={{
                transition: { timeout: { enter: 200, exit: 120 } }
              }}
              sx={{
                bgcolor: 'transparent',
                border: 0,
                '&::before': { display: 'none' }
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandIcon fontSize="small" />}
                sx={{
                  height: SKILL_ACCORDION_HEADER_HEIGHT,
                  minHeight: `${SKILL_ACCORDION_HEADER_HEIGHT}px !important`,
                  px: 2,
                  py: 0,
                  WebkitAppRegion: 'no-drag',
                  '& .MuiAccordionSummary-content': {
                    alignItems: 'center',
                    my: 0.5,
                    minWidth: 0
                  }
                }}
              >
                <Stack
                  direction="row"
                  spacing={0.75}
                  sx={{ alignItems: 'center', minWidth: 0, width: '100%' }}
                >
                  <Box
                    sx={{
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      bgcolor: skillSourceCategoryMarkerColors[section.category],
                      flexShrink: 0
                    }}
                  />
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', fontWeight: 800, letterSpacing: 0 }}
                  >
                    {section.label}
                  </Typography>
                  {section.category === 'system' ? (
                    <SystemBuiltInIcon
                      title="系统内置"
                      size={14}
                      sx={{ color: 'info.main', flexShrink: 0 }}
                    />
                  ) : null}
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', ml: 'auto !important', fontWeight: 700 }}
                  >
                    {section.skills.length}
                  </Typography>
                </Stack>
              </AccordionSummary>
              <AccordionDetails
                sx={{
                  p: 0,
                  WebkitAppRegion: 'no-drag',
                  ...(section.category === expandedCategory
                    ? { maxHeight: expandedBodyMaxHeight, overflowY: 'auto' }
                    : {})
                }}
              >
                {section.skills.map((skill) => (
                  <ListItemButton
                    key={skill.id}
                    selected={selectedSkill?.id === skill.id}
                    onClick={() => onSelectSkill(skill)}
                    sx={plainSidebarRowSx}
                  >
                    <Box
                      sx={{
                        width: 46,
                        height: 46,
                        mr: 1.5,
                        borderRadius: 1.75,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        bgcolor: skill.disabled ? 'background.paper' : 'primary.main',
                        border: skill.disabled ? 1 : 0,
                        borderColor: 'divider',
                        color: skill.disabled ? 'text.secondary' : 'primary.contrastText',
                        flexShrink: 0
                      }}
                    >
                      <SkillIcon sx={{ fontSize: 28 }} />
                    </Box>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography
                        noWrap
                        title={skill.name}
                        sx={{ fontSize: '0.92rem', fontWeight: 700, lineHeight: 1.25 }}
                      >
                        {skill.name}
                      </Typography>
                      <Typography
                        noWrap
                        title={skill.description || sourceLabel(skill)}
                        color="text.secondary"
                        sx={{ mt: 0.25, fontSize: '0.84rem', lineHeight: 1.25 }}
                      >
                        {skill.description || '这个技能没有提供说明。'}
                      </Typography>
                    </Box>
                  </ListItemButton>
                ))}
              </AccordionDetails>
            </Accordion>
          ))
        ) : (
          <Stack spacing={1} sx={{ py: 4, alignItems: 'center' }}>
            <SkillIcon color="disabled" />
            <Typography variant="body2" color="text.secondary">
              没有找到技能
            </Typography>
          </Stack>
        )}
      </List>
    </Box>
  )
}

type SkillContentState = {
  content: string | null
  isLoading: boolean
  error: string | null
}

type LoadedSkillContent = {
  filePath: string
  content: string | null
  error: string | null
}

function useSkillContent(selectedSkill: SkillSummary | null): SkillContentState {
  const [loadedContent, setLoadedContent] = useState<LoadedSkillContent | null>(null)
  const selectedFilePath = selectedSkill?.filePath ?? null
  const canReadSkillContent = typeof window !== 'undefined' && Boolean(window.api?.readSkillContent)

  useEffect(() => {
    if (!selectedFilePath || !canReadSkillContent) return

    let cancelled = false

    window.api
      .readSkillContent(selectedFilePath)
      .then((result) => {
        if (cancelled) return
        setLoadedContent({
          filePath: selectedFilePath,
          content: skillMarkdownBody(result.content),
          error: null
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        setLoadedContent({
          filePath: selectedFilePath,
          content: null,
          error: message
        })
      })

    return () => {
      cancelled = true
    }
  }, [canReadSkillContent, selectedFilePath])

  if (!selectedFilePath) {
    return { content: null, isLoading: false, error: null }
  }

  if (!canReadSkillContent) {
    return {
      content: null,
      isLoading: false,
      error: '需要重启 Phi 以加载完整 SKILL.md 读取接口。'
    }
  }

  const currentContent =
    loadedContent?.filePath === selectedFilePath ? loadedContent : { content: null, error: null }

  return {
    content: currentContent.content,
    isLoading: loadedContent?.filePath !== selectedFilePath,
    error: currentContent.error
  }
}

export function SkillDetail({
  selectedSkill,
  busySkillId,
  onSetSkillDisabled,
  onDeleteSkill
}: SkillDetailProps): React.JSX.Element {
  const skillContent = useSkillContent(selectedSkill)
  const [deleteCandidate, setDeleteCandidate] = useState<SkillSummary | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const confirmDelete = async (skill: SkillSummary): Promise<void> => {
    if (!onDeleteSkill) return
    setIsDeleting(true)
    try {
      await onDeleteSkill(skill)
      setDeleteCandidate(null)
    } catch {
      // Error feedback is handled by the caller so the dialog can stay open.
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      {selectedSkill ? (
        <Box sx={{ maxWidth: 860, px: { xs: 3, md: 5 }, pt: 3, pb: 5 }}>
          <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
            <Box
              sx={{
                width: 72,
                height: 72,
                borderRadius: 1,
                bgcolor: selectedSkill.disabled ? 'action.disabledBackground' : 'primary.main',
                color: selectedSkill.disabled ? 'text.secondary' : 'primary.contrastText',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              <SkillIcon />
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="h4" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
                {selectedSkill.name}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {sourceLabel(selectedSkill)}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
                <Chip
                  size="small"
                  variant="outlined"
                  label={skillSourceCategoryLabel(selectedSkill)}
                />
                <Chip
                  size="small"
                  color={selectedSkill.disabled ? 'default' : 'success'}
                  label={selectedSkill.disabled ? '仅手动调用' : '可自动调用'}
                />
                {skillSourceCategory(selectedSkill) !== 'system' ? (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={skillScopeLabels[selectedSkill.scope]}
                  />
                ) : null}
              </Stack>
            </Box>
            <SkillManagementActions
              skill={selectedSkill}
              variant="detail"
              busySkillId={busySkillId}
              onSetSkillDisabled={onSetSkillDisabled}
              onRequestDelete={setDeleteCandidate}
            />
          </Stack>

          <Divider sx={{ my: 4 }} />

          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
            说明
          </Typography>
          <Typography variant="body1" sx={{ maxWidth: 720 }}>
            {selectedSkill.description || '这个技能没有提供说明。'}
          </Typography>

          <Typography variant="h6" sx={{ fontWeight: 700, mt: 4, mb: 1 }}>
            文件
          </Typography>
          <Typography
            component="code"
            sx={{
              display: 'block',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.84rem',
              color: 'text.secondary',
              overflowWrap: 'anywhere'
            }}
          >
            {selectedSkill.filePath}
          </Typography>

          <Typography variant="h6" sx={{ fontWeight: 700, mt: 4, mb: 1 }}>
            SKILL.md
          </Typography>
          <Box
            sx={{
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              bgcolor: (muiTheme) =>
                muiTheme.palette.mode === 'dark'
                  ? 'rgba(255, 255, 255, 0.03)'
                  : 'rgba(15, 42, 48, 0.025)',
              overflow: 'auto',
              maxHeight: '62vh'
            }}
          >
            {skillContent.isLoading ? (
              <Stack spacing={1} sx={{ py: 4, alignItems: 'center' }}>
                <CircularProgress size={20} />
                <Typography variant="body2" color="text.secondary">
                  正在读取 SKILL.md
                </Typography>
              </Stack>
            ) : skillContent.error ? (
              <Alert severity="warning" sx={{ m: 2 }}>
                {skillContent.error}
              </Alert>
            ) : skillContent.content !== null ? (
              <Box
                sx={{
                  p: 2,
                  minWidth: 0,
                  '& [data-phi-markdown-code-language="markdown"]': {
                    whiteSpace: 'pre-wrap'
                  }
                }}
              >
                <MarkdownContent
                  text={skillContent.content}
                  cwd={skillDirectory(selectedSkill.filePath)}
                />
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                选择技能后会在这里显示完整源文。
              </Typography>
            )}
          </Box>
          <SkillDeleteDialog
            skill={deleteCandidate}
            isDeleting={isDeleting}
            onClose={() => setDeleteCandidate(null)}
            onConfirm={confirmDelete}
          />
        </Box>
      ) : (
        <Stack spacing={1} sx={{ height: '100%', alignItems: 'center', justifyContent: 'center' }}>
          <SkillIcon color="disabled" />
          <Typography color="text.secondary">没有找到技能</Typography>
        </Stack>
      )}
    </Box>
  )
}

export default function SkillView({
  skills,
  isLoading,
  activeSkillId,
  sidebarWidth,
  onSelectSkill,
  onStartSidebarResize,
  busySkillId,
  onSetSkillDisabled,
  onDeleteSkill
}: SkillViewProps): React.JSX.Element {
  const selectedSkill = selectedSkillFromList(skills, activeSkillId)

  return (
    <Fragment>
      <SkillSidebar
        skills={skills}
        isLoading={isLoading}
        activeSkillId={activeSkillId}
        sidebarWidth={sidebarWidth}
        onSelectSkill={(skill) => onSelectSkill(skill.id)}
      />
      <ResizeSeparator onMouseDown={onStartSidebarResize} />
      <DetailPage title={selectedSkill?.name ?? '技能'}>
        <SkillDetail
          selectedSkill={selectedSkill}
          busySkillId={busySkillId}
          onSetSkillDisabled={onSetSkillDisabled}
          onDeleteSkill={onDeleteSkill}
        />
      </DetailPage>
    </Fragment>
  )
}
