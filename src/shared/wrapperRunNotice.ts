import type { UiLanguage } from './uiLanguage'
import type { WrapperRun } from './wrapperTypes'
import { isResearchQcGated, type WrapperResearchQc } from './wrapperResearchQcTypes'

/**
 * The timeline event and the wording used when a background wrapper run ends.
 * Shared so the chat (renderer) and the OS notification (main) say the same
 * thing. `wrapperRunId` is deliberately not `runId`: session events already
 * use `runId` for the chat prompt run.
 */

export type WrapperRunEndState = 'completed' | 'failed' | 'cancelled'

export interface WrapperRunFinishedEvent {
  type: 'wrapper_run_finished'
  wrapperRunId: string
  wrapperId: string
  state: WrapperRunEndState
  exitCode?: number
  outDir: string
  elapsedSeconds: number
  missingOutputs?: string[]
  /** Host-verified research QC verdict, when the run was QC-gated and verified locally. */
  researchQc?: WrapperResearchQc
  /** Set when the wrapper declared research QC, even if no local verification happened. */
  researchQcExpected?: true
}

export function isWrapperRunEndState(state: WrapperRun['state']): state is WrapperRunEndState {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}

export function formatWrapperRunDuration(seconds: number, language: UiLanguage = 'zh-CN'): string {
  if (language === 'en') {
    if (seconds < 60) return `${seconds} s`
    const minutes = Math.floor(seconds / 60)
    return minutes < 60
      ? `${minutes} min ${seconds % 60} s`
      : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
  }
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

/** `run.state` must already be an end state (see {@link isWrapperRunEndState}). */
export function buildWrapperRunFinishedEvent(
  run: WrapperRun,
  status: { elapsedSeconds: number; missingOutputs?: string[] }
): WrapperRunFinishedEvent {
  return {
    type: 'wrapper_run_finished',
    wrapperRunId: run.runId,
    wrapperId: run.wrapper.canonicalId,
    state: run.state as WrapperRunEndState,
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    outDir: run.outDir,
    elapsedSeconds: status.elapsedSeconds,
    ...(status.missingOutputs && status.missingOutputs.length > 0
      ? { missingOutputs: status.missingOutputs }
      : {}),
    ...(run.researchQc ? { researchQc: run.researchQc } : {}),
    ...(run.researchQcExpected ? { researchQcExpected: true } : {})
  }
}

const TITLES: Record<WrapperRunEndState, string> = {
  completed: 'Wrapper 运行已完成',
  failed: 'Wrapper 运行失败',
  cancelled: 'Wrapper 运行已取消'
}

/** One compact QC line for the user; fixed wording, never raw file content. */
function researchQcNoticeLine(
  event: WrapperRunFinishedEvent,
  language: UiLanguage
): string | undefined {
  const qc = event.researchQc
  if (qc) {
    if (qc.disposition === 'needs_input') {
      const options = qc.question.options
        .map((option) => `- ${option.label}: ${option.description}`)
        .join('\n')
      return language === 'en'
        ? `Input needed before analysis: ${qc.question.question}\n${options}`
        : `分析前需要您确认：${qc.question.question}\n${options}`
    }
    if (qc.disposition === 'invalid') {
      return language === 'en'
        ? 'Research QC invalid: results failed verification and must not be used.'
        : '科研 QC 无效：结果未通过校验，不得使用。'
    }
    if (language === 'en') {
      return qc.disposition === 'eligible'
        ? `Research QC eligible: ${qc.hits}/${qc.evaluated} genes passed.`
        : `Research QC skip: 0/${qc.evaluated} genes passed the thresholds.`
    }
    return qc.disposition === 'eligible'
      ? `科研 QC 合格：${qc.hits}/${qc.evaluated} 个基因通过阈值。`
      : `科研 QC 跳过：0/${qc.evaluated} 个基因通过阈值。`
  }
  if (event.researchQcExpected) {
    return language === 'en'
      ? 'Research QC was declared but not verified by Phi; do not treat these results as verified.'
      : '科研 QC 未经 Phi 校验，请勿将本次结果视为已验证。'
  }
  return undefined
}

export function wrapperRunNotice(
  event: WrapperRunFinishedEvent,
  language: UiLanguage = 'zh-CN'
): { title: string; body: string } {
  if (language === 'en') {
    const titles = {
      completed: 'Wrapper run completed',
      failed: 'Wrapper run failed',
      cancelled: 'Wrapper run cancelled'
    }
    const lines = [
      `${event.wrapperId} · Elapsed ${formatWrapperRunDuration(event.elapsedSeconds, language)}`
    ]
    if (event.state === 'failed' && event.researchQc?.disposition !== 'needs_input')
      lines.push(
        event.missingOutputs?.length
          ? `The workflow finished but expected outputs are missing: ${event.missingOutputs.join(', ')}`
          : `Exit code ${event.exitCode ?? 'Unknown'}`
      )
    const qcLine = researchQcNoticeLine(event, language)
    if (qcLine) lines.push(qcLine)
    if (event.outDir) lines.push(`Output directory: ${event.outDir}`)
    lines.push(`Run ID: ${event.wrapperRunId}`)
    if (event.state === 'failed' && !isResearchQcGated(event))
      lines.push('Ask Wrapper to inspect the logs for this run.')
    return { title: titles[event.state], body: lines.join('\n') }
  }
  const lines = [`${event.wrapperId} · 用时 ${formatWrapperRunDuration(event.elapsedSeconds)}`]
  if (event.state === 'failed' && event.researchQc?.disposition !== 'needs_input') {
    lines.push(
      event.missingOutputs && event.missingOutputs.length > 0
        ? `流程已结束但缺少预期输出：${event.missingOutputs.join('、')}`
        : `退出码 ${event.exitCode ?? '未知'}`
    )
  }
  const qcLine = researchQcNoticeLine(event, language)
  if (qcLine) lines.push(qcLine)
  if (event.outDir) lines.push(`输出目录：${event.outDir}`)
  lines.push(`运行编号：${event.wrapperRunId}`)
  if (event.state === 'failed' && !isResearchQcGated(event))
    lines.push('可以让 Wrapper 查看这次运行的日志。')
  return { title: TITLES[event.state], body: lines.join('\n') }
}
