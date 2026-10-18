import { useUiLanguage } from '../../../lib/i18n'
import { wrapperCopy } from '../lib/wrapperCopy'
import { Button, Stack, Typography } from '@mui/material'

import type {
  WrapperRetargetRequest,
  WrapperRun,
  WrapperRunPlan
} from '../../../../../shared/wrapperTypes'
import { wrapperPlanRetargetRequest, wrapperPlanTargetLines } from '../lib/wrapperView'

export function WrapperPlanTargetSummary({ plan }: { plan: WrapperRunPlan }): React.JSX.Element {
  useUiLanguage()
  const lines = wrapperPlanTargetLines(plan)
  const externalOutput = lines.find((line) => line.startsWith(wrapperCopy.externalOutputPrefix))
  return (
    <Stack spacing={0.25} sx={{ borderLeft: 2, borderColor: 'primary.main', pl: 1.25 }}>
      {lines.slice(0, 3).map((line) => (
        <Typography key={line} variant="caption" sx={{ overflowWrap: 'anywhere' }}>
          {line}
        </Typography>
      ))}
      {externalOutput && (
        <Typography variant="caption" sx={{ color: 'warning.main', overflowWrap: 'anywhere' }}>
          {externalOutput}
        </Typography>
      )}
      {plan.targetSelection?.reason && (
        <Typography variant="caption" color="text.secondary">
          {plan.targetSelection.reason}
        </Typography>
      )}
    </Stack>
  )
}

export function WrapperPlanTargetDetails({
  plan,
  run
}: {
  plan: WrapperRunPlan
  run?: WrapperRun
}): React.JSX.Element {
  useUiLanguage()
  return (
    <>
      {wrapperPlanTargetLines(plan, run)
        .slice(3)
        .map((line) => (
          <Typography
            key={line}
            variant="caption"
            color="text.secondary"
            sx={{ overflowWrap: 'anywhere' }}
          >
            {line}
          </Typography>
        ))}
    </>
  )
}

export function WrapperPlanTargetActions({
  plan,
  busy,
  isUnsubmitted,
  submitBlockReason,
  remoteConfigured = true,
  onRetarget
}: {
  plan: WrapperRunPlan
  busy: boolean
  isUnsubmitted: boolean
  submitBlockReason?: string
  remoteConfigured?: boolean
  onRetarget: (request: WrapperRetargetRequest) => void
}): React.JSX.Element {
  useUiLanguage()
  const localProject = plan.targetSelection?.projectLocation.kind === 'local'
  const hasLocalInputs = plan.inputs.some((input) => input.localPaths.length > 0)
  return (
    <>
      {localProject && plan.targetSelection?.target === 'remote' && isUnsubmitted && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="caption" color="text.secondary">
            {wrapperCopy.localRetargetHelp}
          </Typography>
          <Button
            size="small"
            disabled={busy}
            onClick={() => onRetarget(wrapperPlanRetargetRequest(plan, 'local'))}
          >
            {wrapperCopy.confirmLocalRetarget}
          </Button>
        </Stack>
      )}
      {plan.targetChangeConfirmation && (
        <Typography variant="caption" color="text.secondary">
          {wrapperCopy.localRetargetConfirmed(
            plan.targetChangeConfirmation.fromRevision,
            plan.revision
          )}
        </Typography>
      )}
      {localProject &&
        plan.targetSelection?.target === 'local' &&
        isUnsubmitted &&
        (hasLocalInputs ? (
          <Typography variant="caption" color="text.secondary">
            {wrapperCopy.remoteRetargetInputs}
          </Typography>
        ) : !remoteConfigured ? (
          <Typography variant="caption" color="text.secondary">
            {wrapperCopy.remoteRetargetSetup}
          </Typography>
        ) : (
          <Button
            size="small"
            disabled={busy}
            onClick={() => onRetarget(wrapperPlanRetargetRequest(plan, 'remote'))}
          >
            {wrapperCopy.remoteRetarget}
          </Button>
        ))}
      {submitBlockReason && isUnsubmitted && (
        <Typography variant="caption" sx={{ color: 'warning.main' }}>
          {submitBlockReason}
        </Typography>
      )}
      {plan.targetSelection?.target === 'remote' &&
        plan.targetSelection.environmentCheckPending &&
        isUnsubmitted && (
          <Typography variant="caption" color="text.secondary">
            {wrapperCopy.remoteEnvironmentCheck}
          </Typography>
        )}
    </>
  )
}
