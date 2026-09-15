import { Box, Button, CircularProgress, Collapse, Paper, Stack, Typography } from '@mui/material'
import { memo, useEffect, useState } from 'react'
import type { WrapperPlanItem } from '../../../types'
import type { WrapperRun, WrapperRunPlan } from '../../../../../shared/wrapperTypes'
import { PhiIcons } from '../../../icons'
import { buildWrapperFlowGraph } from '../lib/wrapperFlow'
import { parseSamplesheetCsv } from '../lib/wrapperSamplesheet'
import { resolveWrapperCancelTarget, runStateLabel, trustTierLabel } from '../lib/wrapperView'
import { WrapperFlowDiagram } from './WrapperFlowDiagram'

const DoneIcon = PhiIcons.state.done
const DeniedIcon = PhiIcons.state.denied

const RUN_POLL_INTERVAL_MS = 2000
const TERMINAL_RUN_STATES: WrapperRun['state'][] = ['completed', 'failed', 'cancelled', 'lost']

function planStateLabel(state: WrapperRunPlan['state']): string {
  const labels: Record<WrapperRunPlan['state'], string> = {
    draft: '草稿',
    validating: '校验中',
    valid: '可提交',
    invalid: '有问题',
    expired: '已过期',
    submitted: '已提交',
    cancelled: '已取消'
  }
  return labels[state] ?? state
}

