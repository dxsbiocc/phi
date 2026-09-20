import type { WrapperRun } from './wrapperTypes'

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
}

export function isWrapperRunEndState(state: WrapperRun['state']): state is WrapperRunEndState {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}

export function formatWrapperRunDuration(seconds: number): string {
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
      : {})
  }
}

const TITLES: Record<WrapperRunEndState, string> = {
  completed: 'Wrapper 运行已完成',
  failed: 'Wrapper 运行失败',
  cancelled: 'Wrapper 运行已取消'
}

export function wrapperRunNotice(event: WrapperRunFinishedEvent): { title: string; body: string } {
  const lines = [`${event.wrapperId} · 用时 ${formatWrapperRunDuration(event.elapsedSeconds)}`]
  if (event.state === 'failed') {
    lines.push(
      event.missingOutputs && event.missingOutputs.length > 0
        ? `流程已结束但缺少预期输出：${event.missingOutputs.join('、')}`
        : `退出码 ${event.exitCode ?? '未知'}`
    )
  }
  if (event.outDir) lines.push(`输出目录：${event.outDir}`)
  lines.push(`运行编号：${event.wrapperRunId}`)
  if (event.state === 'failed') lines.push('可以让 Wrapper 查看这次运行的日志。')
  return { title: TITLES[event.state], body: lines.join('\n') }
}
