import {
  Alert,
  Box,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Typography,
  Button,
  useMediaQuery
} from '@mui/material'
import { useState } from 'react'

import {
  PLAN_MAX_REPLANS,
  type PlanRunTimelineSnapshot,
  type PlanRunTimelineStepSnapshot
} from '../../../../shared/planRunTypes'
import { PhiIcons } from '../../icons'
import { useUiLanguage } from '../../lib/i18n'
import type { RendererApi } from '../../types'
import { usePlanRuns, type OnReplanPrompt, type PlanRunsController } from './hooks/usePlanRuns'
import { planCopy } from './lib/planCopy'
import {
  planRunPauseReason,
  planRunProgress,
  planStepRetryNeedsConfirmation
} from './lib/planRunView'
import { PlanRunControls } from './components/PlanRunControls'
import { PlanStepRow } from './components/PlanStepRow'

type Confirmation =
  { kind: 'stop' } | { kind: 'skip'; stepId: string } | { kind: 'retry'; stepId: string }
type PlanRunPanelProps = { controller: PlanRunsController; cwd?: string }
type PlanPanelState = {
  reduceMotion: boolean
  expanded: boolean
  toggleExpanded: () => void
  confirmation: Confirmation | null
  setConfirmation: React.Dispatch<React.SetStateAction<Confirmation | null>>
  confirm: () => void
  retry: (step: PlanRunTimelineStepSnapshot) => void
}

function pauseReason(run: PlanRunTimelineSnapshot): string | null {
  return planRunPauseReason(run, {
    user: planCopy.pauseUser,
    interrupted: planCopy.pauseInterrupted,
    failed: (step) => planCopy.pauseFailed(String(step)),
    needsInput: (step, inputs) => planCopy.pauseNeedsInput(String(step), inputs.join(', '))
  })
}

function PlanRunHeader({
  run,
  expanded,
  disabled,
  replanPending,
  onToggle,
  onPause,
  onResume,
  onStop
}: {
  run: PlanRunTimelineSnapshot
  expanded: boolean
  disabled: boolean
  replanPending: boolean
  onToggle: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
}): React.JSX.Element {
  const progress = planRunProgress(run)
  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}
    >
      <IconButton
        size="small"
        onClick={onToggle}
        aria-label={expanded ? planCopy.collapseSummary : planCopy.expandSummary}
      >
        {expanded ? <PhiIcons.action.collapse size={18} /> : <PhiIcons.action.expand size={18} />}
      </IconButton>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle2" noWrap title={run.goal}>
          {run.goal}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {planCopy.progress(progress.completed, progress.total)} · {planCopy.runStatus(run.status)}
        </Typography>
      </Box>
      {replanPending ? null : (
        <PlanRunControls
          run={run}
          disabled={disabled}
          onPause={onPause}
          onResume={onResume}
          onStop={onStop}
        />
      )}
    </Stack>
  )
}

