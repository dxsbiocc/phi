export type AgentReportStatus = 'completed' | 'partial' | 'not_found' | 'blocked' | 'failed'

export interface AgentReport {
  status: AgentReportStatus
  text: string
  missingInputs: string[]
  nextAgent?: string
  fallbackReason?: string
  structured: boolean
}

const RESULT_PATTERN = /<phi_agent_result>\s*([\s\S]*?)\s*<\/phi_agent_result>/i
const STATUSES = new Set<AgentReportStatus>([
  'completed',
  'partial',
  'not_found',
  'blocked',
  'failed'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Reads optional machine metadata from an agent's final response. Plain prose
 * remains a completed report so installed/compat agents keep working.
 */
export function parseAgentReport(value: string): AgentReport {
  const raw = value.trim()
  const match = raw.match(RESULT_PATTERN)
  if (!match) {
    return { status: 'completed', text: raw, missingInputs: [], structured: false }
  }

  let metadata: unknown
  try {
    metadata = JSON.parse(match[1])
  } catch {
    return { status: 'completed', text: raw, missingInputs: [], structured: false }
  }
  if (!isRecord(metadata) || !STATUSES.has(metadata.status as AgentReportStatus)) {
    return { status: 'completed', text: raw, missingInputs: [], structured: false }
  }

  const body = raw.replace(match[0], '').trim()
  const summary = optionalString(metadata.summary)
  const nextAgent = optionalString(metadata.nextAgent)
  const fallbackReason = optionalString(metadata.fallbackReason)
  return {
    status: metadata.status as AgentReportStatus,
    text: body || summary || '',
    missingInputs: stringArray(metadata.missingInputs),
    ...(nextAgent ? { nextAgent } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    structured: true
  }
}

export const AGENT_REPORT_PROTOCOL = `<phi_agent_reporting>
End your final response with one machine-readable metadata block followed by the concise report for the main agent:
<phi_agent_result>{"status":"completed|partial|not_found|blocked|failed","missingInputs":[],"nextAgent":null,"fallbackReason":null}</phi_agent_result>

Use completed only when the delegated goal is complete. Use partial when useful work exists but the task should be delegated again with more context. Use not_found when valid queries exhausted the relevant specialist data sources without a matching record. Use blocked when the required capability/source is unavailable or not installed. Use failed when the attempted specialist operation failed. Put the human-readable report outside the metadata block. Do not wrap the JSON in a Markdown code fence.
</phi_agent_reporting>`
