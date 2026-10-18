import { memoryUi } from '../lib/memoryUi'
import { getUiLocale, useUiLanguage } from '../../../lib/i18n'
import { useCallback, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  Tooltip,
  Typography
} from '@mui/material'

import { PhiIcons } from '../../../icons'
import type { Project } from '../../../lib/projectTypes'
import type {
  ProjectMemoryLesson,
  ProjectMemorySettings,
  ProjectMemorySnapshot
} from '../../../../../shared/projectMemoryTypes'
import { nextProjectMemorySettings } from '../lib/projectMemorySettings'

const DeleteIcon = PhiIcons.action.delete
const ExpandIcon = PhiIcons.action.expand
const CollapseIcon = PhiIcons.action.collapse

type ProjectMemoryCardProps = {
  project: Project
  settings: ProjectMemorySettings
  onSettingsSaved: (project: Project) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatTime(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(getUiLocale())
}

export function ProjectMemoryCard({
  project,
  settings,
  onSettingsSaved
}: ProjectMemoryCardProps): React.JSX.Element {
  useUiLanguage()
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const operationRef = useRef(false)
  const [expanded, setExpanded] = useState(false)
  const [snapshot, setSnapshot] = useState<ProjectMemorySnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remote = project.location?.kind === 'ssh'

  const run = useCallback(async (action: () => Promise<ProjectMemorySnapshot>) => {
    if (operationRef.current) return
    operationRef.current = true
    setLoading(true)
    setError(null)
    try {
      setSnapshot(await action())
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      operationRef.current = false
      setLoading(false)
    }
  }, [])

  const toggleExpanded = (): void => {
    const next = !expanded
    setExpanded(next)
    if (next) void run(() => window.api.getProjectMemory(project.id))
  }

  const updateSettings = async (
    key: keyof ProjectMemorySettings,
    value: boolean
  ): Promise<void> => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      onSettingsSaved(
        await window.api.updateProjectMemory(
          project.id,
          nextProjectMemorySettings(settings, key, value)
        )
      )
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const deleteLesson = (lesson: ProjectMemoryLesson): void => {
    void run(() => window.api.deleteProjectMemoryLesson(project.id, lesson.index, lesson.text))
  }

  const clearMemory = (): void => {
    setConfirmingClear(false)
    void run(() => window.api.clearProjectMemory(project.id))
  }

  const empty = snapshot !== null && !snapshot.summary && snapshot.lessons.length === 0

  return (
    <Box sx={{ p: 2.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, minWidth: 0 }}>
          {project.name}
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          label={remote ? memoryUi.remoteProject : memoryUi.localProject}
        />
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          onClick={toggleExpanded}
          endIcon={expanded ? <CollapseIcon /> : <ExpandIcon />}
        >
          {expanded ? memoryUi.collapse : memoryUi.viewMemory}
        </Button>
      </Stack>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={{ xs: 0.5, md: 3 }} sx={{ mt: 1 }}>
        <FormControlLabel
          control={
            <Switch
              checked={settings.enabled}
              disabled={saving}
              onChange={(event) => void updateSettings('enabled', event.target.checked)}
            />
          }
          label={memoryUi.projectMemory}
        />
        <FormControlLabel
          control={
            <Switch
              checked={settings.learn}
              disabled={saving || !settings.enabled}
              onChange={(event) => void updateSettings('learn', event.target.checked)}
            />
          }
          label={memoryUi.allowTheAgentToRecordLessons}
        />
      </Stack>

      {error && (
        <Alert severity="error" variant="outlined" sx={{ mt: 1.5, borderRadius: 1 }}>
          {error}
        </Alert>
      )}

      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ mt: 1.5 }}>
          {loading && snapshot === null ? (
            <CircularProgress size={20} />
          ) : empty ? (
            <Typography variant="body2" color="text.secondary">
              {memoryUi.noMemoryYetWhenEnabledPhiGeneratesA}
            </Typography>
          ) : snapshot ? (
            <Stack spacing={2}>
              {snapshot.summary && (
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    {memoryUi.conversationSummary}{' '}
                    {snapshot.summaryUpdatedAt
                      ? memoryUi.updatedValue(formatTime(snapshot.summaryUpdatedAt))
                      : ''}
                  </Typography>
                  <Typography
                    component="pre"
                    sx={{
                      m: 0,
                      mt: 0.5,
                      p: 1.5,
                      maxHeight: 280,
                      overflow: 'auto',
                      borderRadius: 1,
                      bgcolor: 'action.hover',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.8rem',
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere'
                    }}
                  >
                    {snapshot.summary}
                  </Typography>
                </Box>
              )}
              {snapshot.lessons.length > 0 && (
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    {memoryUi.lessonsCount(snapshot.lessons.length)}
                  </Typography>
                  <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                    {snapshot.lessons.map((lesson) => (
                      <Stack
                        key={`${lesson.index}:${lesson.text}`}
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: 'flex-start' }}
                      >
                        <Typography variant="body2" sx={{ flex: 1, overflowWrap: 'anywhere' }}>
                          {lesson.text}
                        </Typography>
                        <Tooltip title={memoryUi.deleteThisLesson}>
                          <span>
                            <IconButton
                              size="small"
                              aria-label={memoryUi.deleteThisLesson}
                              disabled={loading}
                              onClick={() => deleteLesson(lesson)}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Stack>
                    ))}
                  </Stack>
                </Box>
              )}
            </Stack>
          ) : null}

          {snapshot && !empty && (
            <Stack direction="row" spacing={1} sx={{ mt: 2, alignItems: 'center' }}>
              {confirmingClear ? (
                <>
                  <Typography variant="body2" color="error.main">
                    {memoryUi.clearingMemoryExcludesExistingConversationsFromFutureSummaries}
                  </Typography>
                  <Button size="small" onClick={() => setConfirmingClear(false)}>
                    {memoryUi.cancel}
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    variant="contained"
                    disabled={loading}
                    onClick={clearMemory}
                  >
                    {memoryUi.confirmClear}
                  </Button>
                </>
              ) : (
                <Button
                  size="small"
                  color="error"
                  variant="outlined"
                  disabled={loading}
                  onClick={() => setConfirmingClear(true)}
                >
                  {memoryUi.clearMemory}
                </Button>
              )}
            </Stack>
          )}
        </Box>
      </Collapse>
    </Box>
  )
}
