import { Box, Stack, Typography } from '@mui/material'
import { useEffect, useRef, useState } from 'react'

import type {
  PlanRunState,
  PlanRunTimelineSnapshot,
  PlanRunTimelineStepSnapshot,
  PlanStepStatus
} from '../../../../../shared/planRunTypes'
import MarkdownContent from '../../../components/MarkdownContent'
import { PhiIcons } from '../../../icons'
import { formatAgentDuration } from '../../../lib/agentRunsOverview'
import { planCopy } from '../lib/planCopy'
import { planStepActions, planStepDurationMs } from '../lib/planRunView'
import { PlanAccessMark } from './PlanAccessMark'
import { PlanFailureActions } from './PlanFailureActions'
import { PlanTimelineStep, type PlanTimelineTone } from './PlanTimeline'

type PlanStepRowProps = {
  run: PlanRunTimelineSnapshot
  step: PlanRunTimelineStepSnapshot
  index: number
  details: PlanRunState | null
  disabled: boolean
  cwd: string
  loadDetails: (runId: string, updatedAt: string) => Promise<PlanRunState | null>
  onRetry: (step: PlanRunTimelineStepSnapshot) => void
  onSkip: () => void
  onReplan?: () => void
  onStop: () => void
  isLast?: boolean
}

function stepTone(status: PlanStepStatus): PlanTimelineTone {
  if (status === 'done') return 'success'
  if (status === 'running' || status === 'launching') return 'active'
  if (status === 'interrupted') return 'warning'
  if (status === 'failed' || status === 'unknown') return 'error'
  if (status === 'cancelled' || status === 'skipped') return 'neutral'
  return 'pending'
}

function StepHeader({ step }: { step: PlanRunTimelineStepSnapshot }): React.JSX.Element {
  const duration = planStepDurationMs(step)
  const durationLabel = duration !== null ? formatAgentDuration(duration) : ''
  const attemptsLabel = step.attempts > 1 ? planCopy.attempts(step.attempts) : ''
  return (
    <Stack
      direction="row"
      sx={{ alignItems: 'center', flex: 'none', gap: 1, position: 'relative' }}
    >
      {attemptsLabel ? (
        <Typography
          variant="caption"
          sx={{ position: 'absolute', right: '100%', mr: 1, whiteSpace: 'nowrap' }}
        >
          {attemptsLabel}
        </Typography>
      ) : null}
      <Typography
        variant="caption"
        component="span"
        sx={{
          display: 'block',
          // A minimum keeps short durations aligned; longer ones ("4 分钟 20 秒") grow leftwards
          // instead of overflowing onto the expand toggle.
          minWidth: '4.75em',
          flex: 'none',
          textAlign: 'right',
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
          color: 'text.secondary'
        }}
      >
        {durationLabel}
      </Typography>
    </Stack>
  )
}

function stepMarker(status: PlanStepStatus): React.JSX.Element | undefined {
  const icon =
    status === 'failed'
      ? PhiIcons.state.failed
      : status === 'launching'
        ? PhiIcons.state.launching
        : status === 'skipped'
          ? PhiIcons.state.skipped
          : status === 'cancelled'
            ? PhiIcons.state.cancelled
            : status === 'unknown'
              ? PhiIcons.state.unverified
              : undefined
  if (!icon) return undefined
  const Icon = icon
  return <Icon size={14} aria-hidden />
}

function StepReport({
  step,
  details,
  loading,
  cwd
}: {
  step: PlanRunTimelineStepSnapshot
  details: PlanRunState | null
  loading: boolean
  cwd: string
}): React.JSX.Element {
  const full = details?.steps[step.id]
  const report = full?.report?.text
  const error = full?.error ?? step.error
  if (step.status === 'unknown') {
    return (
      <Typography variant="body2" color="warning.main">
        {planCopy.unknownStepExplanation}
      </Typography>
    )
  }
  if (loading) return <Typography variant="body2">{planCopy.loading}</Typography>
  if (report) return <MarkdownContent text={report} cwd={cwd} />
  if (error)
    return (
      <Typography variant="body2" color="error.main" sx={{ whiteSpace: 'pre-wrap' }}>
        {error}
      </Typography>
    )
  return (
    <Typography variant="body2" color="text.secondary">
      {planCopy.report}: —
    </Typography>
  )
}

