import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  Stack,
  Typography
} from '@mui/material'
import { useEffect, useRef, useState } from 'react'

import type {
  PlanRunState,
  PlanRunTimelineSnapshot,
  PlanRunTimelineStepSnapshot
} from '../../../../../shared/planRunTypes'
import MarkdownContent from '../../../components/MarkdownContent'
import { PhiIcons } from '../../../icons'
import { formatAgentDuration } from '../../../lib/agentRunsOverview'
import { planCopy } from '../lib/planCopy'
import { planStepActions, planStepDurationMs } from '../lib/planRunView'
import { PlanFailureActions } from './PlanFailureActions'

type PlanStepRowProps = {
  run: PlanRunTimelineSnapshot
  step: PlanRunTimelineStepSnapshot
  index: number
  details: PlanRunState | null
  disabled: boolean
  cwd: string
  loadDetails: (runId: string, updatedAt: string) => Promise<PlanRunState | null>
  onRetry: () => void
  onSkip: () => void
  onStop: () => void
}

const PLAN_STEP_ACCORDION_SX = {
  '&:before': { display: 'none' },
  '@media (prefers-reduced-motion: reduce)': {
    '& .MuiCollapse-root': { transitionDuration: '0ms !important' }
  }
} as const

function StepStatusIcon({
  status
}: {
  status: PlanRunTimelineStepSnapshot['status']
}): React.JSX.Element {
  if (status === 'done') return <PhiIcons.state.done size={16} aria-hidden="true" />
  if (status === 'running') return <PhiIcons.state.inProgress size={16} aria-hidden="true" />
  if (status === 'failed') return <PhiIcons.state.blocked size={16} aria-hidden="true" />
  if (status === 'cancelled') return <PhiIcons.action.cancel size={16} aria-hidden="true" />
  if (status === 'skipped') return <PhiIcons.state.abandoned size={16} aria-hidden="true" />
  if (status === 'interrupted') return <PhiIcons.state.warning size={16} aria-hidden="true" />
  return <PhiIcons.state.pending size={16} aria-hidden="true" />
}

function StepHeader({
  step,
  index
}: {
  step: PlanRunTimelineStepSnapshot
  index: number
}): React.JSX.Element {
  const duration = planStepDurationMs(step)
  return (
    <Stack
      direction="row"
      spacing={0.75}
      useFlexGap
      sx={{ alignItems: 'center', flexWrap: 'wrap', width: '100%' }}
    >
      <StepStatusIcon status={step.status} />
      <Typography variant="body2" sx={{ minWidth: 0, flex: 1, fontWeight: 600 }}>
        {index + 1}. {step.title}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {planCopy.stepStatus(step.status)}
      </Typography>
      <Chip
        size="small"
        variant="outlined"
        label={step.access === 'read' ? planCopy.accessRead : planCopy.accessWrite}
      />
      {step.attempts > 1 ? (
        <Typography variant="caption">{planCopy.attempts(step.attempts)}</Typography>
      ) : null}
      {duration !== null ? (
        <Typography variant="caption">{formatAgentDuration(duration)}</Typography>
      ) : null}
    </Stack>
  )
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
  disabled,
  onRetry,
  onSkip,
  onStop
}: Pick<PlanStepRowProps, 'disabled' | 'onRetry' | 'onSkip' | 'onStop'> & {
  visible: boolean
}): React.JSX.Element | null {
  if (!visible) return null
  return (
    <PlanFailureActions disabled={disabled} onRetry={onRetry} onSkip={onSkip} onStop={onStop} />
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
): { expanded: boolean; toggle: (_event: React.SyntheticEvent, next: boolean) => void } {
  // The step that stopped the run opens on its own, so its error and actions are in view;
  // each new problem (another attempt) opens it again even if the user had closed it.
  const blocking = blocksRun(run, step.id)
  const focusKey = blocking ? `${run.pause?.reason}:${step.attempts}` : 'idle'
  const [state, setState] = useState({ key: focusKey, expanded: blocking })
  const expanded = state.key === focusKey ? state.expanded : blocking
  useEffect(() => {
    if (!blocking) return undefined
    // Wait for the opened details to take their height, or the actions stay below the fold.
    const frame = requestAnimationFrame(() =>
      rowRef.current?.scrollIntoView?.({ block: 'nearest' })
    )
    return () => cancelAnimationFrame(frame)
  }, [blocking, focusKey, rowRef])
  useEffect(() => {
    if (expanded && (!details || details.updatedAt < run.updatedAt)) {
      void loadDetails(run.id, run.updatedAt)
    }
  }, [details, expanded, loadDetails, run.id, run.updatedAt])
  return { expanded, toggle: (_event, next) => setState({ key: focusKey, expanded: next }) }
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
  onStop
}: PlanStepRowProps): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const expansion = usePlanStepExpansion(run, step, details, loadDetails, rowRef)
  const actions = planStepActions(run, step.id)
  const loading = expansion.expanded && (!details || details.updatedAt < run.updatedAt)
  return (
    <Accordion
      ref={rowRef}
      disableGutters
      elevation={0}
      expanded={expansion.expanded}
      onChange={expansion.toggle}
      sx={PLAN_STEP_ACCORDION_SX}
    >
      <AccordionSummary
        aria-label={
          expansion.expanded ? planCopy.collapseStep(step.title) : planCopy.expandStep(step.title)
        }
        sx={{ px: 1, minHeight: 42 }}
      >
        <StepHeader step={step} index={index} />
      </AccordionSummary>
      <AccordionDetails sx={{ px: 1, pt: 0, pb: 1 }}>
        <Box sx={{ pl: 3 }}>
          <StepReport step={step} details={details} loading={loading} cwd={cwd} />
        </Box>
        <StepActions
          visible={actions.length > 0}
          disabled={disabled}
          onRetry={onRetry}
          onSkip={onSkip}
          onStop={onStop}
        />
      </AccordionDetails>
    </Accordion>
  )
}