function ConfirmationDialog({
  confirmation,
  disabled,
  onCancel,
  onConfirm
}: {
  confirmation: Confirmation | null
  disabled: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const stopping = confirmation?.kind === 'stop'
  const retrying = confirmation?.kind === 'retry'
  return (
    <Dialog open={confirmation !== null} onClose={onCancel} fullWidth maxWidth="xs">
      <DialogTitle>
        {stopping
          ? planCopy.confirmStopTitle
          : retrying
            ? planCopy.confirmRetryTitle
            : planCopy.confirmSkipTitle}
      </DialogTitle>
      <DialogContent>
        {stopping
          ? planCopy.confirmStopBody
          : retrying
            ? planCopy.confirmRetryBody
            : planCopy.confirmSkipBody}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} aria-label={planCopy.cancel}>
          {planCopy.cancel}
        </Button>
        <Button
          color="error"
          variant="contained"
          disabled={disabled}
          onClick={onConfirm}
          aria-label={planCopy.confirm}
        >
          {planCopy.confirm}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function PlanRunBody({
  controller,
  cwd,
  onStop,
  onRetry,
  onSkip
}: {
  controller: PlanRunsController
  cwd: string
  onStop: () => void
  onRetry: (step: PlanRunTimelineStepSnapshot) => void
  onSkip: (stepId: string) => void
}): React.JSX.Element | null {
  const run = controller.run
  if (!run) return null
  const reason = pauseReason(run)
  return (
    <Box sx={{ mt: 1, maxHeight: 'min(42vh, 420px)', overflowY: 'auto' }}>
      {reason ? (
        <Alert severity={run.pause?.reason === 'user' ? 'info' : 'warning'} sx={{ mb: 1 }}>
          {reason}
        </Alert>
      ) : null}
      <Stack spacing={0.25} divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
        {run.steps.map((step, index) => (
          <PlanStepRow
            key={step.id}
            run={run}
            step={step}
            index={index}
            details={controller.details}
            disabled={controller.pendingAction !== null || Boolean(controller.replanPending)}
            cwd={cwd}
            loadDetails={controller.loadDetails}
            onRetry={onRetry}
            onSkip={() => onSkip(step.id)}
            onReplan={
              run.replans < PLAN_MAX_REPLANS &&
              !run.steps.some((candidate) => candidate.status === 'running') &&
              !controller.rollbackPending &&
              !controller.replanPending &&
              controller.replan
                ? () => void controller.replan?.()
                : undefined
            }
            onStop={onStop}
          />
        ))}
      </Stack>
    </Box>
  )
}

function usePlanPanelState(
  run: PlanRunTimelineSnapshot | null,
  controller: PlanRunsController
): PlanPanelState {
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const expansionKey = run ? `${run.id}:${run.status}` : 'none'
  const defaultExpanded = run?.status === 'running' || run?.status === 'paused'
  const [expansion, setExpansion] = useState({ key: expansionKey, expanded: defaultExpanded })
  const expanded = expansion.key === expansionKey ? expansion.expanded : defaultExpanded
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const confirm = (): void => {
    if (controller.replanPending) {
      setConfirmation(null)
      return
    }
    if (confirmation?.kind === 'skip') void controller.skipStep(confirmation.stepId)
    if (confirmation?.kind === 'retry') void controller.retryStep(confirmation.stepId)
    if (confirmation?.kind === 'stop') void controller.stop()
    setConfirmation(null)
  }
  const toggleExpanded = (): void => setExpansion({ key: expansionKey, expanded: !expanded })
  const retry = (step: PlanRunTimelineStepSnapshot): void => {
    if (controller.replanPending) return
    if (planStepRetryNeedsConfirmation(step)) setConfirmation({ kind: 'retry', stepId: step.id })
    else void controller.retryStep(step.id)
  }
  return { reduceMotion, expanded, toggleExpanded, confirmation, setConfirmation, confirm, retry }
}

export function PlanRunPanel({
  controller,
  cwd = ''
}: PlanRunPanelProps): React.JSX.Element | null {
  useUiLanguage()
  const run = controller.run
  const panel = usePlanPanelState(run, controller)
  if (!run || run.status === 'completed' || run.status === 'stopped') return null
  return (
    <Paper
      variant="outlined"
      aria-label={run.goal}
      sx={{ width: '100%', mb: 1, p: 1.25, borderRadius: 2, minWidth: 0 }}
    >
      <PlanRunHeader
        run={run}
        expanded={panel.expanded}
        disabled={controller.pendingAction !== null}
        replanPending={Boolean(controller.replanPending)}
        onToggle={panel.toggleExpanded}
        onPause={() => void controller.pause()}
        onResume={() => void controller.resume()}
        onStop={() => panel.setConfirmation({ kind: 'stop' })}
      />
      {controller.rollbackPending ? (
        <Alert
          severity="error"
          sx={{ mt: 1 }}
          action={
            <Button
              size="small"
              disabled={controller.pendingAction !== null}
              onClick={() => void controller.retryCancellation?.()}
            >
              {planCopy.retryCancellation}
            </Button>
          }
        >
          {planCopy.replanCancelFailed}
        </Alert>
      ) : null}
      {controller.replanPending && !controller.rollbackPending ? (
        <Alert severity="info" sx={{ mt: 1 }}>
          {planCopy.replanReviewNotice}
        </Alert>
      ) : null}
      <Collapse in={panel.expanded} timeout={panel.reduceMotion ? 0 : 'auto'}>
        <PlanRunBody
          controller={controller}
          cwd={cwd}
          onStop={() => panel.setConfirmation({ kind: 'stop' })}
          onRetry={panel.retry}
          onSkip={(stepId) => panel.setConfirmation({ kind: 'skip', stepId })}
        />
        {controller.error && !controller.rollbackPending ? (
          <Alert severity="error" sx={{ mt: 1 }}>
            {controller.error}
          </Alert>
        ) : null}
      </Collapse>
      <ConfirmationDialog
        confirmation={panel.confirmation}
        disabled={Boolean(controller.replanPending)}
        onCancel={() => panel.setConfirmation(null)}
        onConfirm={panel.confirm}
      />
    </Paper>
  )
}

export function SessionPlanRunPanel({
  api,
  sessionId,
  cwd,
  onReplanPrompt
}: {
  api: RendererApi
  sessionId: string | null
  cwd: string
  onReplanPrompt?: OnReplanPrompt
}): React.JSX.Element | null {
  const controller = usePlanRuns(api, sessionId, onReplanPrompt)
  return (
    <PlanRunPanel key={controller.run?.id ?? 'no-plan-run'} controller={controller} cwd={cwd} />
  )
}
