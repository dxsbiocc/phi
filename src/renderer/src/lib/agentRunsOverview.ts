import type { AgentExecutionItem } from './agentExecutionTypes'
import { agentRunControlTarget, type AgentRunControlTarget } from './agentExecutionControl'
import type { RenderGroup } from './chatRenderGroups'
import type { ChatItem } from '../types'

/**
 * The overview of the agents that are running right now, shown over the chat.
 * Everything here is derived from the conversation's items, so it survives
 * switching conversations and reloads the same way the cards themselves do.
 */

export interface AgentRunOverviewEntry {
  /** The card's id (its tool call): what "show me" scrolls to. */
  id: string
  agentName: string
  task: string
  background: boolean
  startedAt?: string
  stepCount: number
  /** The tool the agent is on (or was last on); absent before its first step. */
  currentStep?: string
  /** A Wrapper run started by `wrapper_run`, when visible from the agent step output/args. */
  wrapperRunId?: string
  /** What steer/stop address; null when the card does not know its run. */
  control: AgentRunControlTarget | null
}

/**
 * Identifies a run across agent sessions: `run_1` alone repeats in every session.
 * Used to remember that the worker no longer has a run.
 */
export function agentRunLostKey(target: AgentRunControlTarget): string {
  return `${target.agentSessionId}:${target.agentRunId}`
}

function isRunningCard(item: ChatItem): item is AgentExecutionItem {
  return item.role === 'agent_execution' && item.status === 'running'
}

function currentStepName(item: AgentExecutionItem): string | undefined {
  const running = item.steps.find((step) => step.status === 'running')
  return (running ?? item.steps.at(-1))?.toolName
}

const WRAPPER_RUN_ID_PATTERN = /\bwrun_[A-Za-z0-9_-]+\b/g

function lastWrapperRunIdInText(text: string): string | undefined {
  return [...text.matchAll(WRAPPER_RUN_ID_PATTERN)].at(-1)?.[0]
}

function latestWrapperRunId(item: AgentExecutionItem): string | undefined {
  for (let index = item.steps.length - 1; index >= 0; index--) {
    const step = item.steps[index]
    if (!step || !step.toolName.startsWith('wrapper_')) continue
    const found =
      lastWrapperRunIdInText(step.output) ??
      lastWrapperRunIdInText(step.argsJson) ??
      lastWrapperRunIdInText(step.argsPreview)
    if (found) return found
  }
  return undefined
}

export function runningAgentRuns(
  items: readonly ChatItem[],
  lost: ReadonlySet<string>
): AgentRunOverviewEntry[] {
  const entries: AgentRunOverviewEntry[] = []
  for (const item of items) {
    if (!isRunningCard(item)) continue
    const control = agentRunControlTarget(item)
    if (control && lost.has(agentRunLostKey(control))) continue
    const currentStep = currentStepName(item)
    const wrapperRunId = latestWrapperRunId(item)
    entries.push({
      id: item.id,
      agentName: item.agentName,
      task: item.task,
      background: item.background === true,
      ...(item.createdAt ? { startedAt: item.createdAt } : {}),
      stepCount: item.steps.length,
      ...(currentStep ? { currentStep } : {}),
      ...(wrapperRunId ? { wrapperRunId } : {}),
      control
    })
  }
  return entries
}

/** The render group that holds the item, or -1. Cards usually sit inside a folded processing group. */
export function groupIndexContainingItem(groups: readonly RenderGroup[], itemId: string): number {
  return groups.findIndex((group) =>
    group.kind === 'single'
      ? group.item.id === itemId
      : group.items.some((item) => item.id === itemId)
  )
}

const DEFAULT_SCROLL_MARGIN_PX = 16

/**
 * Where to scroll the chat so a row of the virtual list is in view. `offsets` are the rows'
 * tops within the list (as the virtual window computes them), `listTop` is where the list
 * starts inside the scroll container. An unknown row leaves the view where it is.
 */
export function virtualRowScrollTop(
  offsets: readonly number[],
  index: number,
  listTop: number,
  margin = DEFAULT_SCROLL_MARGIN_PX
): number {
  const rowTop = offsets[index]
  if (rowTop === undefined) return 0
  return Math.max(0, listTop + rowTop - margin)
}

/**
 * Where to scroll the chat so an element ends up in the middle of it (or at its top, when it is
 * taller than the chat). Computed by hand: `scrollIntoView` also scrolls every `overflow: hidden`
 * ancestor, and a folding panel that is still opening is one.
 */
export function centeredScrollTop(input: {
  scrollTop: number
  containerTop: number
  containerHeight: number
  elementTop: number
  elementHeight: number
}): number {
  const elementOffset = input.scrollTop + (input.elementTop - input.containerTop)
  if (input.elementHeight >= input.containerHeight) {
    return Math.max(0, elementOffset - DEFAULT_SCROLL_MARGIN_PX)
  }
  return Math.max(0, elementOffset - (input.containerHeight - input.elementHeight) / 2)
}

export function agentRunOverviewLabel(count: number): string {
  return `${count} 个 Agent 运行中`
}

export function formatAgentDuration(durationMs: number): string {
  const totalSeconds =
    durationMs > 0 && durationMs < 1000 ? 1 : Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours} 小时 ${minutes} 分钟 ${seconds} 秒`
  if (minutes > 0) return `${minutes} 分钟 ${seconds} 秒`
  return `${seconds} 秒`
}
