import {
  Box,
  Collapse,
  Paper,
  Alert,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Button,
  useMediaQuery
} from '@mui/material'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

import {
  PLAN_MAX_REPLANS,
  type PlanRunState,
  type PlanRunTimelineSnapshot,
  type PlanRunTimelineStepSnapshot
} from '../../../../shared/planRunTypes'
import { LabeledIconButton } from '../../components/LabeledIconButton'
import { PhiIcons } from '../../icons'
import { useUiLanguage } from '../../lib/i18n'
import type { RendererApi } from '../../types'
import { usePlanRuns, type OnReplanPrompt, type PlanRunsController } from './hooks/usePlanRuns'
import { planCopy } from './lib/planCopy'
import { stopPlan } from './lib/stopPlan'
import { planRunProgress, planStepRetryNeedsConfirmation } from './lib/planRunView'
import { PlanRunControls } from './components/PlanRunControls'
import { PlanStepRow } from './components/PlanStepRow'
import { PlanTimelineHeader, type PlanTimelineTone } from './components/PlanTimeline'

type Confirmation =
  { kind: 'stop' } | { kind: 'skip'; stepId: string } | { kind: 'retry'; stepId: string }
type PlanRunPanelProps = {
  controller: PlanRunsController
  cwd?: string
  archived?: boolean
  /** Ends the conversation turn that is drafting a replan, so stopping the plan stops it too. */
  onStopTurn?: () => Promise<void>
}
type PlanPanelState = {
  reduceMotion: boolean
  expanded: boolean
  toggleExpanded: () => void
  confirmation: Confirmation | null
  setConfirmation: React.Dispatch<React.SetStateAction<Confirmation | null>>
  confirm: () => void
  retry: (step: PlanRunTimelineStepSnapshot) => void
}

function runTone(run: PlanRunTimelineSnapshot): PlanTimelineTone {
  if (run.status === 'completed') return 'success'
  if (run.steps.some((step) => step.status === 'running' || step.status === 'launching')) {
    return 'active'
  }
  if (run.pause && run.pause.reason !== 'user') return 'error'
  return 'neutral'
}

/** Stopped and user-paused runs say so with their own symbol, not a generic one. */
function runIcon(run: PlanRunTimelineSnapshot): React.JSX.Element | undefined {
  if (run.status === 'stopped') return <PhiIcons.action.stop size={13} aria-hidden />
  if (run.status === 'paused' && run.pause?.reason === 'user') {
    return <PhiIcons.state.interrupted size={14} aria-hidden />
  }
  return undefined
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
  const controlsHidden =
    replanPending ||
    run.steps.some((step) => step.status === 'unknown' || step.status === 'launching')
  return (
    <PlanTimelineHeader
      tone={runTone(run)}
      icon={runIcon(run)}
      title={run.goal}
      subtitle={`${planCopy.progress(progress.completed, progress.total)} · ${planCopy.runStatus(run.status)}`}
      expanded={expanded}
      expandLabel={expanded ? planCopy.collapseSummary : planCopy.expandSummary}
      onToggle={onToggle}
      trailing={
        controlsHidden ? null : (
          <PlanRunControls
            run={run}
            disabled={disabled}
            onPause={onPause}
            onResume={onResume}
            onStop={onStop}
          />
        )
      }
    />
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
        <Button size="small" variant="text" onClick={onCancel} aria-label={planCopy.cancel}>
          {planCopy.cancel}
        </Button>
        <Button
          size="small"
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
  contained,
  onStop,
  onRetry,
  onSkip
}: {
  controller: PlanRunsController
  cwd: string
  contained: boolean
  onStop: () => void
  onRetry: (step: PlanRunTimelineStepSnapshot) => void
  onSkip: (stepId: string) => void
}): React.JSX.Element | null {
  const run = controller.run
  if (!run) return null
  const replanning = Boolean(controller.replanPending)
  return (
    <Box
      sx={{
        minWidth: 0,
        px: 2,
        py: 1.75,
        // Live panel above the composer stays bounded. A finished record in the
        // transcript does not: each expanded step scrolls inside itself.
        ...(contained
          ? {
              maxHeight: 'min(42vh, 420px)',
              overflowY: 'auto',
              scrollbarGutter: 'stable'
            }
          : null)
      }}
    >
      <Box>
        {run.steps.map((step, index) => (
          <PlanStepRow
            key={step.id}
            run={run}
            step={step}
            index={index}
            isLast={index === run.steps.length - 1}
            details={controller.details}
            disabled={controller.pendingAction !== null || replanning}
            stopDisabled={
              controller.pendingAction !== null &&
              !(replanning && controller.pendingAction.startsWith('replan:'))
            }
            cwd={cwd}
            loadDetails={controller.loadDetails}
            onRetry={onRetry}
            onSkip={() => onSkip(step.id)}
            onReplan={
              run.replans < PLAN_MAX_REPLANS &&
              !run.steps.some((candidate) =>
                ['running', 'launching', 'unknown'].includes(candidate.status)
              ) &&
              !controller.rollbackPending &&
              !controller.replanPending &&
              controller.replan
                ? () => void controller.replan?.()
                : undefined
            }
            onStop={onStop}
          />
        ))}
      </Box>
    </Box>
  )
}