/** Small inline status marker — mirrors ToolCallCard's StatusIndicator instead of a colored badge chip. */
function StatusMark({
  tone
}: {
  tone: 'pending' | 'active' | 'positive' | 'negative'
}): React.JSX.Element {
  if (tone === 'active') {
    return <CircularProgress size={13} thickness={5} sx={{ color: 'text.secondary' }} aria-hidden />
  }
  if (tone === 'negative') {
    return <DeniedIcon sx={{ fontSize: 15 }} color="error" aria-hidden />
  }
  if (tone === 'positive') {
    return <DoneIcon sx={{ fontSize: 15, color: 'success.main' }} aria-hidden />
  }
  return <Box sx={{ width: 15 }} aria-hidden />
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const SAMPLESHEET_PREVIEW_ROWS = 5

/** Compact preview table for a generated samplesheet artifact — plain borders, no MUI Table. */
function SamplesheetPreview({ inputId, csv }: { inputId: string; csv: string }): React.JSX.Element {
  const { header, rows } = parseSamplesheetCsv(csv)
  const visibleRows = rows.slice(0, SAMPLESHEET_PREVIEW_ROWS)
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {inputId} 生成的 samplesheet（{rows.length} 行）
      </Typography>
      <Box
        component="table"
        sx={{
          mt: 0.5,
          width: '100%',
          borderCollapse: 'collapse',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.75rem'
        }}
      >
        <Box component="thead">
          <Box component="tr">
            {header.map((column, index) => (
              <Box
                component="th"
                key={`${column}-${index}`}
                sx={{
                  textAlign: 'left',
                  color: 'text.secondary',
                  fontWeight: 600,
                  borderBottom: 1,
                  borderColor: 'divider',
                  px: 0.75,
                  py: 0.5
                }}
              >
                {column}
              </Box>
            ))}
          </Box>
        </Box>
        <Box component="tbody">
          {visibleRows.map((row, rowIndex) => (
            <Box component="tr" key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <Box
                  component="td"
                  key={cellIndex}
                  sx={{
                    borderBottom: 1,
                    borderColor: 'divider',
                    px: 0.75,
                    py: 0.5,
                    overflowWrap: 'anywhere'
                  }}
                >
                  {cell}
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
      {rows.length > visibleRows.length && (
        <Typography variant="caption" color="text.secondary">
          还有 {rows.length - visibleRows.length} 行未显示
        </Typography>
      )}
    </Box>
  )
}

/**
 * Chat timeline card for a `wrapper.<id>` tool call — see
 * docs/design/phi-wrapper-technical-design.md, "Chat And UI Integration".
 * Styled after ToolApprovalDialog.tsx (an outlined Paper, plain info text
 * joined with " · " instead of chip badges, a small status icon instead of
 * a colored pill) rather than a generic dashboard card, since this is the
 * app's own established language for an in-chat action request. Not built
 * on the tool-approval pending-action plumbing, though: Validate/Submit/
 * Cancel are plain IPC calls against the durable plan store, independent of
 * whether the agent session that created this plan is still running.
 */
function WrapperPlanCardImpl({ item }: { item: WrapperPlanItem }): React.JSX.Element {
  const [loadState, setLoadState] = useState<{ plan?: WrapperRunPlan; error?: string }>({})
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [heavyWorkloadAcknowledged, setHeavyWorkloadAcknowledged] = useState(false)

  useEffect(() => {
    if (!item.planId) return
    let cancelled = false
    window.api
      .getWrapperPlan(item.planId)
      .then((result) => {
        if (!cancelled) setLoadState({ plan: result })
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadState({ error: errorMessage(error) })
      })
    return (): void => {
      cancelled = true
    }
  }, [item.planId])

  const plan = loadState.plan
  const setPlan = (next: WrapperRunPlan | undefined): void => setLoadState({ plan: next })

  const [samplesheets, setSamplesheets] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!plan) return
    let cancelled = false
    Promise.all(
      plan.inputs.map(async (input) => {
        const fileName = `${input.id}.samplesheet.csv`
        const content = await window.api.getWrapperPlanArtifact(plan.planId, fileName)
        return [input.id, content] as const
      })
    )
      .then((results) => {
        if (cancelled) return
        const next: Record<string, string> = {}
        for (const [inputId, content] of results) {
          if (content) next[inputId] = content
        }
        setSamplesheets(next)
      })
      .catch(() => {
        if (!cancelled) setSamplesheets({})
      })
    return (): void => {
      cancelled = true
    }
  }, [plan])

  const [run, setRun] = useState<WrapperRun | undefined>(undefined)

  useEffect(() => {
    const runId = plan?.submittedRunId
    if (!runId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = (): void => {
      window.api
        .getWrapperRun(runId)
        .then((latest) => {
          if (cancelled) return
          setRun(latest)
          if (latest && !TERMINAL_RUN_STATES.includes(latest.state)) {
            timer = setTimeout(poll, RUN_POLL_INTERVAL_MS)
          }
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(poll, RUN_POLL_INTERVAL_MS)
        })
    }
    poll()

    return (): void => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [plan?.submittedRunId])

  if (item.status === 'running' && !item.planId) {
    return (
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', color: 'text.secondary', py: 0.5 }}
      >
        <StatusMark tone="active" />
        <Typography variant="body2">正在准备 wrapper 计划…</Typography>
      </Stack>
    )
  }

  if (item.status === 'error') {
    return (
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', color: 'error.main', py: 0.5 }}
      >
        <StatusMark tone="negative" />
        <Typography variant="body2">wrapper 计划创建失败</Typography>
      </Stack>
    )
  }

  if (loadState.error) {
    return (
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', color: 'error.main', py: 0.5 }}
      >
        <StatusMark tone="negative" />
        <Typography variant="body2">{loadState.error}</Typography>
      </Stack>
    )
  }

  if (!item.planId || !plan) {
    return (
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', color: 'text.secondary', py: 0.5 }}
      >
        <StatusMark tone="active" />
        <Typography variant="body2">正在加载计划…</Typography>
      </Stack>
    )
  }

  const graph = buildWrapperFlowGraph(
    { name: plan.wrapperName, steps: plan.steps },
    run?.stepStates
  )
  const isUnsubmitted = plan.state === 'valid' || plan.state === 'invalid' || plan.state === 'draft'
  const canSubmit =
    plan.state === 'valid' &&
    !busy &&
    (!plan.requiresHeavyWorkloadAcknowledgement || heavyWorkloadAcknowledged)
  const cancelTarget = resolveWrapperCancelTarget(plan, run)
  const canCancel = !!cancelTarget && !busy
  const planStatusTone: 'pending' | 'positive' | 'negative' =
    plan.state === 'valid' ? 'positive' : plan.state === 'invalid' ? 'negative' : 'pending'

  async function runAction(action: () => Promise<WrapperRunPlan | void>): Promise<void> {
    setBusy(true)
    setActionError(undefined)
    try {
      const result = await action()
      if (result) setPlan(result)
      else if (item.planId) setPlan(await window.api.getWrapperPlan(item.planId))
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Cancelling once a run exists is a run-cancel, not a plan-cancel — see
   * `resolveWrapperCancelTarget`'s doc comment for the bug this fixes.
   * Updates `run` directly instead of going through `runAction`'s plan
   * re-fetch: `cancelWrapperRun` returns a `WrapperRun`, and the plan's own
   * `state` doesn't change just because its run got cancelled.
   */
  async function cancelRun(runId: string): Promise<void> {
    setBusy(true)
    setActionError(undefined)
    try {
      setRun(await window.api.cancelWrapperRun(runId))
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const infoLine = [
    plan.wrapperName,
    `v${plan.wrapper.version}`,
    trustTierLabel(plan.trustTier),
    planStateLabel(plan.state)
  ].join(' · ')

  return (
    <Paper variant="outlined" sx={{ width: '100%', p: 2, borderRadius: 1.5 }}>
      <Stack spacing={1.25}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {/* Canonical id leads, not the manifest's own (author-chosen, never
                self-certifying) display name — this is the actual "are you
                sure you know what you're about to run" moment. See
                WrapperView.tsx's sidebar row for the same reasoning. */}
            <Typography
              variant="subtitle1"
              sx={{ fontWeight: 700, fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}
            >
              {plan.wrapper.canonicalId}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {infoLine}
            </Typography>
          </Box>
          <StatusMark tone={planStatusTone} />
        </Stack>

        <WrapperFlowDiagram graph={graph} height={130} />

        {plan.validation.errors.length > 0 && (
          <Typography
            variant="body2"
            sx={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8rem',
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              color: 'error.main',
              bgcolor: 'action.hover',
              borderRadius: 1,
              p: 1.25
            }}
          >
            {plan.validation.errors.join('\n')}
          </Typography>
        )}

        {plan.requiresHeavyWorkloadAcknowledgement && isUnsubmitted && (
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', color: 'warning.main', flexWrap: 'wrap', rowGap: 0.5 }}
          >
            <Typography variant="caption" sx={{ color: 'inherit' }}>
              重量级任务 · Phase 1 暂无远程执行环境，确认后将在本机运行
            </Typography>
            <Button size="small" onClick={() => setHeavyWorkloadAcknowledged((prev) => !prev)}>
              {heavyWorkloadAcknowledged ? '已确认' : '确认在本地运行'}
            </Button>
          </Stack>
        )}

        {plan.state === 'submitted' && plan.submittedRunId && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'text.secondary' }}>
            <StatusMark
              tone={
                !run
                  ? 'active'
                  : run.state === 'completed'
                    ? 'positive'
                    : run.state === 'failed' || run.state === 'lost'
                      ? 'negative'
                      : 'active'
              }
            />
            <Typography variant="caption">
              {plan.submittedRunId}
              {run ? ` · ${runStateLabel(run.state)}` : ''}
            </Typography>
          </Stack>
        )}

        <Collapse in={expanded}>
          <Stack spacing={0.5} sx={{ pt: 0.5, borderTop: 1, borderColor: 'divider', mt: 0.5 }}>
            {plan.inputs.length > 0 && (
              <Typography variant="caption" color="text.secondary">
                输入：
                {plan.inputs
                  .map((input) => `${input.id}（${input.localPaths.length} 个文件）`)
                  .join('，')}
              </Typography>
            )}
            {Object.entries(samplesheets).map(([inputId, csv]) => (
              <SamplesheetPreview key={inputId} inputId={inputId} csv={csv} />
            ))}
            <Typography variant="caption" color="text.secondary">
              输出目录：{plan.outputDir}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              资源：{plan.resources.cpus ?? '-'} CPU · {plan.resources.memory ?? '-'}
            </Typography>
            <Typography
              variant="caption"
              sx={{
                fontFamily: 'var(--font-mono)',
                bgcolor: 'action.hover',
                borderRadius: 1,
                p: 1,
                mt: 0.5
              }}
            >
              {plan.commandPlan.command}
            </Typography>
          </Stack>
        </Collapse>

        {actionError && (
          <Typography variant="caption" sx={{ color: 'error.main' }}>
            {actionError}
          </Typography>
        )}

        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Button size="small" onClick={() => setExpanded((prev) => !prev)}>
            {expanded ? '收起详情' : '展开详情'}
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button
            size="small"
            color="error"
            disabled={!canCancel}
            onClick={() => {
              if (!cancelTarget) return
              if (cancelTarget.kind === 'run') {
                void cancelRun(cancelTarget.runId)
                return
              }
              void runAction(() => window.api.cancelWrapperRunPlan(cancelTarget.planId))
            }}
          >
            取消
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={!canSubmit}
            onClick={() =>
              void runAction(async () => {
                if (!item.planId) return
                await window.api.submitWrapperPlan(
                  item.planId,
                  heavyWorkloadAcknowledged || undefined
                )
              })
            }
          >
            提交运行
          </Button>
        </Stack>
      </Stack>
    </Paper>
  )
}

export const WrapperPlanCard = memo(WrapperPlanCardImpl)
