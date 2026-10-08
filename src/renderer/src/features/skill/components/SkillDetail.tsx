import { useEffect, useState, type MouseEvent } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import MarkdownContent from '../../../components/MarkdownContent'
import { ResourceIcon } from '../../../components/ResourceIcon'
import { PhiIcons } from '../../../icons'
import type { SkillSummary } from '../../../types'
import { skillMarkdownBody } from '../lib/skillMarkdown'
import {
  skillDirectory,
  skillIsEnabled,
  skillSourceCategoryLabels,
  skillSourceLabel,
  DEPRECATED_SKILL_LABEL
} from '../lib/skillCatalog'

const SkillIcon = PhiIcons.entity.skill
const DeleteIcon = PhiIcons.action.delete
const LockIcon = PhiIcons.file.lock
const PluginIcon = PhiIcons.entity.plugin

export type SkillDetailProps = {
  selectedSkill: SkillSummary | null
  busySkillId?: string | null
  projectCwd?: string | null
  onSetGlobalEnabled?: (skill: SkillSummary, enabled: boolean) => Promise<void> | void
  onSetProjectOverride?: (skill: SkillSummary, value: boolean | null) => Promise<void> | void
  onNavigateToPlugin?: (pluginId: string) => void
  /** Compatibility bridge for callers that still expose disabled instead of enabled. */
  onSetSkillDisabled?: (skill: SkillSummary, disabled: boolean) => Promise<void> | void
  onDeleteSkill?: (skill: SkillSummary) => Promise<void> | void
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
        setLoadedContent({
          filePath: selectedFilePath,
          content: null,
          error: error instanceof Error ? error.message : String(error)
        })
      })

    return () => {
      cancelled = true
    }
  }, [canReadSkillContent, selectedFilePath])

  if (!selectedFilePath) return { content: null, isLoading: false, error: null }
  if (!canReadSkillContent) {
    return {
      content: null,
      isLoading: false,
      error: '需要重启 Phi 以加载完整 SKILL.md 读取接口。'
    }
  }

  const current =
    loadedContent?.filePath === selectedFilePath ? loadedContent : { content: null, error: null }
  return {
    content: current.content,
    isLoading: loadedContent?.filePath !== selectedFilePath,
    error: current.error
  }
}

function deleteDisabledReason(skill: SkillSummary): string | null {
  if (skill.sourceCategory === 'bundled') return '内置技能不可卸载'
  if (skill.sourceCategory === 'installed-package') return '已安装技能请通过软件包目录管理'
  if (skill.sourceCategory === 'plugin') return '插件技能请在插件页管理'
  return null
}

function stopActionEvent(event: MouseEvent<HTMLElement>): void {
  event.stopPropagation()
}

function SkillEnablementActions({
  skill,
  busySkillId,
  projectCwd,
  onSetGlobalEnabled,
  onSetProjectOverride,
  onNavigateToPlugin,
  onSetSkillDisabled
}: Omit<SkillDetailProps, 'selectedSkill' | 'onDeleteSkill'> & {
  skill: SkillSummary
}): React.JSX.Element {
  const busy = busySkillId === skill.id
  const globalEnabled =
    typeof skill.globalEnabled === 'boolean' ? skill.globalEnabled : skillIsEnabled(skill)
  const setGlobalEnabled = onSetGlobalEnabled
    ? (enabled: boolean) => onSetGlobalEnabled(skill, enabled)
    : onSetSkillDisabled
      ? (enabled: boolean) => onSetSkillDisabled(skill, !enabled)
      : null

  if (skill.sourceCategory === 'plugin') {
    return (
      <Button
        size="small"
        variant="outlined"
        startIcon={<PluginIcon size={16} />}
        disabled={!onNavigateToPlugin || !skill.sourceId}
        onClick={() => {
          if (skill.sourceId) onNavigateToPlugin?.(skill.sourceId)
        }}
      >
        前往插件
      </Button>
    )
  }

  if (skill.core) {
    return (
      <Tooltip title="核心技能由 Phi 依赖，不可关闭">
        <span>
          <Button size="small" variant="outlined" startIcon={<LockIcon size={16} />} disabled>
            核心技能已锁定
          </Button>
        </span>
      </Tooltip>
    )
  }

  return (
    <Stack spacing={1.25} sx={{ minWidth: 210 }} onClick={stopActionEvent}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'flex-end' }}>
        <Typography variant="body2" color="text.secondary">
          全局启用
        </Typography>
        <Tooltip title={globalEnabled ? '全局关闭技能' : '全局启用技能'}>
          <span>
            <Switch
              size="small"
              checked={globalEnabled}
              disabled={busy || !setGlobalEnabled}
              slotProps={{ input: { 'aria-label': '全局启用技能' } }}
              onChange={(_event, checked) => void setGlobalEnabled?.(checked)}
            />
          </span>
        </Tooltip>
      </Stack>
      {projectCwd ? (
        <TextField
          select
          size="small"
          label="当前项目"
          value={
            skill.projectOverride === null
              ? 'inherit'
              : skill.projectOverride
                ? 'enabled'
                : 'disabled'
          }
          disabled={busy || !onSetProjectOverride}
          slotProps={{ select: { inputProps: { 'aria-label': '项目技能覆盖' } } }}
          onChange={(event) => {
            const value = event.target.value
            void onSetProjectOverride?.(skill, value === 'inherit' ? null : value === 'enabled')
          }}
        >
          <MenuItem value="inherit">跟随全局</MenuItem>
          <MenuItem value="enabled">项目启用</MenuItem>
          <MenuItem value="disabled">项目关闭</MenuItem>
        </TextField>
      ) : null}
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