function usePlanPanelState(
  run: PlanRunTimelineSnapshot | null,
  controller: PlanRunsController,
  archived: boolean,
  onStopTurn?: () => Promise<void>
): PlanPanelState {
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const expansionKey = run ? `${run.id}:${run.status}` : 'none'
  const defaultExpanded =
    archived || run?.status === 'running' || run?.status === 'paused' || run?.status === 'completed'
  const [expansion, setExpansion] = useState({ key: expansionKey, expanded: defaultExpanded })
  const expanded = expansion.key === expansionKey ? expansion.expanded : defaultExpanded
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const confirm = (): void => {
    if (confirmation?.kind === 'stop') {
      setConfirmation(null)
      void stopPlan(controller, onStopTurn)
      return
    }
    if (controller.replanPending || run?.steps.some((step) => step.status === 'unknown')) {
      setConfirmation(null)
      return
    }
    if (confirmation?.kind === 'skip') void controller.skipStep(confirmation.stepId)
    if (confirmation?.kind === 'retry') void controller.retryStep(confirmation.stepId)
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
  cwd = '',
  archived = false,
  onStopTurn
}: PlanRunPanelProps): React.JSX.Element | null {
  useUiLanguage()
  const run = controller.run
  const panel = usePlanPanelState(run, controller, archived, onStopTurn)
  if (!run || (!archived && (run.status === 'completed' || run.status === 'stopped'))) return null
  const hasUnknown = run.steps.some((step) => step.status === 'unknown')
  return (
    <Paper
      variant="outlined"
      aria-label={run.goal}
      sx={{ width: '100%', mb: 1, borderRadius: 2, minWidth: 0, overflow: 'hidden' }}
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
          sx={{ mx: 2, mt: 1 }}
          action={
            <LabeledIconButton
              label={planCopy.retryCancellation}
              size="small"
              disabled={controller.pendingAction !== null}
              onClick={() => void controller.retryCancellation?.()}
            >
              <PhiIcons.action.refresh size={16} aria-hidden />
            </LabeledIconButton>
          }
        >
          {planCopy.replanCancelFailed}
        </Alert>
      ) : null}
      <Collapse in={panel.expanded} timeout={panel.reduceMotion ? 0 : 'auto'}>
        <PlanRunBody
          controller={controller}
          cwd={cwd}
          contained={!archived}
          onStop={() => panel.setConfirmation({ kind: 'stop' })}
          onRetry={panel.retry}
          onSkip={(stepId) => panel.setConfirmation({ kind: 'skip', stepId })}
        />
        {controller.error && !controller.rollbackPending ? (
          <Alert severity="error" sx={{ mx: 2, mb: 1 }}>
            {controller.error}
          </Alert>
        ) : null}
      </Collapse>
      <ConfirmationDialog
        confirmation={panel.confirmation}
        disabled={
          panel.confirmation?.kind !== 'stop' && (hasUnknown || Boolean(controller.replanPending))
        }
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
  onReplanPrompt,
  onStopTurn
}: {
  api: RendererApi
  sessionId: string | null
  cwd: string
  onReplanPrompt?: OnReplanPrompt
  onStopTurn?: () => Promise<void>
}): React.JSX.Element | null {
  const controller = usePlanRuns(api, sessionId, onReplanPrompt)
  return (
    <PlanRunPanel
      key={controller.run?.id ?? 'no-plan-run'}
      controller={controller}
      cwd={cwd}
      onStopTurn={onStopTurn}
    />
  )
}

function archivedController(run: PlanRunTimelineSnapshot): PlanRunsController {
  return {
    run,
    details: null,
    loading: false,
    pendingAction: null,
    error: null,
    loadDetails: async () => null,
    pause: async () => undefined,
    resume: async () => undefined,
    stop: async () => undefined,
    retryStep: async () => undefined,
    skipStep: async () => undefined
  }
}

/** The execution timeline kept in the conversation after the live panel closes. */
export function PlanRunRecord({
  run,
  cwd = '',
  loadRun
}: {
  run: PlanRunTimelineSnapshot
  cwd?: string
  loadRun?: (runId: string) => Promise<PlanRunState | null>
}): React.JSX.Element {
  const loadRunRef = useRef(loadRun)
  useLayoutEffect(() => {
    loadRunRef.current = loadRun
  }, [loadRun])
  const [details, setDetails] = useState<PlanRunState | null>(null)
  const loadDetails = useCallback(async (runId: string, updatedAt: string) => {
    const load = loadRunRef.current
    if (!load) return null
    const state = await load(runId)
    if (!state || state.id !== runId || state.updatedAt < updatedAt) return null
    setDetails(state)
    return state
  }, [])
  const controller = useMemo(() => {
    const archived = archivedController(run)
    return { ...archived, details, loadDetails }
  }, [details, loadDetails, run])
  return <PlanRunPanel controller={controller} cwd={cwd} archived />
}
