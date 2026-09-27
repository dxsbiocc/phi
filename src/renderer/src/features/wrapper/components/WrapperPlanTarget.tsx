import { Button, Stack, Typography } from '@mui/material'

import type {
  WrapperRetargetRequest,
  WrapperRun,
  WrapperRunPlan
} from '../../../../../shared/wrapperTypes'
import { wrapperPlanRetargetRequest, wrapperPlanTargetLines } from '../lib/wrapperView'

export function WrapperPlanTargetSummary({ plan }: { plan: WrapperRunPlan }): React.JSX.Element {
  const lines = wrapperPlanTargetLines(plan)
  const externalOutput = lines.find((line) => line.startsWith('外部输出授权范围：'))
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
  const localProject = plan.targetSelection?.projectLocation.kind === 'local'
  const hasLocalInputs = plan.inputs.some((input) => input.localPaths.length > 0)
  return (
    <>
      {localProject && plan.targetSelection?.target === 'remote' && isUnsubmitted && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="caption" color="text.secondary">
            改在本机运行会重新检查本机输入，并保存目标变更确认。
          </Typography>
          <Button
            size="small"
            disabled={busy}
            onClick={() => onRetarget(wrapperPlanRetargetRequest(plan, 'local'))}
          >
            确认改在本机运行
          </Button>
        </Stack>
      )}
      {plan.targetChangeConfirmation && (
        <Typography variant="caption" color="text.secondary">
          已确认从远程改为本机 · 计划修订 {plan.targetChangeConfirmation.fromRevision} →{' '}
          {plan.revision}
        </Typography>
      )}
      {localProject &&
        plan.targetSelection?.target === 'local' &&
        isUnsubmitted &&
        (hasLocalInputs ? (
          <Typography variant="caption" color="text.secondary">
            改用远程服务器需重新创建计划，并填写服务器上的输入路径。
          </Typography>
        ) : !remoteConfigured ? (
          <Typography variant="caption" color="text.secondary">
            先选择服务器和工作目录，再改用远程运行。
          </Typography>
        ) : (
          <Button
            size="small"
            disabled={busy}
            onClick={() => onRetarget(wrapperPlanRetargetRequest(plan, 'remote'))}
          >
            改用远程服务器并重新校验计划
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
            运行环境将在远端启动时检查；连接失败不会转到本机。
          </Typography>
        )}
    </>
  )
}
