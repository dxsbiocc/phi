import { useUiLanguage } from '../../../lib/i18n'
import { skillCopy } from '../lib/skillCopy'
import { resourceUi, resourceSourceLabel } from '../../../lib/resourceUi'
import { useEffect, useState, type MouseEvent } from 'react'
import {
  Button,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'

import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import { PhiIcons } from '../../../icons'
import type { SkillSummary } from '../../../types'
import { RemoteProjectTrustControl, RemoteProjectTrustStatus } from '../../agent/AgentTrustPanel'
import { skillMarkdownBody } from '../lib/skillMarkdown'
import { mutateRemoteSkillTrust } from '../lib/remoteSkillTrust'
import { SkillDetailBody } from './SkillDetailBody'
import {
  skillDirectory,
  skillIsEnabled,
  skillSourceCategoryLabels,
  skillSourceLabel
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
  onRefresh?: () => Promise<void> | void
}

type SkillContentState = {
  content: string | null
  isLoading: boolean
  error: string | null
}

type LoadedSkillContent = {
  filePath: string
  contentHash: string | null
  content: string | null
  error: string | null
}

function useSkillContent(selectedSkill: SkillSummary | null): SkillContentState {
  const [loadedContent, setLoadedContent] = useState<LoadedSkillContent | null>(null)
  const selectedFilePath = selectedSkill?.filePath ?? null
  const selectedContentHash = selectedSkill?.contentHash ?? null
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
          contentHash: selectedContentHash,
          content: skillMarkdownBody(result.content),
          error: null
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadedContent({
          filePath: selectedFilePath,
          contentHash: selectedContentHash,
          content: null,
          error: error instanceof Error ? error.message : String(error)
        })
      })

    return () => {
      cancelled = true
    }
  }, [canReadSkillContent, selectedContentHash, selectedFilePath])

  if (!selectedFilePath) return { content: null, isLoading: false, error: null }
  if (!canReadSkillContent) {
    return {
      content: null,
      isLoading: false,
      error: skillCopy.restartForMarkdown
    }
  }

  const current =
    loadedContent?.filePath === selectedFilePath &&
    loadedContent.contentHash === selectedContentHash
      ? loadedContent
      : { content: null, error: null }
  return {
    content: current.content,
    isLoading:
      loadedContent?.filePath !== selectedFilePath ||
      loadedContent.contentHash !== selectedContentHash,
    error: current.error
  }
}