function StepActions({
  visible,
  reason,
  disabled,
  onRetry,
  onSkip,
  onReplan,
  onStop
}: Omit<
  Pick<PlanStepRowProps, 'disabled' | 'onRetry' | 'onSkip' | 'onReplan' | 'onStop'>,
  'onRetry'
> & {
  visible: boolean
  reason: NonNullable<PlanRunTimelineSnapshot['pause']>['reason']
  onRetry: () => void
}): React.JSX.Element | null {
  if (!visible) return null
  return (
    <PlanFailureActions
      disabled={disabled}
      reason={reason}
      onRetry={onRetry}
      onSkip={onSkip}
      onReplan={onReplan}
      onStop={onStop}
    />
  )
}

/** The step a run is paused on (failed, needs input, interrupted), not a user pause. */
function blocksRun(run: PlanRunTimelineSnapshot, stepId: string): boolean {
  return run.pause !== undefined && run.pause.reason !== 'user' && run.pause.stepId === stepId
}

function usePlanStepExpansion(
  run: PlanRunTimelineSnapshot,
  step: PlanRunTimelineStepSnapshot,
  details: PlanRunState | null,
  loadDetails: PlanStepRowProps['loadDetails'],
  rowRef: React.RefObject<HTMLDivElement | null>
): {
  expanded: boolean
  loading: boolean
  toggle: (_event: React.SyntheticEvent, next: boolean) => void
} {
  // The step that stopped the run opens on its own, so its error and actions are in view;
  // each new problem (another attempt) opens it again even if the user had closed it.
  const blocking = blocksRun(run, step.id)
  const focusKey = blocking ? `${run.pause?.reason}:${step.attempts}` : 'idle'
  const [state, setState] = useState({ key: focusKey, expanded: blocking })
  const expanded = state.key === focusKey ? state.expanded : blocking
  const requestKey = `${run.id}:${run.updatedAt}`
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const hasCurrentDetails = details !== null && details.updatedAt >= run.updatedAt
  useEffect(() => {
    if (!blocking) return undefined
    // Wait for the opened details to take their height, or the actions stay below the fold.
    const frame = requestAnimationFrame(() =>
      rowRef.current?.scrollIntoView?.({ block: 'nearest' })
    )
    return () => cancelAnimationFrame(frame)
  }, [blocking, focusKey, rowRef])
  useEffect(() => {
    if (!expanded || step.status === 'unknown' || hasCurrentDetails) return undefined
    let active = true
    void loadDetails(run.id, run.updatedAt).finally(() => {
      if (active) setSettledKey(requestKey)
    })
    return () => {
      active = false
    }
  }, [expanded, hasCurrentDetails, loadDetails, requestKey, run.id, run.updatedAt, step.status])
  const loading = expanded && !hasCurrentDetails && settledKey !== requestKey
  return {
    expanded,
    loading,
    toggle: (_event, next) => setState({ key: focusKey, expanded: next })
  }
}

export function PlanStepRow({
  run,
  step,
  index,
  details,
  disabled,
  cwd,
  loadDetails,
  onRetry,
  onSkip,
  onReplan,
  onStop,
  isLast = false
}: PlanStepRowProps): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const expansion = usePlanStepExpansion(run, step, details, loadDetails, rowRef)
  const actions = planStepActions(run, step.id)
  const tone = stepTone(step.status)
  return (
    <Box ref={rowRef}>
      <PlanTimelineStep
        isLast={isLast}
        tone={tone}
        index={index}
        dimmed={tone === 'pending'}
        icon={stepMarker(step.status)}
        iconLabel={planCopy.stepStatus(step.status)}
        mark={step.status}
        title={`${index + 1}. ${step.title}`}
        titleEnd={<PlanAccessMark access={step.access} />}
        meta={<StepHeader step={step} />}
        expanded={expansion.expanded}
        toggleLabel={
          expansion.expanded ? planCopy.collapseStep(step.title) : planCopy.expandStep(step.title)
        }
        onToggle={() => expansion.toggle({} as React.SyntheticEvent, !expansion.expanded)}
      >
        <Box
          sx={{
            minWidth: 0,
            maxWidth: '100%',
            maxHeight: 'min(36vh, 320px)',
            overflow: 'auto'
          }}
        >
          <StepReport step={step} details={details} loading={expansion.loading} cwd={cwd} />
        </Box>
        <StepActions
          visible={actions.length > 0}
          reason={run.pause?.reason ?? 'step_failed'}
          disabled={disabled}
          onRetry={() => onRetry(step)}
          onSkip={onSkip}
          onReplan={onReplan}
          onStop={onStop}
        />
      </PlanTimelineStep>
    </Box>
  )
}
