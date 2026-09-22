import type { AgentRunUsageRecord, AgentRunStatus, AgentTokenUsage } from './usage'

export interface ToolUsageSummary {
  name: string
  calls: number
  errors: number
  meanResultChars: number
  meanDurationMs: number
}

export interface AgentUsageSummary {
  agent: string
  runs: number
  statuses: Partial<Record<AgentRunStatus, number>>
  meanTurns: number
  meanToolCalls: number
  meanToolErrors: number
  /** Mean prompt size of the first model call: the fixed price of one delegation. */
  meanFirstTurnPromptTokens: number
  meanTokens: AgentTokenUsage
  meanDurationMs: number
  /** Ordered by the result text they put in front of the model, largest first. */
  tools: ToolUsageSummary[]
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
}

function summarizeAgent(agent: string, records: readonly AgentRunUsageRecord[]): AgentUsageSummary {
  const statuses: Partial<Record<AgentRunStatus, number>> = {}
  for (const record of records) statuses[record.status] = (statuses[record.status] ?? 0) + 1

  const byTool = new Map<string, AgentRunUsageRecord['tools']>()
  for (const tool of records.flatMap((record) => record.tools)) {
    byTool.set(tool.name, [...(byTool.get(tool.name) ?? []), tool])
  }
  const tools = [...byTool.entries()]
    .map(([name, calls]): ToolUsageSummary => ({
      name,
      calls: calls.length,
      errors: calls.filter((call) => call.isError).length,
      meanResultChars: mean(calls.map((call) => call.resultChars)),
      meanDurationMs: mean(
        calls.flatMap((call) => (call.durationMs === undefined ? [] : [call.durationMs]))
      )
    }))
    .sort((left, right) => right.meanResultChars * right.calls - left.meanResultChars * left.calls)

  const tokens = (pick: (usage: AgentTokenUsage) => number): number =>
    mean(records.map((record) => pick(record.usage)))
  return {
    agent,
    runs: records.length,
    statuses,
    meanTurns: mean(records.map((record) => record.turns)),
    meanToolCalls: mean(records.map((record) => record.toolCalls)),
    meanToolErrors: mean(records.map((record) => record.toolErrors)),
    meanFirstTurnPromptTokens: mean(
      records.flatMap((record) =>
        record.firstTurnPromptTokens === undefined ? [] : [record.firstTurnPromptTokens]
      )
    ),
    meanTokens: {
      input: tokens((usage) => usage.input),
      output: tokens((usage) => usage.output),
      cacheRead: tokens((usage) => usage.cacheRead),
      cacheWrite: tokens((usage) => usage.cacheWrite),
      reasoning: tokens((usage) => usage.reasoning),
      total: tokens((usage) => usage.total)
    },
    meanDurationMs: mean(records.map((record) => record.durationMs)),
    tools
  }
}

/** One summary per agent, agents in name order. */
export function summarizeUsage(records: readonly AgentRunUsageRecord[]): AgentUsageSummary[] {
  const byAgent = new Map<string, AgentRunUsageRecord[]>()
  for (const record of records)
    byAgent.set(record.agent, [...(byAgent.get(record.agent) ?? []), record])
  return [...byAgent.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([agent, group]) => summarizeAgent(agent, group))
}

const whole = (value: number): string => Math.round(value).toLocaleString('en-US')
const one = (value: number): string => value.toFixed(1)

export function formatUsageReport(summaries: readonly AgentUsageSummary[]): string {
  if (summaries.length === 0) return 'No agent runs recorded.'
  return summaries
    .map((item) => {
      const statuses = Object.entries(item.statuses)
        .map(([status, runs]) => `${status} ${runs}`)
        .join(', ')
      const lines = [
        `${item.agent}: ${item.runs} run(s) (${statuses})`,
        `  per run: ${whole(item.meanTokens.total)} tokens (new input ${whole(item.meanTokens.input)}, cache read ${whole(item.meanTokens.cacheRead)}, cache write ${whole(item.meanTokens.cacheWrite)}, output ${whole(item.meanTokens.output)}), ${one(item.meanTurns)} model calls, ${one(item.meanToolCalls)} tool calls (${one(item.meanToolErrors)} failed), ${whole(item.meanDurationMs / 1000)}s`,
        `  fixed cost: first turn prompt ${whole(item.meanFirstTurnPromptTokens)} tokens before any work`,
        '  tools (by result text returned):',
        ...item.tools.map(
          (tool) =>
            `    ${tool.name.padEnd(22)} ${String(tool.calls).padStart(4)} calls  ${String(tool.errors).padStart(3)} failed  ${whole(tool.meanResultChars).padStart(7)} chars/result`
        )
      ]
      return lines.join('\n')
    })
    .join('\n\n')
}