function deleteDisabledReason(skill: SkillSummary): string | null {
  if (skill.sourceCategory === 'bundled') return skillCopy.cannotUninstallBuiltIn
  if (skill.sourceCategory === 'installed-package') return skillCopy.manageInstalled
  if (skill.sourceCategory === 'plugin') return skillCopy.managePlugin
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
  useUiLanguage()

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
        {skillCopy.goToPlugin}
      </Button>
    )
  }

  if (skill.core) {
    return (
      <Tooltip title={skillCopy.coreRequired}>
        <span>
          <Button size="small" variant="outlined" startIcon={<LockIcon size={16} />} disabled>
            {skillCopy.coreLocked}
          </Button>
        </span>
      </Tooltip>
    )
  }

  return (
    <Stack spacing={1.25} sx={{ minWidth: 210 }} onClick={stopActionEvent}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'flex-end' }}>
        <Typography variant="body2" color="text.secondary">
          {skillCopy.enableGlobally}
        </Typography>
        <Tooltip title={globalEnabled ? skillCopy.disableGlobalSkill : skillCopy.enableGlobalSkill}>
          <span>
            <Switch
              size="small"
              checked={globalEnabled}
              disabled={busy || !setGlobalEnabled}
              slotProps={{ input: { 'aria-label': skillCopy.enableGlobalSkill } }}
              onChange={(_event, checked) => void setGlobalEnabled?.(checked)}
            />
          </span>
        </Tooltip>
      </Stack>
      {projectCwd ? (
        <TextField
          select
          size="small"
          label={skillCopy.currentProject}
          value={
            skill.projectOverride === null
              ? 'inherit'
              : skill.projectOverride
                ? 'enabled'
                : 'disabled'
          }
          disabled={busy || !onSetProjectOverride}
          slotProps={{ select: { inputProps: { 'aria-label': skillCopy.projectOverride } } }}
          onChange={(event) => {
            const value = event.target.value
            void onSetProjectOverride?.(skill, value === 'inherit' ? null : value === 'enabled')
          }}
        >
          <MenuItem value="inherit">{skillCopy.inheritGlobal}</MenuItem>
          <MenuItem value="enabled">{skillCopy.projectEnabled}</MenuItem>
          <MenuItem value="disabled">{skillCopy.projectDisabled}</MenuItem>
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
  useUiLanguage()

  return (
    <ConfirmationDialog open={Boolean(skill)} onClose={isDeleting ? undefined : onClose}>
      <DialogTitle>{skillCopy.uninstallSkill}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1 }}>
          {skillCopy.confirmUninstall(skill?.name ?? '')}
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
          {resourceUi.cancel}
        </Button>
        <Button
          color="error"
          variant="contained"
          disabled={!skill || isDeleting}
          onClick={() => {
            if (skill) void onConfirm(skill)
          }}
        >
          {resourceUi.uninstall}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
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
  onDeleteSkill,
  onRefresh
}: SkillDetailProps): React.JSX.Element {
  useUiLanguage()

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
        <Typography color="text.secondary">{skillCopy.noSkills}</Typography>
      </Stack>
    )
  }

  const enabled = skillIsEnabled(selectedSkill)
  const remoteProjectSkill = selectedSkill.trustState !== undefined
  const cannotDelete = deleteDisabledReason(selectedSkill)
  return (
    <>
      <SkillDetailBody
        name={selectedSkill.name}
        icon={selectedSkill.icon}
        enabled={enabled}
        sourceLabel={skillSourceLabel(selectedSkill)}
        chips={
          <>
            <Chip size="small" variant="outlined" label={skillSourceLabel(selectedSkill)} />
            {!remoteProjectSkill ? (
              <Chip
                size="small"
                color={enabled ? 'success' : 'default'}
                label={enabled ? resourceUi.enabled : resourceUi.disabled}
              />
            ) : null}
            {selectedSkill.deprecated ? (
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                label={skillCopy.deprecated}
                title={selectedSkill.deprecated}
              />
            ) : null}
            {selectedSkill.projectOverride !== null && projectCwd ? (
              <Chip
                size="small"
                variant="outlined"
                label={
                  selectedSkill.projectOverride
                    ? skillCopy.projectEnabled
                    : skillCopy.projectDisabled
                }
              />
            ) : null}
          </>
        }
        notice={
          <>
            {remoteProjectSkill ? (
              <RemoteProjectTrustStatus
                resource={selectedSkill}
                sourceLabel={skillCopy.serverProject}
              />
            ) : null}
            {selectedSkill.deprecated ? (
              <Typography variant="body2" color="warning.main" sx={{ mt: 1 }}>
                {selectedSkill.deprecated}
              </Typography>
            ) : null}
          </>
        }
        actions={
          remoteProjectSkill && projectCwd ? (
            <RemoteProjectTrustControl
              resource={selectedSkill}
              cwd={projectCwd}
              onMutate={mutateRemoteSkillTrust}
              onChanged={onRefresh ?? (() => undefined)}
            />
          ) : (
            <>
              <SkillEnablementActions
                skill={selectedSkill}
                busySkillId={busySkillId}
                projectCwd={projectCwd}
                onSetGlobalEnabled={onSetGlobalEnabled}
                onSetProjectOverride={onSetProjectOverride}
                onNavigateToPlugin={onNavigateToPlugin}
                onSetSkillDisabled={onSetSkillDisabled}
              />
              <Tooltip title={cannotDelete ?? skillCopy.uninstallSkill}>
                <span>
                  <IconButton
                    size="small"
                    color="error"
                    disabled={
                      busySkillId === selectedSkill.id || !onDeleteSkill || Boolean(cannotDelete)
                    }
                    aria-label={skillCopy.uninstallNamed(selectedSkill.name)}
                    onClick={() => setDeleteCandidate(selectedSkill)}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </>
          )
        }
        description={selectedSkill.description}
        sourceText={`${skillSourceCategoryLabels[selectedSkill.sourceCategory]} · ${resourceSourceLabel(selectedSkill.source)}`}
        location={selectedSkill.filePath}
        markdown={skillContent}
        markdownCwd={remoteProjectSkill ? undefined : skillDirectory(selectedSkill.filePath)}
      />
      <SkillDeleteDialog
        skill={deleteCandidate}
        isDeleting={isDeleting}
        onClose={() => setDeleteCandidate(null)}
        onConfirm={confirmDelete}
      />
    </>
  )
}