export function SkillDetail({
  selectedSkill,
  busySkillId,
  projectCwd,
  onSetGlobalEnabled,
  onSetProjectOverride,
  onNavigateToPlugin,
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
      // The caller owns action-level feedback; leaving the dialog open preserves context.
    } finally {
      setIsDeleting(false)
    }
  }

  if (!selectedSkill) {
    return (
      <Stack spacing={1} sx={{ height: '100%', alignItems: 'center', justifyContent: 'center' }}>
        <SkillIcon color="disabled" />
        <Typography color="text.secondary">没有找到技能</Typography>
      </Stack>
    )
  }

  const enabled = skillIsEnabled(selectedSkill)
  const cannotDelete = deleteDisabledReason(selectedSkill)
  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <Box sx={{ maxWidth: 860, px: { xs: 3, md: 5 }, pt: 3, pb: 5 }}>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
          <Box
            sx={{
              width: 72,
              height: 72,
              borderRadius: 1,
              bgcolor: enabled ? 'primary.main' : 'action.disabledBackground',
              color: enabled ? 'primary.contrastText' : 'text.secondary',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            <ResourceIcon icon={selectedSkill.icon} kind="skill" size={72} fallbackSize={24} />
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h4" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
              {selectedSkill.name}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {skillSourceLabel(selectedSkill)}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
              <Chip size="small" variant="outlined" label={skillSourceLabel(selectedSkill)} />
              <Chip
                size="small"
                color={enabled ? 'success' : 'default'}
                label={enabled ? '已启用' : '已关闭'}
              />
              {selectedSkill.deprecated ? (
                <Chip
                  size="small"
                  color="warning"
                  variant="outlined"
                  label={DEPRECATED_SKILL_LABEL}
                  title={selectedSkill.deprecated}
                />
              ) : null}
              {selectedSkill.projectOverride !== null && projectCwd ? (
                <Chip
                  size="small"
                  variant="outlined"
                  label={selectedSkill.projectOverride ? '项目已启用' : '项目已关闭'}
                />
              ) : null}
            </Stack>
            {selectedSkill.deprecated ? (
              <Typography variant="body2" color="warning.main" sx={{ mt: 1 }}>
                {selectedSkill.deprecated}
              </Typography>
            ) : null}
          </Box>
          <Stack spacing={1} sx={{ alignItems: 'flex-end', flexShrink: 0 }}>
            <SkillEnablementActions
              skill={selectedSkill}
              busySkillId={busySkillId}
              projectCwd={projectCwd}
              onSetGlobalEnabled={onSetGlobalEnabled}
              onSetProjectOverride={onSetProjectOverride}
              onNavigateToPlugin={onNavigateToPlugin}
              onSetSkillDisabled={onSetSkillDisabled}
            />
            <Tooltip title={cannotDelete ?? '卸载技能'}>
              <span>
                <IconButton
                  size="small"
                  color="error"
                  disabled={
                    busySkillId === selectedSkill.id || !onDeleteSkill || Boolean(cannotDelete)
                  }
                  aria-label={`卸载技能 ${selectedSkill.name}`}
                  onClick={() => setDeleteCandidate(selectedSkill)}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Stack>

        <Divider sx={{ my: 4 }} />
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
          说明
        </Typography>
        <Typography variant="body1" sx={{ maxWidth: 720 }}>
          {selectedSkill.description || '这个技能没有提供说明。'}
        </Typography>

        <Typography variant="h6" sx={{ fontWeight: 700, mt: 4, mb: 1 }}>
          来源
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {skillSourceCategoryLabels[selectedSkill.sourceCategory]} · {selectedSkill.source}
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
            bgcolor: (theme) =>
              theme.palette.mode === 'dark'
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
                '& [data-phi-markdown-code-language="markdown"]': { whiteSpace: 'pre-wrap' }
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
      </Box>
      <SkillDeleteDialog
        skill={deleteCandidate}
        isDeleting={isDeleting}
        onClose={() => setDeleteCandidate(null)}
        onConfirm={confirmDelete}
      />
    </Box>
  )
}
